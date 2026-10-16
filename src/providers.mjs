import { mkdtemp, rm, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { runProcess, subscriptionEnvironment } from './process.mjs';
import { ApiError } from './errors.mjs';
import { providerIds, defaultModels, resolveModel } from './models.mjs';

export async function providerEnvironment(provider, config) {
  const env = subscriptionEnvironment();
  if (provider === 'claude' && config.claudeTokenFile) {
    try {
      const details = await lstat(config.claudeTokenFile);
      if (!details.isFile() || (details.mode & 0o077) !== 0 || (process.getuid && details.uid !== process.getuid())) throw new Error('Private file required');
      const token = (await readFile(config.claudeTokenFile, 'utf8')).trim();
      if (!/^sk-ant-oat01-[A-Za-z0-9_-]{50,}$/.test(token)) throw new Error('Invalid OAuth token');
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } catch {
      throw new ApiError(503, 'automation_login_required', 'The configured Claude automation credential is unavailable. Renew it on the service host.');
    }
  }
  return env;
}

const codexDisabledFeatures = [
  'shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'computer_use',
  'browser_use', 'browser_use_external', 'in_app_browser', 'apps', 'plugins',
  'remote_plugin', 'image_generation', 'multi_agent', 'multi_agent_v2', 'hooks',
  'skill_search', 'memories', 'goals', 'sleep_tool', 'view_image', 'workspace_dependencies',
  'worktrees', 'tool_suggest', 'auth_elicitation', 'daemon_auto_start', 'request_permissions_tool',
];

export function providerCommand(provider, config, model = defaultModels(config)[provider], reasoningEffort) {
  if (provider === 'chatgpt') return {
    command: config.codexBin,
    args: ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--json', '--color', 'never', '--model', model,
      ...(reasoningEffort === 'high' ? ['-c', 'model_reasoning_effort="high"'] : []),
      ...codexDisabledFeatures.flatMap(feature => ['--disable', feature]),
      '--enable', 'skip_host_skill_discovery',
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
      '-c', 'approval_policy="never"', '-c', 'history.persistence="none"',
      '-c', 'hide_agent_reasoning=true', '-'],
  };
  return {
    command: config.claudeBin,
    args: ['--print', '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config',
      '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--output-format', 'json', '--model', model,
      '--system-prompt', 'You are a helpful text assistant. Respond to the supplied conversation. You have no tools.'],
  };
}

export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'Send a JSON object.');
  const unsupported = Object.keys(body).filter(key => !['model', 'messages', 'stream'].includes(key));
  if (unsupported.length) throw new ApiError(400, 'unsupported_parameter', 'Supported fields are model, messages, and stream. Tool calls, sampling controls, and token limits are not supported.');
  resolveModel(body.model, {});
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new ApiError(400, 'invalid_stream', 'stream must be a boolean.');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) throw new ApiError(400, 'invalid_messages', 'Provide between 1 and 100 text messages.');
  let total = 0;
  for (const message of body.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string'
      || Object.keys(message).some(key => !['role', 'content'].includes(key))) {
      throw new ApiError(400, 'invalid_messages', 'Each message must contain only role and text content. Images and tool messages are not supported.');
    }
    total += message.content.length;
  }
  if (total > 100_000) throw new ApiError(413, 'prompt_too_large', 'Keep the conversation under 100,000 characters.');
  if (body.messages.at(-1).role !== 'user' || !body.messages.at(-1).content.trim()) throw new ApiError(400, 'invalid_messages', 'End the conversation with a nonempty user message.');
  return body;
}

export function conversationPrompt(messages) {
  return 'Answer the final user message in this JSON conversation. Earlier entries provide context. Return only the assistant reply, not a JSON wrapper.\n\n' + JSON.stringify(messages);
}

export function parseProviderResult(provider, result) {
  let text;
  let failed = result.code !== 0;
  try {
    if (provider === 'claude') {
      const data = JSON.parse(result.stdout);
      failed ||= data.is_error === true || data.type !== 'result' || data.subtype !== 'success';
      text = data.result;
    } else {
      const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      failed ||= events.some(event => ['error', 'turn.failed'].includes(event.type));
      failed ||= !events.some(event => event.type === 'turn.completed');
      text = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item.text).join('\n');
    }
  } catch { failed = true; }
  if (failed || typeof text !== 'string' || !text.trim()) {
    // Provider output is never returned verbatim on failure: it can contain credentials or local paths.
    const diagnostic = result.stderr + result.stdout;
    if (/rate.?limit|usage.?limit|quota|limit reached|exceeded.*limit/i.test(diagnostic)) throw new ApiError(429, 'subscription_limit', 'This provider has reached a usage limit. Wait for its reset or choose the other provider.');
    if (/not logged|not authenticated|login required|authentication.*fail|token.*expired|invalid.*token|unauthorized|please.*log.?in/i.test(diagnostic)) throw new ApiError(503, 'sign_in_required', 'Sign in to this provider on the Mac mini, then refresh connection status.');
    throw new ApiError(502, 'provider_failed', 'The provider could not complete the request. Check its sign-in and model access, or try again.');
  }
  return text;
}

export function createProviders(config, run = runProcess) {
  const active = new Set();
  let statusCache, statusAt = 0, statusPending;
  async function inspect(provider) {
    try {
      const result = await run(provider === 'chatgpt' ? config.codexBin : config.claudeBin,
        provider === 'chatgpt' ? ['login', 'status'] : ['auth', 'status'],
        { cwd: config.workDir, env: await providerEnvironment(provider, config), timeoutMs: 10_000, maxBytes: 64_000 });
      let connected;
      if (provider === 'chatgpt') connected = result.code === 0 && /Logged in using ChatGPT/i.test(result.stdout + result.stderr);
      else {
        const value = JSON.parse(result.stdout);
        connected = result.code === 0 && value.loggedIn === true && /claude.?ai|oauth/i.test(value.authMethod || '') && value.apiProvider === 'firstParty';
      }
      return { id: provider, connected, state: connected ? 'connected' : 'sign_in_required' };
    } catch { return { id: provider, connected: false, state: 'unavailable' }; }
  }
  async function status() {
    if (statusCache && Date.now() - statusAt < 5_000) return statusCache;
    if (!statusPending) statusPending = Promise.all(providerIds.map(inspect)).then(value => {
      statusCache = value; statusAt = Date.now(); return value;
    }).finally(() => { statusPending = undefined; });
    return statusPending;
  }
  async function complete(body, { signal, reasoningEffort } = {}) {
    const { provider, model } = resolveModel(body.model, config);
    if (active.has(provider)) throw new ApiError(429, 'provider_busy', 'This provider is handling another request. Try again shortly.');
    active.add(provider);
    let directory;
    try {
      const current = (await status()).find(item => item.id === provider);
      if (!current?.connected) throw new ApiError(503, 'sign_in_required', 'Sign in to this provider on the Mac mini, then refresh connection status.');
      if (signal?.aborted) throw new ApiError(499, 'cancelled', 'Request cancelled.');
      directory = await mkdtemp(path.join(config.workDir, 'request-'));
      const invocation = providerCommand(provider, config, model, reasoningEffort);
      const result = await run(invocation.command, invocation.args, {
        cwd: directory, input: conversationPrompt(body.messages), signal,
        timeoutMs: config.timeoutMs, env: await providerEnvironment(provider, config),
      });
      return parseProviderResult(provider, result);
    } finally {
      active.delete(provider);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  return { status, complete };
}
