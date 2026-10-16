import path from 'node:path';
import { mkdir, readFile, writeFile, chmod, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { createModelSettings } from './models.mjs';

export async function readReviewKey(file) {
  if (!file) return '';
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 100 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Review key must be a small private file owned by the service user.');
    const key = (await handle.readFile('utf8')).trim();
    if (!/^slice_ci_[a-f0-9]{64}$/.test(key)) throw new Error('Invalid review key.');
    return key;
  } finally { await handle.close(); }
}

export async function loadConfig(env = process.env) {
  if (env.HOST && env.HOST !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1; use an authenticated proxy or SSH tunnel.');
  const port = Number(env.PORT || 8932);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT.');
  const dataDir = path.resolve(env.APP_DATA_DIR || '.runtime');
  const workDir = path.join(dataDir, 'work');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const tokenFile = path.join(dataDir, 'gateway.key');
  try { await writeFile(tokenFile, 'sub_' + randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenFile, 0o600);
  const apiKey = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^sub_[a-f0-9]{64}$/.test(apiKey)) throw new Error('Invalid gateway.key; restore the original key or remove the file to generate a new one.');
  const origin = env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin) throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash or path.');
  return {
    port, dataDir, workDir, apiKey, origin, host: parsedOrigin.host,
    ownerEmail: env.LAUNCHER_OWNER_EMAIL || '',
    codexBin: env.CODEX_BIN || 'codex', claudeBin: env.CLAUDE_BIN || 'claude',
    claudeTokenFile: env.CLAUDE_OAUTH_TOKEN_FILE || '',
    chatgptModel: env.CHATGPT_MODEL || 'gpt-6.1-sol', claudeModel: env.CLAUDE_MODEL || 'sonnet',
    modelSettings: await createModelSettings(dataDir, { chatgpt: env.CHATGPT_MODEL || 'gpt-6.1-sol', claude: env.CLAUDE_MODEL || 'sonnet' }),
    timeoutMs: 90_000,
    reviewKey: await readReviewKey(env.CI_REVIEW_KEY_FILE),
  };
}
