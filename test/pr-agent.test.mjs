import test from 'node:test';
import assert from 'node:assert/strict';
import {changedLines, reviewScope, reviewTarget, validateReview, reviewMarkdown} from '../src/pr-agent.mjs';
const patch = '@@ -3,2 +3,2 @@\n-old()\n+new()\n unchanged';
const files = reviewScope([{filename: 'src/a.js', patch, additions: 1, deletions: 1}], 1);
const pr = {state: 'open', head: {sha: 'a'.repeat(40), repo: {full_name: 'o/r'}},
  base: {sha: 'b'.repeat(40), repo: {full_name: 'o/r'}}};
const result = () => ({complete: true, summary: 'One regression.', coveredFiles: ['src/a.js'],
  findings: [{path: 'src/a.js', side: 'head', line: 3, severity: 'medium', title: 'Wrong call',
    explanation: 'Explain the concrete regression.', evidence: 'new()'}]});
test('PR target rejects stale revisions, forks, and closed requests', () => {
  assert.deepEqual(reviewTarget(pr, 'o/r', pr.head.sha), {head: pr.head.sha, base: pr.base.sha});
  assert.throws(() => reviewTarget(pr, 'o/r', 'c'.repeat(40)));
  assert.throws(() => reviewTarget({...pr, state: 'closed'}, 'o/r'));
  assert.throws(() => reviewTarget({...pr, head: {...pr.head, repo: {full_name: 'other/r'}}}, 'o/r'));
});
test('diff lines distinguish additions, deletions and unchanged context', () => {
  assert.equal(changedLines(patch).get('head:3'), 'new()');
  assert.equal(changedLines(patch).get('base:3'), 'old()');
  assert.equal(changedLines(patch).has('head:4'), false);
  assert.throws(() => reviewScope([{filename: 'x', patch, additions: 2, deletions: 1}], 1));
  assert.throws(() => reviewScope([{filename: 'x', additions: 0, deletions: 0}], 1));
  assert.throws(() => reviewScope(files, 2));
});
test('incomplete coverage and fabricated citations cannot become successful reviews', () => {
  assert.equal(validateReview(result(), files).findings.length, 1);
  for (const change of [
    r => {r.complete = false;}, r => {r.coveredFiles = [];},
    r => {r.coveredFiles.push('src/a.js');}, r => {r.findings[0].line = 4;},
    r => {r.findings[0].evidence = 'invented';}, r => {r.findings[0].evidence = '';},
    r => {r.findings[0].path = '../secret';},
  ]) {const r = result(); change(r); assert.throws(() => validateReview(r, files));}
});
test('review rendering treats model HTML and links as literal text', () => {
  const r = result(); r.summary = '<img src="https://outside"> ![link](https://outside)';
  const text = reviewMarkdown(r, 'o/r', {head: pr.head.sha, base: pr.base.sha});
  assert.ok(!text.includes('<img')); assert.ok(text.includes('\\!\\[link\\]'));
  assert.ok(text.includes(`/blob/${pr.head.sha}/src/a.js#L3`));
});
test('deleted-line citations on renamed files link to the actual base path', () => {
  const r = result(); r.findings[0].side = 'base'; r.findings[0].evidence = 'old()';
  const text = reviewMarkdown(r, 'o/r', {head: pr.head.sha, base: pr.base.sha},
    [{filename: 'src/a.js', previous_filename: 'src/old(name).js'}]);
  assert.ok(text.includes(`/blob/${pr.base.sha}/src/old%28name%29.js#L3`));
});
