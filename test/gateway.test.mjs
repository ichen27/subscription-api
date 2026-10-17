import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createProviders, validateRequest, providerCommand, providerEnvironment, parseProviderResult } from '../src/providers.mjs';
import { runProcess, subscriptionEnvironment } from '../src/process.mjs';
import { ApiError } from '../src/errors.mjs';
import { createModelSettings, resolveModel, defaultModels } from '../src/models.mjs';

const payload = { model: 'chatgpt', messages: [{ role: 'user', content: 'Hello' }] };
const key = 'sub_' + 'a'.repeat(64);
const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };

// Node fetch replaces Host; use the HTTP client to exercise the real proxy contract.
function proxyRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      let text = '';
      res.setEncoding('utf8').on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: name => res.headers[name] }, json: async () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

async function fixture(t, overrides = {}) {
  const calls = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...await loadConfig({ APP_DATA_DIR: directory, CHATGPT_MODEL: 'test' }), apiKey: key, origin: 'https://example.test', host: 'example.test', ownerEmail: 'owner@example.test' };
  const providers = { status: async () => [{ id: 'chatgpt', connected: true }], complete: async body => { calls.push(body); return 'Hello back'; }, ...overrides };
  const server = createServer(config, providers);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.stop(); server.closeAllConnections(); });
  return { server, url, calls, config };
}

test('API routes require the gateway key, including through the launcher', async t => {
  const { url, calls } = await fixture(t);
  for (const extra of [{}, { authorization: 'Bearer bad' }, { host: 'example.test', 'x-forwarded-host': 'example.test', 'x-forwarded-proto': 'https', 'cf-access-authenticated-user-email': 'owner@example.test' }]) {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(payload) });
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
});

test('authenticated model catalog and both provider routes use OpenAI response shape', async t => {
  const { url, calls } = await fixture(t);
  const catalog = await (await fetch(url + '/v1/models', { headers })).json();
  const modelIds = catalog.data.map(model => model.id);
  for (const id of ['chatgpt', 'claude', 'chatgpt/gpt-6.1-sol', 'claude/opus']) assert.ok(modelIds.includes(id));
  for (const model of ['chatgpt', 'claude', 'chatgpt/gpt-6-luna', 'claude/claude-opus-4-8']) {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...payload, model }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, model);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Hello back');
    assert.equal(body.choices[0].finish_reason, 'stop');
  }
  assert.deepEqual(calls.map(call => call.model), ['chatgpt', 'claude', 'chatgpt/gpt-6-luna', 'claude/claude-opus-4-8']);
});

test('rejects malformed and unsupported requests before any provider execution', async t => {
  const { url, calls } = await fixture(t);
  for (const body of ['bad JSON', JSON.stringify({ ...payload, tools: [] }), JSON.stringify({ ...payload, stream: 'true' }), JSON.stringify({ ...payload, model: 'unknown' }), JSON.stringify({ ...payload, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })]) {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body });
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);
});

test('oversized HTTP bodies get an explicit 413 without reaching the provider', async t => {
  const { url, calls } = await fixture(t);
  const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...payload, messages: [{ role: 'user', content: 'x'.repeat(300_000) }] }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'body_too_large');
  assert.equal(calls.length, 0);
});

