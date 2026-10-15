import { loadConfig } from './config.mjs';
import { createProviders } from './providers.mjs';
import { createServer } from './server.mjs';
import { stopAllProcesses } from './process.mjs';

const config = await loadConfig();
const server = createServer(config, createProviders(config));
server.listen(config.port, '127.0.0.1', () => console.log(`Subscription API listening on 127.0.0.1:${config.port}`));
server.on('error', error => { console.error('Server failed:', error.code || 'startup error'); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.stop();
  stopAllProcesses();
  setTimeout(() => process.exit(0), 2500).unref();
});
