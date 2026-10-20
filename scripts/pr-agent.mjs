import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {createSandbox, initializeSandbox} from '../src/sandbox.mjs';
import {reviewTarget, reviewScope, makeReviewSpec, parseReviewOutput, reviewMarkdown} from '../src/pr-agent.mjs';

const env = process.env;
const repository = env.GITHUB_REPOSITORY;
const prNumber = env.REVIEW_PR;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[1-9]\d*$/.test(prNumber || '') ||
    !env.GITHUB_TOKEN || !env.CLAUDE_CODE_OAUTH_TOKEN || !/^sha256:[a-f0-9]{64}$/.test(env.REVIEW_IMAGE_DIGEST || ''))
  throw new Error('Missing repository, PR, protected credentials, or verified image digest.');
if (env.GITHUB_ACTIONS === 'true' && (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'))
  throw new Error('Agent execution requires a manual workflow dispatched from main.');

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
async function api(suffix, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, {
    method, headers: {authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
      'content-type': 'application/json', 'x-github-api-version': '2022-11-28'},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
  return response.status === 204 ? undefined : response.json();
}

let directory, release, check, target, report, baseTip;
const outputDir = path.resolve(env.REVIEW_OUTPUT_DIR || 'review-output');
try {
  if (env.GITHUB_ACTIONS === 'true') {
    if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '')) throw new Error('Invalid run identity.');
    const run = await api(`actions/runs/${env.GITHUB_RUN_ID}`);
    if (run.event !== 'workflow_dispatch' || run.head_branch !== 'main' ||
        run.path !== '.github/workflows/agent-review.yml' || run.head_repository?.full_name !== repository ||
        run.status !== 'in_progress' || String(run.run_attempt) !== env.GITHUB_RUN_ATTEMPT)
      throw new Error('The workflow is not an active trusted main dispatch.');
  }
  const pr = await api(`pulls/${prNumber}`);
  target = reviewTarget(pr, repository, env.REVIEW_HEAD || undefined);
  baseTip = target.base;
  const comparison = await api(`compare/${baseTip}...${target.head}`);
  if (!/^[a-f0-9]{40}$/.test(comparison.merge_base_commit?.sha || '')) throw new Error('Missing merge base.');
  target.base = comparison.merge_base_commit.sha;
  const files = reviewScope(await api(`pulls/${prNumber}/files?per_page=100`), pr.changed_files);
  // Reject races between the PR metadata and its mutable files endpoint.
  const afterFiles = reviewTarget(await api(`pulls/${prNumber}`), repository, target.head);
  if (afterFiles.base !== baseTip) throw new Error('PR base changed while gathering its diff.');
  check = await api('check-runs', {name: 'Agent review', head_sha: target.head, status: 'in_progress',
    external_id: `${env.GITHUB_RUN_ID || 'local'}:${env.GITHUB_RUN_ATTEMPT || '1'}`,
    ...(env.GITHUB_RUN_ID ? {details_url: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`} : {}),
    output: {title: 'Reviewing exact PR revisions', summary: `PR #${prNumber}, head ${target.head}, base ${target.base}.`}});
  directory = await mkdtemp(path.join(env.RUNNER_TEMP || '/tmp', 'pr-agent-'));
  const tokenFile = path.join(directory, 'subscription.token');
  await writeFile(tokenFile, env.CLAUDE_CODE_OAUTH_TOKEN, {mode: 0o600});
  // Only the reviewed sandbox receives this credential, never GitHub checkout or archive code.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const config = {workDir: directory, reviewImage: env.REVIEW_IMAGE_DIGEST, claudeTokenFile: tokenFile};
  release = await initializeSandbox(config);
  const result = await createSandbox(config)(makeReviewSpec(repository, target, files, env.GITHUB_TOKEN), abort.signal);
  const review = parseReviewOutput(result, files);
  const fresh = reviewTarget(await api(`pulls/${prNumber}`), repository, target.head);
  if (fresh.base !== baseTip || abort.signal.aborted) throw new Error('PR changed or review was cancelled.');
  report = {repository, pr: Number(prNumber), ...target, baseTip, review, usage: result.usage,
    provenance: {...result.provenance, controllerDigest: env.REVIEW_CONTROLLER_DIGEST},
    warnings: result.warnings || []};
  await mkdir(outputDir, {recursive: true});
  await writeFile(path.join(outputDir, 'review.json'), JSON.stringify(report, null, 2) + '\n');
  const markdown = reviewMarkdown(review, repository, target, files);
  await writeFile(path.join(outputDir, 'review.md'), markdown);
  if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, markdown);
  await api(`check-runs/${check.id}`, {status: 'completed',
    conclusion: review.findings.length ? 'neutral' : 'success',
    output: {title: `${review.findings.length} findings; ${files.length} files reviewed`,
      summary: Buffer.byteLength(markdown) <= 60_000 ? markdown : 'The complete review is attached to this workflow as review.md and review.json.'}}, 'PATCH');
  console.log(`Completed PR #${prNumber} at ${target.head}: ${review.findings.length} findings.`);
} catch (error) {
  // Do not print model output, provider stderr, or environment values.
  const safe = error.code && /^[a-z_]+$/.test(error.code) ? error.code : 'review_failed';
  if (check) await api(`check-runs/${check.id}`, {status: 'completed', conclusion: abort.signal.aborted ? 'cancelled' : 'failure',
    output: {title: 'Review incomplete', summary: `${safe}. No successful review was published. Inspect the workflow and retry after resolving the cause.`}}, 'PATCH').catch(() => {});
  console.error(`PR review failed: ${safe}`);
  process.exitCode = 1;
} finally {
  await release?.();
  if (directory) await rm(directory, {recursive: true, force: true});
}