test('owner dashboard validates trusted forwarding and exact origin before key disclosure', async t => {
  const { url } = await fixture(t);
  const owner = { host: 'example.test', 'x-forwarded-host': 'example.test', 'x-forwarded-proto': 'https', 'cf-access-authenticated-user-email': 'owner@example.test', 'content-type': 'application/json' };
  assert.equal((await proxyRequest(url + '/api/status', { headers: { ...owner, 'x-forwarded-host': 'evil.test' } })).status, 401);
  assert.equal((await proxyRequest(url + '/api/status', { headers: { ...owner, 'cf-access-authenticated-user-email': 'other@example.test' } })).status, 401);
  assert.equal((await proxyRequest(url + '/api/status', { headers: owner })).status, 200);
  for (const origin of [undefined, 'https://evil.test']) {
    const response = await proxyRequest(url + '/api/key', { method: 'POST', headers: { ...owner, ...(origin ? { origin } : {}) }, body: '{}' });
    assert.equal(response.status, 403);
  }
  const response = await proxyRequest(url + '/api/key', { method: 'POST', headers: { ...owner, origin: 'https://example.test' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).key, key);
});

test('cross-origin API calls are rejected even with a valid key', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(url + '/v1/models', { headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
});

test('SSE includes final content, finish reason, and DONE', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...payload, stream: true }) });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  assert.equal(JSON.parse(events[0]).choices[0].delta.content, 'Hello back');
  assert.equal(JSON.parse(events[1]).choices[0].finish_reason, 'stop');
  assert.equal(events[2], '[DONE]');
});

test('provider errors remain errors in JSON and SSE; internal details are redacted', async t => {
  const { url } = await fixture(t, { complete: async () => { throw new Error('PRIVATE_TOKEN_AND_PATH'); } });
  for (const stream of [false, true]) {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...payload, stream }) });
    assert.equal(response.status, stream ? 200 : 500);
    const content = await response.text();
    assert.match(content, /internal_error/);
    assert.doesNotMatch(content, /PRIVATE_TOKEN_AND_PATH/);
  }
});

test('client cancellation aborts the upstream request', async t => {
  let upstreamAborted;
  const aborted = new Promise(resolve => { upstreamAborted = resolve; });
  const { url } = await fixture(t, { complete: (_body, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { upstreamAborted(); reject(new ApiError(499, 'cancelled', 'Cancelled')); }, { once: true });
  }) });
  const controller = new AbortController();
  const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ ...payload, stream: true }) });
  assert.equal(response.status, 200);
  controller.abort();
  await Promise.race([aborted, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Upstream did not abort')), 1000); timer.unref(); })]);
});

