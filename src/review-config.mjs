import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.mjs';
import { validateModelName } from './models.mjs';

const invalid = () => new ApiError(400, 'invalid_review_config', 'Invalid review configuration. Check names, references and limits.');
const unavailable = () => new ApiError(503, 'review_config_invalid', 'Review configuration is unavailable. Repair it on the service host.');
const id = value => { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) throw invalid(); return value; };
const text = (value, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw invalid();
  return value;
};
const object = (value, keys) => { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k))) throw invalid(); };
const unique = values => Array.isArray(values) && values.length <= 100 && new Set(values).size === values.length;
const hash = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ version: 1, revision: 0, skills: [], agents: [], projects: [] });
function agent(value) {
  object(value, ['name', 'description', 'model', 'effort', 'instructions', 'skills', 'timeLimitSeconds', 'maxToolSteps']);
  id(value.name); text(value.description, 1000, false); validateModelName(value.model); text(value.instructions, 20000, false);
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort) || !unique(value.skills)) throw invalid();
  value.skills.forEach(id);
  for (const [key, min, max] of [['timeLimitSeconds', 60, 600], ['maxToolSteps', 10, 100]])
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw invalid();
}
function repository(value) {
  if (typeof value !== 'string' || value.length > 201 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || /\/(\.|\.\.)$/.test(value)) throw invalid();
}
function validate(state, secrets) {
  object(state, ['version', 'revision', 'skills', 'agents', 'projects']);
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) throw invalid();
  if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') throw invalid();
  for (const [key, token] of Object.entries(secrets)) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw invalid();
    text(token, 500); if (/\s/.test(token)) throw invalid();
  }
  for (const [key, field] of [['skills', 'id'], ['agents', 'name'], ['projects', 'name']]) {
    if (!Array.isArray(state[key]) || state[key].length > 100 || !unique(state[key].map(x => x?.[field]))) throw invalid();
  }
  for (const skill of state.skills) {
    object(skill, ['id', 'name', 'description', 'updatedAt', 'digest', 'files']);
    id(skill.id); text(skill.name, 100); text(skill.description, 2000); text(skill.updatedAt, 40);
    if (!/^[a-f0-9]{64}$/.test(skill.digest) || !unique(skill.files) || !skill.files.includes('SKILL.md')) throw invalid();
    skill.files.forEach(skillPath);
  }
  for (const item of state.agents) {
    agent(item);
    if (item.skills.some(name => !state.skills.some(s => s.id === name))) throw invalid();
  }
  for (const project of state.projects) {
    object(project, ['name', 'repository', 'keyHash', 'allowedAgents', 'tokenId']);
    id(project.name); repository(project.repository);
    if (!/^sha256:[a-f0-9]{64}$/.test(project.keyHash) || !unique(project.allowedAgents) || project.allowedAgents.some(name => !state.agents.some(a => a.name === name))) throw invalid();
    if (project.tokenId !== null && (!/^[a-f0-9]{32}$/.test(project.tokenId) || !Object.hasOwn(secrets, project.tokenId))) throw invalid();
  }
}
export function skillPath(value) {
  if (typeof value !== 'string' || value.length > 240 || !value || value.startsWith('/') || /[\\\x00-\x1f:]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw invalid();
  return value;
}
export function validateSkillFiles(files) {
  if (!files || Array.isArray(files) || typeof files !== 'object' || Object.keys(files).length > 100) throw invalid();
  let bytes = 0;
  for (const [name, content] of Object.entries(files)) { skillPath(name); text(content, 1_000_000, false); bytes += Buffer.byteLength(content); }
  if (bytes > 1_000_000 || typeof files['SKILL.md'] !== 'string') throw invalid();
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(files['SKILL.md']);
  if (!front) throw invalid();
  // Deliberately accept a small standard frontmatter subset, never evaluate YAML.
  const field = key => {
    const match = new RegExp('^' + key + ':\\s*([^\\r\\n]+)$', 'm').exec(front[1]);
    if (!match || /^[>|&*!{[]/.test(match[1])) throw invalid();
    return match[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  };
  const name = text(field('name'), 100), description = text(field('description'), 2000);
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return { name, description, digest: hash(JSON.stringify(sorted)), files: sorted };
}
async function privateJson(file, fallback) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2_000_000 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw invalid();
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  finally { await handle?.close(); }
}
async function atomic(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
async function directories(root, relative, create = false) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  }
  return current;
}
async function skillContents(root, skill) {
  await directories(root, `skills/${skill.id}/${skill.digest}`);
  const files = Object.create(null);
  for (const name of skill.files) {
    let current = path.join(root, 'skills', skill.id, skill.digest);
    for (const part of name.split('/')) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) throw invalid(); }
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1_000_000) throw invalid();
      files[name] = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
    } finally { await handle.close(); }
  }
  const validated = validateSkillFiles(files);
  if (validated.digest !== skill.digest) throw invalid();
  return files;
}

