import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { ApiError } from '../src/errors.mjs';
import { createReviewJobs, JOB_LIMITS } from '../src/review-jobs.mjs';

function controlled() {
  const runs = [];
  const run = (body, signal) => new Promise((resolve, reject) => {
    runs.push({ body, signal, resolve, reject });
    signal.addEventListener('abort', () => reject(new ApiError(499, 'cancelled', 'Request cancelled.')));
  });
  return { runs, run };
}
const clock = () => {
  const state = { now: 1_000_000 };
  return { state, now: () => state.now };
};

test('jobs run one at a time in order and report queue position', async () => {
  const { runs, run } = controlled();
  const jobs = createReviewJobs(run);
  const first = jobs.submit({ n: 1 });
  const second = jobs.submit({ n: 2 });
  assert.deepEqual([first.status, first.position, second.position], ['queued', 1, 2]);
  await tick();
  assert.equal(runs.length, 1);
  assert.equal(jobs.get(first.id).status, 'running');
  assert.deepEqual(jobs.get(second.id), { id: second.id, status: 'queued', position: 1 });
  runs[0].resolve({ answer: 1 });
  await tick(); await tick();
  assert.deepEqual(jobs.get(first.id), { id: first.id, status: 'completed', result: { answer: 1 } });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].body, { n: 2 });
});

test('a full queue is refused instead of reporting busy later', () => {
  const jobs = createReviewJobs(() => new Promise(() => {}));
  for (let i = 0; i < JOB_LIMITS.waiting; i++) jobs.submit({ i });
  assert.throws(() => jobs.submit({}), error => error.status === 429 && error.code === 'queue_full');
});

test('failures expose only safe error fields', async () => {
  const jobs = createReviewJobs(async body => {
    if (body.known) throw new ApiError(429, 'provider_busy', 'This provider is handling another request.');
    throw new Error('PRIVATE_TOKEN_AND_PATH');
  });
  const known = jobs.submit({ known: true });
  const unknown = jobs.submit({ known: false });
  await tick(); await tick(); await tick();
  assert.deepEqual(jobs.get(known.id).error, { status: 429, code: 'provider_busy', message: 'This provider is handling another request.' });
  const hidden = jobs.get(unknown.id);
  assert.equal(hidden.error.code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(hidden), /PRIVATE/);
});

test('jobs nobody checks on are cancelled so they stop using the allowance', async () => {
  const { runs, run } = controlled();
  const time = clock();
  const jobs = createReviewJobs(run, { now: time.now });
  const running = jobs.submit({ n: 1 });
  const waiting = jobs.submit({ n: 2 });
  await tick();
  time.state.now += JOB_LIMITS.abandonMs - 1;
  jobs.get(waiting.id);
  jobs.sweep();
  assert.equal(runs[0].signal.aborted, false);
  time.state.now += 2;
  jobs.sweep();
  assert.equal(runs[0].signal.aborted, true);
  await tick(); await tick();
  assert.equal(jobs.get(running.id).error.code, 'abandoned');
  assert.equal(jobs.get(waiting.id).status, 'running');
  time.state.now += JOB_LIMITS.abandonMs + 1;
  jobs.sweep();
  await tick(); await tick();
  assert.equal(jobs.get(waiting.id).error.code, 'abandoned');
});

test('abandoned queued jobs never start', async () => {
  const { runs, run } = controlled();
  const time = clock();
  const jobs = createReviewJobs(run, { now: time.now });
  jobs.submit({ n: 1 });
  const waiting = jobs.submit({ n: 2 });
  await tick();
  time.state.now += JOB_LIMITS.abandonMs + 1;
  jobs.sweep();
  assert.equal(jobs.get(waiting.id).error.code, 'abandoned');
  runs[0].resolve({});
  await tick(); await tick();
  assert.equal(runs.length, 1);
});

test('finished results expire, and unknown or malformed IDs are rejected', async () => {
  const time = clock();
  const jobs = createReviewJobs(async () => ({ ok: true }), { now: time.now });
  const job = jobs.submit({});
  await tick(); await tick();
  assert.equal(jobs.get(job.id).status, 'completed');
  time.state.now += JOB_LIMITS.keepMs + 1;
  assert.throws(() => jobs.get(job.id), error => error.status === 404 && error.code === 'job_not_found');
  for (const id of [null, '', 'abc', job.id + 'x', '../etc']) {
    assert.throws(() => jobs.get(id), error => error.status === 400 && error.code === 'invalid_job');
  }
});

test('stored results are bounded', async () => {
  const jobs = createReviewJobs(async () => ({}), { limits: { ...JOB_LIMITS, waiting: 100, stored: 3 } });
  const ids = [];
  for (let i = 0; i < 6; i++) {
    ids.push(jobs.submit({}).id);
    await tick(); await tick();
  }
  jobs.sweep();
  assert.throws(() => jobs.get(ids[0]), error => error.code === 'job_not_found');
  assert.equal(jobs.get(ids[5]).status, 'completed');
});

test('stopping the gateway fails waiting jobs and cancels the running one', async () => {
  const { runs, run } = controlled();
  const jobs = createReviewJobs(run);
  const running = jobs.submit({});
  const waiting = jobs.submit({});
  await tick();
  jobs.stop();
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(jobs.get(waiting.id).error.code, 'shutting_down');
  await tick(); await tick();
  assert.equal(jobs.get(running.id).status, 'failed');
  assert.equal(runs.length, 1);
});

test('unauthorized polling cannot keep another project job alive',async()=>{
  const time=clock(), {run,runs}=controlled(),jobs=createReviewJobs(run,{now:time.now});
  const first=jobs.submit({}, {owner:'one',agent:'general'});await tick();
  time.state.now+=JOB_LIMITS.abandonMs-1;
  assert.throws(()=>jobs.get(first.id,'two'),error=>error.code==='job_not_found');
  time.state.now+=2;jobs.sweep();assert.equal(runs[0].signal.aborted,true);await tick();
  assert.equal(jobs.get(first.id,'one').status,'failed');
});
test('cancellation cannot become a successful late completion and stopped queues reject submissions',async()=>{
  const {run,runs}=controlled(),jobs=createReviewJobs(run);
  const job=jobs.submit({});await tick();jobs.stop();runs[0].resolve({});await tick();
  assert.equal(jobs.get(job.id).error.code,'shutting_down');assert.throws(()=>jobs.submit({}),error=>error.code==='shutting_down');
});
