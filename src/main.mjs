import { loadConfig } from './config.mjs';
import { createProviders } from './providers.mjs';
import { createServer } from './server.mjs';
import { createSandbox, initializeSandbox } from './sandbox.mjs';
import { ApiError } from './errors.mjs';
import { stopAllProcesses } from './process.mjs';

const config = await loadConfig();
const providers = createProviders(config);
let runner, ready = false, release;
try {
  if (config.reviewImage) runner = createSandbox(config, {exclusive: operation => providers.withProvider('claude', operation), log: event => console.log(JSON.stringify(event))});
} catch { console.error('Repository review execution is disabled: invalid sandbox configuration.'); }
const server = createServer(config, providers, {reviewRunner: runner ? (...args) => {
  if (!ready) throw new ApiError(503, 'sandbox_unavailable', 'Repository review execution is unavailable.');
  return runner(...args);
} : undefined});
server.listen(config.port, '127.0.0.1', async () => {
  console.log(`Subscription API listening on 127.0.0.1:${config.port}`);
  if (runner) try { release = await initializeSandbox(config); ready = true; }
  catch { console.error('Repository review execution is disabled: runtime initialization failed.'); }
});
server.on('error', error => { console.error('Server failed:', error.code || 'startup error'); process.exitCode = 1; });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true; ready = false;
  const deadline = setTimeout(() => {
    console.error('Shutdown deadline exceeded; review cleanup must be verified on the service host.');
    stopAllProcesses(); process.exit(1);
  }, 28_000);
  try { await server.stop(); await release?.(); }
  finally { clearTimeout(deadline); stopAllProcesses(); process.exit(0); }
});
