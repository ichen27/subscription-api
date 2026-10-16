import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, publicError } from './errors.mjs';
import { validateRequest } from './providers.mjs';
import { modelCatalog, defaultModels } from './models.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function bearer(req, expected) {
  const value = req.headers.authorization?.replace(/^Bearer /, '');
  if (!value) return false;
  const actual = Buffer.from(value), secret = Buffer.from(expected);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}
function launcherOwner(req, config) {
  return config.ownerEmail && ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)
    && req.headers.host === config.host && req.headers['x-forwarded-host'] === config.host
    && req.headers['x-forwarded-proto'] === 'https'
    && req.headers['cf-access-authenticated-user-email'] === config.ownerEmail;
}
async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'invalid_content_type', 'Send Content-Type: application/json.');
  const chunks = []; let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > 256_000) {
      req.resume();
      throw new ApiError(413, 'body_too_large', 'Request body exceeds 256 KB.');
    }
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.'); }
}
function apiResult(model, text, id, created) {
  return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

export function createServer(config, providers) {
  const requests = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let heartbeat;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    requests.add(controller);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
      const asset = assets.get(url.pathname);
      if (asset && ['GET', 'HEAD'].includes(req.method)) {
        const content = await readFile(new URL('../public/' + asset[0], import.meta.url));
        res.writeHead(200, { 'content-type': asset[1] });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      // A separate machine credential grants only this fixed-model text endpoint.
      // Public routing must also enforce the dedicated Cloudflare Access audience.
      if (url.pathname === '/ci/slice/review') {
        if (!config.reviewKey) throw new ApiError(404, 'not_found', 'Review endpoint is disabled.');
        if (!bearer(req, config.reviewKey)) throw new ApiError(401, 'unauthorized', 'A review credential is required.');
        if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST.');
        if (req.headers.origin) throw new ApiError(403, 'origin_rejected', 'This endpoint is for CI only.');
        const body = validateRequest(await readBody(req));
        if (body.model !== 'chatgpt/gpt-6-astra' || body.stream === true) throw new ApiError(400, 'unsupported_review_request', 'Review requires the fixed GPT-6 Astra route and a non-streaming request.');
        const text = await providers.complete(body, { signal: controller.signal, reasoningEffort: 'high' });
        if (!res.destroyed) json(res, 200, apiResult(body.model, text, 'chatcmpl-' + randomUUID(), Math.floor(Date.now() / 1000)));
        return;
      }
      const isBearer = bearer(req, config.apiKey);
      const isOwner = launcherOwner(req, config);
      // Public API always requires the gateway key, including when Cloudflare Access is satisfied.
      if (url.pathname.startsWith('/v1/') ? !isBearer : !isBearer && !isOwner) throw new ApiError(401, 'unauthorized', 'Use your gateway API key or open this app from Launchpad.');
      if (req.headers.origin && req.headers.origin !== config.origin) throw new ApiError(403, 'origin_rejected', 'Request origin is not allowed.');
      if (req.method === 'POST' && url.pathname.startsWith('/api/') && req.headers.origin !== config.origin) throw new ApiError(403, 'origin_required', 'Open this action from the app.');
      if (url.pathname === '/v1/models' && req.method === 'GET') return json(res, 200, { object: 'list', data: modelCatalog(config).map(({ label, provider, ...model }) => model) });
      if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, {
        providers: await providers.status(), models: modelCatalog(config), baseUrl: config.origin + '/v1',
        localBaseUrl: `http://127.0.0.1:${config.port}/v1`,
        upstreamModels: defaultModels(config),
        loginCommands: { chatgpt: 'codex login', claude: config.claudeTokenFile ? 'claude setup-token' : 'claude auth login --claudeai' },
        claudeAutomation: Boolean(config.claudeTokenFile),
      });
      if (url.pathname === '/api/models/default' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !['provider', 'model'].includes(key))) throw new ApiError(400, 'invalid_request', 'Send provider and model only.');
        const upstreamModels = await config.modelSettings.save(body.provider, body.model);
        return json(res, 200, { upstreamModels, models: modelCatalog(config) });
      }
      if (url.pathname === '/api/key' && req.method === 'POST') {
        await readBody(req);
        return json(res, 200, { key: config.apiKey });
      }
      if (['/v1/chat/completions', '/api/chat'].includes(url.pathname) && req.method === 'POST') {
        const body = validateRequest(await readBody(req));
        const id = 'chatcmpl-' + randomUUID(), created = Math.floor(Date.now() / 1000);
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
          res.write(': waiting for provider\n\n');
          heartbeat = setInterval(() => res.write(': waiting for provider\n\n'), 10_000);
        }
        const text = await providers.complete(body, { signal: controller.signal });
        if (res.destroyed) return;
        if (body.stream) {
          const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
          res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: text })) + '\n\n');
          res.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n');
          res.end('data: [DONE]\n\n');
        } else json(res, 200, apiResult(body.model, text, id, created));
        return;
      }
      throw new ApiError(404, 'not_found', 'Endpoint not found. Use GET /v1/models or POST /v1/chat/completions.');
    } catch (error) {
      const safe = publicError(error);
      if (!res.destroyed) {
        const body = { error: { message: safe.message, type: safe.status >= 500 ? 'server_error' : 'invalid_request_error', code: safe.code } };
        if (res.headersSent) res.end('data: ' + JSON.stringify(body) + '\n\ndata: [DONE]\n\n');
        else {
          if (safe.status === 429) res.setHeader('retry-after', '10');
          json(res, safe.status, body);
        }
      }
    } finally {
      clearInterval(heartbeat);
      requests.delete(controller);
      res.off('close', disconnect);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.stop = () => {
    for (const controller of requests) controller.abort();
    server.close(); server.closeIdleConnections();
  };
  return server;
}
