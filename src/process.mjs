import { spawn } from 'node:child_process';
import { ApiError } from './errors.mjs';

const running = new Set();
export function stopAllProcesses() {
  for (const stop of running) stop(new ApiError(503, 'service_stopping', 'The service is restarting. Try again shortly.'));
}

// Deliberately exclude provider API keys, alternate base URLs, and inherited agent settings.
export function subscriptionEnvironment(source = process.env) {
  return Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']
    .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

export function runProcess(command, args, { cwd, input = '', signal, timeoutMs = 90_000, env = subscriptionEnvironment(), maxBytes = 2_000_000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError(499, 'cancelled', 'Request cancelled.'));
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
    catch { return reject(new ApiError(503, 'cli_unavailable', 'The provider CLI could not start.')); }
    let stdout = '', stderr = '', size = 0, failure, killTimer, settled = false;
    const kill = sig => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch { /* Process already exited. */ }
    };
    const stop = error => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => stop(new ApiError(499, 'cancelled', 'Request cancelled.'));
    running.add(stop);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new ApiError(504, 'provider_timeout', 'The provider took too long. Try a shorter prompt.')), timeoutMs);
    const collect = (target, data) => {
      size += Buffer.byteLength(data, 'utf8');
      if (size > maxBytes) return stop(new ApiError(502, 'provider_output_limit', 'The provider response exceeded the size limit.'));
      if (target === 'out') {
        stdout += data;
        if (!failure && onStdout) {try {onStdout(data);} catch (error) {stop(error);}}
      } else stderr += data;
    };
    child.stdout.setEncoding('utf8').on('data', data => collect('out', data));
    child.stderr.setEncoding('utf8').on('data', data => collect('err', data));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      running.delete(stop);
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    child.on('error', () => finish(new ApiError(503, 'cli_unavailable', 'The provider CLI is unavailable. Check its installation.')));
    child.on('close', code => finish(failure, { code, stdout, stderr }));
    child.stdin.on('error', () => { /* Early child exit is handled by close. */ });
    child.stdin.end(input);
  });
}