test('API-key variables and arbitrary provider URLs cannot leak into subprocesses', () => {
  const env = subscriptionEnvironment({ HOME: '/tmp/example', PATH: '/usr/bin', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://evil.test', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CODEX_HOME: '/custom', NODE_OPTIONS: '--require evil' });
  assert.deepEqual(env, { HOME: '/tmp/example', PATH: '/usr/bin' });
});

test('CLI adapters force subscription paths and disable inherited tools/config', () => {
  const config = { codexBin: 'codex', claudeBin: 'claude', chatgptModel: 'test', claudeModel: 'sonnet' };
  const codex = providerCommand('chatgpt', config).args;
  assert.ok(codex.includes('forced_login_method="chatgpt"'));
  assert.ok(codex.includes('--ignore-user-config'));
  assert.ok(codex.includes('shell_tool'));
  assert.ok(codex.includes('read-only'));
  const claude = providerCommand('claude', config).args;
  assert.ok(claude.includes('--safe-mode'));
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--restricted'));
});

test('explicit automation OAuth token is private, Claude-only, and never falls back on failure', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credential');
  const token = 'sk-ant-oat01-' + 'x'.repeat(64);
  await writeFile(file, token, { mode: 0o600 });
  assert.equal((await providerEnvironment('claude', { claudeTokenFile: file })).CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.equal((await providerEnvironment('chatgpt', { claudeTokenFile: file })).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  await chmod(file, 0o644);
  await assert.rejects(providerEnvironment('claude', { claudeTokenFile: file }), error => error.code === 'automation_login_required');
  await chmod(file, 0o600);
  await writeFile(file, 'sk-ant-api-this-is-not-a-subscription-token');
  await assert.rejects(providerEnvironment('claude', { claudeTokenFile: file }), error => error.code === 'automation_login_required');
});

test('provider parsers require successful terminal events and redact failures', () => {
  assert.equal(parseProviderResult('chatgpt', { code: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n{"type":"turn.completed"}', stderr: '' }), 'ok');
  assert.equal(parseProviderResult('claude', { code: 0, stdout: '{"type":"result","subtype":"success","result":"ok"}', stderr: '' }), 'ok');
  for (const provider of ['chatgpt', 'claude']) {
    assert.throws(() => parseProviderResult(provider, { code: 1, stdout: '', stderr: 'private: rate limit reached' }), error => error.status === 429 && !error.message.includes('private'));
    assert.throws(() => parseProviderResult(provider, { code: 0, stdout: '{}', stderr: 'private secret' }), error => error.status === 502 && !error.message.includes('private'));
  }
});

test('message limits and final user requirement are enforced', () => {
  assert.throws(() => validateRequest({ ...payload, messages: [{ role: 'assistant', content: 'hi' }] }), /End the conversation/);
  assert.throws(() => validateRequest({ ...payload, messages: [{ role: 'user', content: 'x'.repeat(100_001) }] }), error => error.status === 413);
  assert.throws(() => validateRequest({ ...payload, max_tokens: 20 }), error => error.code === 'unsupported_parameter');
});

test('keys persist across restart with private permissions and public bind is rejected', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await loadConfig({ APP_DATA_DIR: directory });
  const second = await loadConfig({ APP_DATA_DIR: directory });
  assert.equal(first.apiKey, second.apiKey);
  assert.equal((await readFile(path.join(directory, 'gateway.key'), 'utf8')).trim(), first.apiKey);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'gateway.key'))).mode & 0o777, 0o600);
  await assert.rejects(loadConfig({ APP_DATA_DIR: directory, HOST: '0.0.0.0' }), /HOST must/);
});

test('provider sign-in check refuses API-key authentication before execution', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let executionCount = 0;
  const provider = createProviders({ codexBin: 'codex', claudeBin: 'claude', workDir: directory }, async (command, args) => {
    if (args[0] === 'exec') executionCount++;
    return command === 'codex' ? { code: 0, stdout: '', stderr: 'Logged in using an API key' } : { code: 0, stdout: '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}', stderr: '' };
  });
  for (const model of ['chatgpt', 'claude']) await assert.rejects(provider.complete({ ...payload, model }), error => error.code === 'sign_in_required');
  assert.equal(executionCount, 0);
});

test('one in-flight request per provider; busy state clears after completion', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-busy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release, entered;
  const running = new Promise(resolve => { entered = resolve; });
  const provider = createProviders({ codexBin: 'codex', claudeBin: 'claude', workDir: directory }, async (command, args) => {
    if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    if (args[0] === 'auth') return { code: 0, stdout: '{"loggedIn":false}', stderr: '' };
    entered();
    await new Promise(resolve => { release = resolve; });
    return { code: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed"}', stderr: '' };
  });
  const first = provider.complete(payload);
  await running;
  await assert.rejects(provider.complete(payload), error => error.code === 'provider_busy');
  await assert.rejects(provider.complete({ ...payload, model: 'chatgpt/gpt-6-luna' }), error => error.code === 'provider_busy');
  release();
  assert.equal(await first, 'done');
});

test('model defaults persist atomically, serialize saves, and invalid names cannot change them', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = await createModelSettings(directory, { chatgpt: 'gpt-6.1-sol', claude: 'sonnet' });
  await Promise.all([settings.save('chatgpt', 'gpt-6-luna'), settings.save('claude', 'opus')]);
  assert.deepEqual(settings.defaults(), { chatgpt: 'gpt-6-luna', claude: 'opus' });
  const restarted = await createModelSettings(directory, { chatgpt: 'old', claude: 'old' });
  assert.deepEqual(restarted.defaults(), settings.defaults());
  assert.equal((await stat(path.join(directory, 'models.json'))).mode & 0o777, 0o600);
  for (const model of ['', '--help', '../auth', 'id\n--tools', 'id;evil', 'id/other', 'x'.repeat(101), 10]) {
    assert.throws(() => settings.save('claude', model), error => error.code === 'invalid_model');
  }
  assert.throws(() => settings.save('__proto__', 'model'), error => error.code === 'unknown_provider');
  const copy = settings.defaults(); copy.claude = 'changed';
  assert.equal(settings.defaults().claude, 'opus');
  await rm(directory, { recursive: true, force: true });
  await assert.rejects(settings.save('claude', 'haiku'));
  assert.equal(settings.defaults().claude, 'opus');
});

