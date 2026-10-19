import { randomUUID } from 'node:crypto';
import { ApiError, publicError } from './errors.mjs';

// CI reviews can run for minutes, longer than the public proxy keeps one request open.
// Jobs let CI submit once and check back with short requests. One review runs at a time.
export const JOB_LIMITS = Object.freeze({
  waiting: 4,           // queued behind the running review
  stored: 50,           // finished results kept for polling
  keepMs: 15 * 60_000,  // how long a finished result stays available
  abandonMs: 120_000,   // cancel a job nobody has checked on for this long
});
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createReviewJobs(run, { now = Date.now, limits = JOB_LIMITS } = {}) {
  const jobs = new Map();
  const queue = [];
  let running, stopped = false;
  const drains = [];

  function view(job) {
    const result = { id: job.id, status: job.status, ...(job.agent ? {agent:job.agent} : {}) };
    if (job.status === 'queued') result.position = queue.indexOf(job) + 1;
    if (job.status === 'completed') {
      result.result = job.result;
      if (job.usage) result.usage = job.usage;
      if (job.warnings?.length) result.warnings = job.warnings;
      if (job.provenance) result.provenance = job.provenance;
    }
    if (job.status === 'failed') result.error = job.error;
    return result;
  }
  function fail(job, error) {
    const safe = publicError(error);
    job.status = 'failed';
    job.error = { status: safe.status, code: safe.code, message: safe.message };
    job.finishedAt = now();
  }
  function prune() {
    const finished = [...jobs.values()].filter(job => job.finishedAt !== undefined);
    for (const job of finished) {
      if (now() - job.finishedAt > limits.keepMs || jobs.size > limits.stored) jobs.delete(job.id);
    }
  }
  async function next() {
    if (stopped || running || !queue.length) return;
    const job = running = queue.shift();
    job.status = 'running';
    job.controller = new AbortController();
    try {
      const output = await run(job.body, job.controller.signal, job.id);
      if (job.controller.signal.aborted) throw new ApiError(499, 'cancelled', 'Review cancelled.');
      if (job.agent) {job.result = output.result; job.usage = output.usage; job.warnings = output.warnings; job.provenance = output.provenance;}
      else job.result = output;
      job.status = 'completed';
      job.finishedAt = now();
    } catch (error) {
      fail(job, stopped ? new ApiError(503, 'shutting_down', 'The gateway is restarting.') : job.abandoned ? new ApiError(499, 'abandoned', 'Review cancelled because nobody checked on it.') : error);
    } finally {
      job.body = job.controller = running = undefined;
      if (!queue.length) for (const resolve of drains.splice(0)) resolve();
      next();
    }
  }

  return {
    submit(body, {owner, agent} = {}) {
      if (stopped) throw new ApiError(503, 'shutting_down', 'The gateway is restarting.');
      prune();
      if (queue.length >= limits.waiting) throw new ApiError(429, 'queue_full', 'Too many reviews are waiting. Try again later.');
      const job = { id: randomUUID(), status: 'queued', body, owner, agent, checkedAt: now() };
      jobs.set(job.id, job);
      queue.push(job);
      setImmediate(next);
      return view(job);
    },
    get(id, owner) {
      if (!ID.test(id || '')) throw new ApiError(400, 'invalid_job', 'Provide a review job ID.');
      prune();
      const job = jobs.get(id);
      if (!job || job.owner !== owner) throw new ApiError(404, 'job_not_found', 'Review job not found or expired.');
      job.checkedAt = now();
      return view(job);
    },
    // Called on a timer: stops reviews whose CI run has gone away so they stop using the allowance.
    sweep() {
      for (const job of [...queue]) {
        if (now() - job.checkedAt <= limits.abandonMs) continue;
        queue.splice(queue.indexOf(job), 1);
        job.body = undefined;
        fail(job, new ApiError(499, 'abandoned', 'Review cancelled because nobody checked on it.'));
      }
      if (running && now() - running.checkedAt > limits.abandonMs) {
        running.abandoned = true;
        running.controller.abort();
      }
      prune();
    },
    stop() {
      stopped = true;
      for (const job of queue.splice(0)) { job.body = undefined; fail(job, new ApiError(503, 'shutting_down', 'The gateway is restarting.')); }
      running?.controller.abort();
      return running ? new Promise(resolve => drains.push(resolve)) : Promise.resolve();
    },
  };
}
