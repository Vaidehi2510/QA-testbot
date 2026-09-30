const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { upsertComment, updateLabels, readResultsArtifact, getClient } = require('../src/github');

test('GitHub mutations are fully suppressed in dry-run', async () => {
  const gh = new Proxy({}, { get: () => { throw new Error('Unexpected API access'); } });
  assert.equal((await upsertComment(gh, 'o', 'r', 1, '<!--qa-->', 'text', { dryRun: true })).status, 'preview');
  assert.equal((await updateLabels(gh, 'o', 'r', 1, { status: 'passed' }, { completeLabel: 'done' }, { dryRun: true })).want, 'done');
});
test('a user marker cannot redirect updates into a human comment', async () => {
  const calls = [];
  const gh = { paginate: async () => [{ id: 1, user: { type: 'User' }, body: '<!--qa-->spoof' }], rest: { issues: {
    listComments: () => {}, updateComment: async () => { throw new Error('Should not edit a user comment'); },
    createComment: async body => { calls.push(body); return { data: { id: 2 } }; },
  } } };
  assert.equal((await upsertComment(gh, 'o', 'r', 1, '<!--qa-->', 'plan')).id, 2);
  assert.equal(calls.length, 1);
});
test('collector selects only the exact Actions attempt and reads JSON without extraction', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-artifact-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ schemaVersion: 1, actionsAttempt: 2 }));
  execFileSync('zip', ['-q', 'artifact.zip', 'results.json'], { cwd: directory });
  const bytes = await fs.readFile(path.join(directory, 'artifact.zip'));
  const key = 'a'.repeat(64);
  const calls = [];
  const gh = { paginate: async () => [
    { id: 1, name: `qa-results-${key}-attempt-1`, size_in_bytes: bytes.length },
    { id: 2, name: `qa-results-${key}-attempt-2`, size_in_bytes: bytes.length },
  ], rest: { actions: { listWorkflowRunArtifacts: () => {}, downloadArtifact: async args => { calls.push(args.artifact_id); return { data: bytes }; } } } };
  const result = await readResultsArtifact(gh, 'o', 'r', { id: 10, run_attempt: 2 }, key);
  assert.equal(result.actionsAttempt, 2);
  assert.deepEqual(calls, [2]);
  assert.equal(await readResultsArtifact(gh, 'o', 'r', { id: 10, run_attempt: 3 }, key), null);
});
test('missing or oversized artifacts are untested, never successful', async () => {
  const gh = { paginate: async () => [{ name: 'qa-results-key-attempt-1', size_in_bytes: 6 * 1024 * 1024 }], rest: { actions: { listWorkflowRunArtifacts: () => {} } } };
  assert.equal(await readResultsArtifact(gh, 'o', 'r', { id: 1, run_attempt: 1 }, 'key'), null);
});