test('default mutation requires authentication and same origin, validates body, and updates catalog', async t => {
  const { url, config } = await fixture(t);
  const endpoint = url + '/api/models/default';
  const body = JSON.stringify({ provider: 'claude', model: 'claude-opus-4-8' });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin: config.origin }, body })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body })).status, 403);
  const authorized = { ...headers, origin: config.origin };
  for (const invalid of [null, [], {}, { provider: 'unknown', model: 'test' }, { provider: 'claude', model: '--help' }, { provider: 'claude', model: 'opus', extra: true }]) {
    assert.equal((await fetch(endpoint, { method: 'POST', headers: authorized, body: JSON.stringify(invalid) })).status, 400);
  }
  assert.equal((await fetch(endpoint, { method: 'POST', headers: authorized, body })).status, 200);
  assert.equal(defaultModels(config).claude, 'claude-opus-4-8');
  const catalog = await (await fetch(url + '/v1/models', { headers })).json();
  assert.ok(catalog.data.some(model => model.id === 'claude/claude-opus-4-8'));
  const status = await (await fetch(url + '/api/status', { headers })).json();
  assert.equal(status.upstreamModels.claude, 'claude-opus-4-8');
});

test('qualified models route to the correct provider CLI and do not change defaults', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ APP_DATA_DIR: directory });
  const executed = [];
  const providers = createProviders(config, async (command, args) => {
    if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    if (args[0] === 'auth') return { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', stderr: '' };
    executed.push([command, args[args.indexOf('--model') + 1]]);
    return { code: 0, stderr: '', stdout: command === 'codex'
      ? '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n{"type":"turn.completed"}'
      : '{"type":"result","subtype":"success","result":"ok"}' };
  });
  for (const model of ['chatgpt/gpt-6-luna', 'claude/claude-opus-4-8', 'chatgpt', 'claude']) {
    assert.equal(await providers.complete(validateRequest({ ...payload, model })), 'ok');
  }
  assert.deepEqual(executed, [['codex', 'gpt-6-luna'], ['claude', 'claude-opus-4-8'], ['codex', 'gpt-6.1-sol'], ['claude', 'sonnet']]);
  await config.modelSettings.save('claude', 'haiku');
  assert.deepEqual(resolveModel('claude', config), { provider: 'claude', model: 'haiku' });
  assert.deepEqual(resolveModel('claude/opus[1m]', config), { provider: 'claude', model: 'opus[1m]' });
  for (const model of ['claude/', 'unknown/opus', 'claude/--help', 'chatgpt/test\n', 'chatgpt/a/b']) assert.throws(() => validateRequest({ ...payload, model }));
});

test('provider calls use the configured timeout unless a route sets its own', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subscription-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig({ APP_DATA_DIR: directory });
  const timeouts = [];
  const providers = createProviders(config, async (command, args, options) => {
    if (args[0] === 'auth') return { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    timeouts.push(options.timeoutMs);
    return { code: 0, stderr: '', stdout: '{"type":"result","subtype":"success","result":"ok"}' };
  });
  const body = validateRequest({ ...payload, model: 'claude' });
  await providers.complete(body);
  await providers.complete(body, { timeoutMs: 300_000 });
  assert.deepEqual(timeouts, [90_000, 300_000]);
});

test('process runner sends stdin literally, bounds output, and terminates timeouts', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: '$(do-not-execute)\nhello' });
  assert.equal(result.stdout, '$(do-not-execute)\nhello');
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 60 }), error => error.code === 'provider_timeout');
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBytes: 100 }), error => error.code === 'provider_output_limit');
  await assert.rejects(runProcess('/definitely/not/installed', []), error => error.code === 'cli_unavailable');
});

