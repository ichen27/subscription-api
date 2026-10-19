import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, stat, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadReviewStore, validateSkillFiles } from '../src/review-config.mjs';
const skill = { 'SKILL.md': '---\nname: inspect\ndescription: Review changed source\n---\nTrace callers before reporting findings.', 'references/guide.md': 'Read source.' };
const agent = { name: 'general', description: 'Review code', model: 'claude-opus-5-5', effort: 'high', instructions: 'Review independently.', skills: ['inspect'], timeLimitSeconds: 300, maxToolSteps: 40 };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await loadReviewStore(dir);
  await store.saveSkill('inspect', skill); await store.saveAgent(agent);
  return { dir, store };
}
test('project keys are one-time values, rotation revokes old keys, tokens never enter the public view', async t => {
  const {dir,store} = await fixture(t);
  const project = {name:'cuse', repository:'ichen27/cusesublets', allowedAgents:['general'], githubToken:'private-test-token'};
  const {key} = await store.saveProject(project);
  assert.match(key, /^review_[a-f0-9]{64}$/); assert.equal(store.authenticate(key).name, 'cuse');
  assert.equal(store.authenticate('slice_ci_'+'a'.repeat(64)), null);
  assert.doesNotMatch(JSON.stringify(store.view()), /keyHash|tokenId|private-test-token|review_[a-f0-9]{64}/);
  const onDisk = await readFile(path.join(dir,'review/config.json'),'utf8');
  assert.ok(!onDisk.includes(key)); assert.ok(!onDisk.includes(project.githubToken));
  assert.equal((await stat(path.join(dir,'review/secrets.json'))).mode & 0o777, 0o600);
  const rotated = await store.rotateKey('cuse'); assert.equal(store.authenticate(key), null); assert.ok(store.authenticate(rotated.key));
  const reopened = await loadReviewStore(dir); assert.ok(reopened.authenticate(rotated.key));
  assert.equal((await reopened.snapshot('cuse','general')).githubToken, project.githubToken);
  await reopened.saveProject({...project,repository:'ichen27/other',githubToken:undefined});
  assert.equal((await reopened.snapshot('cuse','general')).githubToken, undefined);
});
test('mutations serialize, reject unknown fields and references, and retain valid state after failure', async t => {
  const {store} = await fixture(t);
  await Promise.all(['one','two','three'].map(name=>store.saveProject({name,repository:'owner/repo',allowedAgents:['general']})));
  assert.equal(store.view().projects.length,3);
  const before = store.view();
  await assert.rejects(store.saveAgent({...agent, skills:['missing']}));
  await assert.rejects(store.saveAgent({...agent, tools:['Bash']}));
  await assert.rejects(store.saveAgent({...agent,timeLimitSeconds:601}));
  await assert.rejects(store.saveProject({name:'bad',repository:'../repo',allowedAgents:['general']}));
  assert.deepEqual(store.view(), before);
  await assert.rejects(store.deleteSkill('inspect'), e=>e.code==='skill_in_use');
  await assert.rejects(store.deleteAgent('general'), e=>e.code==='agent_in_use');
  await store.deleteProject('one'); assert.equal(store.view().projects.length,2);
});
test('snapshot pins agent settings and skill contents across subsequent updates', async t => {
  const {store} = await fixture(t);
  await store.saveProject({name:'one',repository:'owner/repo',allowedAgents:['general']});
  const snapshot = await store.snapshot('one','general');
  await store.saveSkill('inspect',{'SKILL.md':skill['SKILL.md']+'\nChanged'});
  await store.saveAgent({...agent,effort:'max'});
  assert.equal(snapshot.agent.effort,'high'); assert.deepEqual({...snapshot.skills[0].files},skill);
  assert.notEqual(snapshot.skills[0].digest,(await store.snapshot('one','general')).skills[0].digest);
  await store.saveAgent({...agent,name:'other'});
  await assert.rejects(store.snapshot('one','other'),e=>e.code==='agent_not_allowed');
});
test('malformed or nonprivate saved configuration disables the review store without throwing at load', async t => {
  const {dir,store} = await fixture(t);
  const file = path.join(dir,'review/config.json');
  await chmod(file,0o644);
  assert.throws((await loadReviewStore(dir)).ready,e=>e.code==='review_config_invalid');
  await chmod(file,0o600); await writeFile(file,'not json');
  const broken = await loadReviewStore(dir);
  assert.throws(broken.view,e=>e.code==='review_config_invalid');
  await assert.rejects(broken.saveAgent(agent),e=>e.code==='review_config_invalid');
  assert.equal(await readFile(file,'utf8'),'not json');
  assert.ok(store.view());
});
test('skill uploads reject binary, traversal, missing metadata and oversized content', () => {
  for (const files of [ {}, {'SKILL.md':'no metadata'}, {...skill,'../secret':'x'}, {...skill,'nested/../../bad':'x'}, {...skill,'bad':'\0'}, {...skill,'huge':'a'.repeat(1_000_001)}, {...skill,'/absolute':'x'} ]) assert.throws(()=>validateSkillFiles(files));
  assert.equal(validateSkillFiles(skill).name,'inspect');
});
test('skill symlink tampering is rejected on reload and cannot redirect a new upload', async t => {
  const {dir,store} = await fixture(t);
  const outside = path.join(dir,'outside'); await mkdir(outside);
  await symlink(outside,path.join(dir,'review/skills/evil'));
  await assert.rejects(store.saveSkill('evil',skill));
  const state=JSON.parse(await readFile(path.join(dir,'review/config.json'),'utf8'));
  const file=path.join(dir,'review/skills/inspect',state.skills[0].digest,'SKILL.md');
  await rm(file); await symlink(path.join(dir,'review/config.json'),file);
  assert.throws((await loadReviewStore(dir)).ready,e=>e.code==='review_config_invalid');
});