export async function loadReviewStore(dataDir) {
  const root = path.join(dataDir, 'review');
  let state, secrets, broken = false;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw invalid();
    state = await privateJson(path.join(root, 'config.json'), empty());
    secrets = await privateJson(path.join(root, 'secrets.json'), {});
    validate(state, secrets);
    for (const skill of state.skills) await skillContents(root, skill);
  } catch { broken = true; }
  const ready = () => { if (broken) throw unavailable(); };
  let pending = Promise.resolve();
  const mutate = operation => {
    const next = pending.then(async () => {
      ready(); const draft = structuredClone(state), tokens = structuredClone(secrets);
      const result = await operation(draft, tokens);
      draft.revision++; validate(draft, tokens);
      // Immutable token versions are written first; the atomic config rename is
      // the commit point. A crash can leave an unreferenced token, never a dangling ref.
      const referenced = new Set([...state.projects, ...draft.projects].map(p => p.tokenId));
      for (const key of Object.keys(tokens)) if (!referenced.has(key)) delete tokens[key];
      await atomic(path.join(root, 'secrets.json'), tokens);
      await atomic(path.join(root, 'config.json'), draft);
      state = draft; secrets = tokens;
      return result;
    });
    pending = next.catch(() => {}); return next;
  };
  return {
    ready,
    view() {
      ready(); return { version: 1, revision: state.revision, skills: state.skills.map(({ digest, files, ...s }) => s), agents: structuredClone(state.agents),
        projects: state.projects.map(({ keyHash, tokenId, ...p }) => ({ ...structuredClone(p), hasGitHubToken: Boolean(tokenId) })) };
    },
    authenticate(key) {
      ready(); if (typeof key !== 'string' || !/^review_[a-f0-9]{64}$/.test(key)) return null;
      const digest = Buffer.from(hash(key), 'hex');
      const project = state.projects.find(p => timingSafeEqual(digest, Buffer.from(p.keyHash.slice(7), 'hex')));
      return project ? structuredClone(project) : null;
    },
    saveAgent(value) {
      return mutate(draft => { agent(value); const at = draft.agents.findIndex(a => a.name === value.name); if (at < 0) draft.agents.push(structuredClone(value)); else draft.agents[at] = structuredClone(value); });
    },
    deleteAgent(name) {
      return mutate(draft => { id(name); if (draft.projects.some(p => p.allowedAgents.includes(name))) throw new ApiError(409, 'agent_in_use', 'Remove the agent from projects first.'); draft.agents = draft.agents.filter(a => a.name !== name); });
    },
    saveProject(value) {
      return mutate((draft, tokens) => {
        object(value, ['name', 'repository', 'allowedAgents', 'githubToken']); id(value.name); repository(value.repository);
        const at = draft.projects.findIndex(p => p.name === value.name), previous = draft.projects[at];
        const key = previous ? undefined : 'review_' + randomBytes(32).toString('hex');
        let tokenId = previous?.repository === value.repository ? previous.tokenId : null;
        if (value.githubToken !== undefined) {
          if (value.githubToken === '') tokenId = null;
          else { text(value.githubToken, 500); if (/\s/.test(value.githubToken)) throw invalid(); tokenId = randomBytes(16).toString('hex'); tokens[tokenId] = value.githubToken; }
        }
        const project = { name: value.name, repository: value.repository, allowedAgents: structuredClone(value.allowedAgents), keyHash: previous?.keyHash || 'sha256:' + hash(key), tokenId };
        if (previous) draft.projects[at] = project; else draft.projects.push(project);
        return key ? { key } : {};
      });
    },
    rotateKey(name) {
      return mutate(draft => { id(name); const p = draft.projects.find(p => p.name === name); if (!p) throw new ApiError(404, 'project_not_found', 'Project not found.'); const key = 'review_' + randomBytes(32).toString('hex'); p.keyHash = 'sha256:' + hash(key); return { key }; });
    },
    deleteProject(name) { return mutate(draft => { id(name); draft.projects = draft.projects.filter(p => p.name !== name); }); },
    saveSkill(skillId, files) {
      return mutate(async draft => {
        id(skillId); const checked = validateSkillFiles(files);
        const dir = path.join(root, 'skills', skillId, checked.digest);
        await directories(root, `skills/${skillId}/${checked.digest}`, true);
        for (const [name, content] of Object.entries(checked.files)) {
          const file = path.join(dir, name);
          if (name.includes('/')) await directories(dir, name.slice(0, name.lastIndexOf('/')), true);
          try { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(content); } finally { await handle.close(); } }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        const skill = { id: skillId, name: checked.name, description: checked.description, updatedAt: new Date().toISOString(), digest: checked.digest, files: Object.keys(checked.files) };
        await skillContents(root, skill);
        const at = draft.skills.findIndex(s => s.id === skillId); if (at < 0) draft.skills.push(skill); else draft.skills[at] = skill;
      });
    },
    deleteSkill(skillId) {
      return mutate(draft => { id(skillId); if (draft.agents.some(a => a.skills.includes(skillId))) throw new ApiError(409, 'skill_in_use', 'Remove the skill from agents first.'); draft.skills = draft.skills.filter(s => s.id !== skillId); });
    },
    async snapshot(projectName, agentName) {
      ready(); const current = structuredClone(state);
      const project = current.projects.find(p => p.name === projectName);
      const selected = current.agents.find(a => a.name === agentName);
      if (!project) throw new ApiError(401, 'unauthorized', 'A project review credential is required.');
      if (!selected) throw new ApiError(404, 'unknown_agent', 'Review agent not found.');
      if (!project.allowedAgents.includes(agentName)) throw new ApiError(403, 'agent_not_allowed', 'This project cannot use that agent.');
      const githubToken = project.tokenId ? secrets[project.tokenId] : undefined;
      const skills = await Promise.all(selected.skills.map(async name => { const s = current.skills.find(s => s.id === name); return { id: s.id, digest: s.digest, files: await skillContents(root, s) }; }));
      return { revision: current.revision, agent: selected, repository: project.repository, project: project.name, githubToken, skills };
    },
  };
}
