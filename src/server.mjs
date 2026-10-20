import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, publicError } from './errors.mjs';
import { validateRequest } from './providers.mjs';
import { modelCatalog, defaultModels } from './models.mjs';
import { skillZip } from './skill-zip.mjs';
import { createReviewJobs } from './review-jobs.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/reviews', ['reviews.html', 'text/html; charset=utf-8']],
  ['/reviews.js', ['reviews.js', 'text/javascript; charset=utf-8']],
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
// The CI review route alone accepts a larger bounded conversation; the personal API keeps the smaller limits.
// Character bounds limit transport size, not token usage; extended context requires explicit opt-in.
const REVIEW_LIMITS = { bodyBytes: 640_000, characters: 400_000, timeoutMs: 300_000 };
const FULL_REVIEW_LIMITS = { bodyBytes: 3_000_000, characters: 2_000_000, timeoutMs: 900_000 };
function reviewSchema(schema) {
  if (!schema || schema.type !== 'object' || Array.isArray(schema) || Buffer.byteLength(JSON.stringify(schema)) > 16_000)
    throw new ApiError(400, 'invalid_schema', 'Provide a bounded object JSON Schema.');
  const visit = (value, depth = 0) => {
    if (depth > 20) throw new ApiError(400, 'invalid_schema', 'Schema nesting exceeds limit.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key)) throw new ApiError(400, 'invalid_schema', 'Schema references are unsupported.');
      visit(child, depth + 1);
    }
  };
  visit(schema);
  return schema;
}
async function readBody(req, maxBytes = 256_000) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'invalid_content_type', 'Send Content-Type: application/json.');
  const chunks = []; let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > maxBytes) {
      req.resume();
      throw new ApiError(413, 'body_too_large', `Request body exceeds ${Math.round(maxBytes / 1000)} KB.`);
    }
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.'); }
}
function apiResult(model, text, id, created) {
  return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

export function createServer(config, providers, { reviewJobs } = {}) {
  const requests = new Set();
  const reviewText = (body, signal) => providers.complete(body, {
    signal, reasoningEffort: 'high',
    timeoutMs: body.json_schema ? FULL_REVIEW_LIMITS.timeoutMs : REVIEW_LIMITS.timeoutMs,
    ...(body.json_schema ? { jsonSchema: body.json_schema } : {}),
  });
  const jobs = reviewJobs || createReviewJobs(async (body, signal) =>
    apiResult(body.model, await reviewText(body, signal), 'chatcmpl-' + randomUUID(), Math.floor(Date.now() / 1000)));
  const sweeper = setInterval(() => jobs.sweep(), 15_000);
  sweeper.unref();
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
        if (req.headers.origin) throw new ApiError(403, 'origin_rejected', 'This endpoint is for CI only.');
        if (req.method === 'GET') return json(res, 200, jobs.get(url.searchParams.get('job')));
        if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST to submit or GET to check a review job.');
        const mode = req.headers['x-review-mode'];
        if (mode !== undefined && mode !== 'full-context-v1') throw new ApiError(400, 'unsupported_review_mode', 'Unknown review mode.');
        const full = mode === 'full-context-v1';
        const limits = full ? FULL_REVIEW_LIMITS : REVIEW_LIMITS;
        const raw = await readBody(req, limits.bodyBytes);
        let schema;
        if (full) {
          schema = reviewSchema(raw?.json_schema);
          delete raw.json_schema;
        }
        const body = validateRequest(raw, limits.characters, {responseFormat: !full});
        const expectedModel = full ? 'claude/claude-opus-5-5[1m]' : 'claude/claude-opus-5-5';
        if (body.model !== expectedModel || body.stream === true) throw new ApiError(400, 'unsupported_review_request', 'Review requires the fixed Claude Opus 5.5 route and a non-streaming request.');
        if (full) body.json_schema = schema;
        // `Prefer: respond-async` queues a job and returns at once. Without it the request waits,
        // which only suits reviews that finish before the public proxy's timeout.
        if (/(^|[\s,])respond-async($|[\s,;])/i.test(req.headers.prefer || '')) {
          const job = jobs.submit(body);
          res.setHeader('location', '/ci/slice/review?job=' + job.id);
          return json(res, 202, job);
        }
        const text = await reviewText(body, controller.signal);
        if (!res.destroyed) json(res, 200, apiResult(body.model, text, 'chatcmpl-' + randomUUID(), Math.floor(Date.now() / 1000)));
        return;
      }
      if (url.pathname.startsWith('/api/review/')) {
        if (!launcherOwner(req, config)) throw new ApiError(401, 'unauthorized', 'Open review management through the owner portal.');
        if (req.headers.origin && req.headers.origin !== config.origin) throw new ApiError(403, 'origin_rejected', 'Request origin is not allowed.');
        if (req.method === 'POST' && req.headers.origin !== config.origin) throw new ApiError(403, 'origin_required', 'Open this action from the app.');
        const store = config.reviewStore;
        if (!store) throw new ApiError(503, 'review_config_invalid', 'Review configuration is unavailable.');
        store.ready();
        if (url.pathname === '/api/review/config' && req.method === 'GET') return json(res, 200, store.view());
        if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST for review configuration changes.');
        const body = await readBody(req, 1_650_000);
        const action = url.pathname.slice('/api/review/'.length);
        let result;
        const fields = keys => {
          if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(k => !keys.includes(k))) throw new ApiError(400, 'invalid_review_config', 'Unexpected review configuration fields.');
        };
        switch (action) {
          case 'agents': result = await store.saveAgent(body); break;
          case 'projects': result = await store.saveProject(body); break;
          case 'skills': {
            fields(['id', 'files', 'zip']);
            if ((body.files !== undefined) === (body.zip !== undefined)) throw new ApiError(400, 'invalid_review_config', 'Provide skill text files or one ZIP archive.');
            result = await store.saveSkill(body.id, body.zip !== undefined ? skillZip(body.zip) : body.files); break;
          }
          case 'agents/delete': fields(['name']); result = await store.deleteAgent(body.name); break;
          case 'projects/delete': fields(['name']); result = await store.deleteProject(body.name); break;
          case 'projects/rotate-key': fields(['name']); result = await store.rotateKey(body.name); break;
          case 'skills/delete': fields(['id']); result = await store.deleteSkill(body.id); break;
          default: throw new ApiError(404, 'not_found', 'Review management action not found.');
        }
        return json(res, 200, result || {ok:true});
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
    clearInterval(sweeper);
    jobs.stop();
    for (const controller of requests) controller.abort();
    server.close(); server.closeIdleConnections();
  };
  return server;
}