test('dedicated CI key allows only fixed-model review and never personal API access', async t => {
  const seen = [];
  const { url, config } = await fixture(t, { complete: async (body, options) => { seen.push({ body, options }); return '{"status":"completed","findings":[]}'; } });
  const ciKey = 'slice_ci_' + 'b'.repeat(64);
  const ciHeaders = { 'content-type': 'application/json', authorization: 'Bearer ' + ciKey };
  const body = { ...payload, model: 'claude/claude-opus-5-5' };
  assert.equal((await fetch(url + '/ci/slice/review', { method: 'POST', headers: ciHeaders, body: JSON.stringify(body) })).status, 404);
  config.reviewKey = ciKey;
  assert.equal((await fetch(url + '/ci/slice/review', { method: 'POST', headers, body: JSON.stringify(body) })).status, 401);
  for (const path of ['/v1/models', '/v1/chat/completions', '/api/key', '/api/models/default']) {
    assert.equal((await fetch(url + path, { method: 'POST', headers: ciHeaders, body: '{}' })).status, 401);
  }
  for (const bad of [{ ...body, model: 'claude/opus' }, { ...body, model: 'chatgpt/gpt-6-astra' }, { ...body, stream: true }, { ...body, tools: [] }]) {
    assert.equal((await fetch(url + '/ci/slice/review', { method: 'POST', headers: ciHeaders, body: JSON.stringify(bad) })).status, 400);
  }
  assert.equal((await fetch(url + '/ci/slice/review', { method: 'POST', headers: { ...ciHeaders, origin: 'https://example.test' }, body: JSON.stringify(body) })).status, 403);
  assert.equal(seen.length, 0);
  const result = await fetch(url + '/ci/slice/review', { method: 'POST', headers: ciHeaders, body: JSON.stringify(body) });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).model, body.model);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.reasoningEffort, 'high');
  assert.equal(seen[0].options.timeoutMs, 300_000);
  const args = providerCommand('claude', {}, 'claude-opus-5-5', 'high').args;
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).switchModelsOnFlag, false);
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--restricted'));
  assert.ok(!args.includes('--fallback-model'));
});

test('review credential must be private, bounded and not a symlink', async t => {
  const { readReviewKey } = await import('../src/config.mjs');
  const { symlink } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'slice-review-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'key');
  const value = 'slice_ci_' + 'b'.repeat(64);
  await writeFile(file, value, { mode: 0o600 });
  assert.equal(await readReviewKey(file), value);
  await symlink(file, path.join(dir, 'link'));
  await assert.rejects(() => readReviewKey(path.join(dir, 'link')));
  await chmod(file, 0o644);
  await assert.rejects(() => readReviewKey(file));
  await chmod(file, 0o600);
  await writeFile(file, 'x'.repeat(101));
  await assert.rejects(() => readReviewKey(file));
});


test('only the authenticated review route accepts the bounded larger conversation', async t => {
  const { url, config, calls } = await fixture(t);
  config.reviewKey = 'slice_ci_' + 'b'.repeat(64);
  const reviewHeaders = { ...headers, authorization: 'Bearer ' + config.reviewKey };
  const body = length => JSON.stringify({ model: 'claude/claude-opus-5-5', messages: [{ role: 'user', content: 'x'.repeat(length) }] });
  assert.equal((await fetch(url + '/ci/slice/review', { method: 'POST', headers: reviewHeaders, body: body(390_000) })).status, 200);
  assert.equal((await fetch(url + '/ci/slice/review', { method: 'POST', headers: reviewHeaders, body: body(400_001) })).status, 413);
  const oversized = await fetch(url + '/ci/slice/review', { method: 'POST', headers: reviewHeaders, body: body(640_001) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'body_too_large');
  assert.equal((await fetch(url + '/ci/slice/review', { method: 'POST', headers, body: body(180_000) })).status, 401);
  assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: body(100_001) })).status, 413);
  assert.equal(calls.length, 1);
});
