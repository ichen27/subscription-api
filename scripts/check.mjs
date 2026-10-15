import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const dir of ['src', 'public', 'scripts', 'test']) {
  for (const file of await readdir(dir)) {
    if (/\.(mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
