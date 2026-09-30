const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { upsertComment, updateLabels, readResultsArtifact, readRunScreenshots, getClient } = require('../src/github');

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
  const gh = { paginate: async () => [{ name: 'qa-results-key-attempt-1', size_in_bytes: 17 * 1024 * 1024 }], rest: { actions: { listWorkflowRunArtifacts: () => {} } } };
  assert.equal(await readResultsArtifact(gh, 'o', 'r', { id: 1, run_attempt: 1 }, 'key'), null);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
async function screenshotArtifact(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-image-artifact-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sha256 = createHash('sha256').update(png).digest('hex');
  const image = { name: 'checkout', path: `screenshots/${sha256}.png`, sha256, mimeType: 'image/png', revision: 'a'.repeat(40), checkId: 'ui' };
  const envelope = { schemaVersion: 1, repository: 'target/product', prNumber: 7, revision: image.revision, environment: 'synthetic', runId: 'logical', attempt: 1,
    actionsRunId: '10', actionsAttempt: 2, results: [{ checkId: 'ui', status: 'passed' }], screenshots: [image] };
  const run = { ...envelope, key: 'b'.repeat(64), pr: { number: 7 } };
  await fs.mkdir(path.join(directory, 'screenshots'));
  await fs.writeFile(path.join(directory, image.path), png);
  const gh = { paginate: async () => [{ id: 2, name: `qa-results-${run.key}-attempt-2`, size_in_bytes: 3000 }],
    rest: { actions: { listWorkflowRunArtifacts: () => {}, downloadArtifact: async () => {
      await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(envelope));
      await fs.rm(path.join(directory, 'artifact.zip'), { force: true });
      execFileSync('zip', ['-q', 'artifact.zip', 'results.json', image.path], { cwd: directory });
      return { data: await fs.readFile(path.join(directory, 'artifact.zip')) };
    } } } };
  return { gh, envelope, run, image, directory };
}

test('collector reads hashed revision-bound image bytes and rejects substituted evidence', async t => {
  const { gh, envelope, run, image, directory } = await screenshotArtifact(t);
  const read = () => readResultsArtifact(gh, 'bot', 'repo', { id: 10, run_attempt: 2 }, run.key);
  const first = await read();
  assert.equal(first.screenshots[0].data, png.toString('base64'));
  for (const invalid of [{ path: '../outside.png' }, { sha256: '0'.repeat(64) }, { revision: 'c'.repeat(40) }, { checkId: 'unknown' }, { mimeType: 'image/jpeg' }]) {
    envelope.screenshots = [{ ...image, ...invalid }];
    const result = await read();
    assert.deepEqual(result.screenshots, []);
    assert.match(result.screenshotLimitations.join(' '), /incomplete/);
  }
  const malformed = png.subarray(0, 8);
  envelope.screenshots = [{ ...image, sha256: createHash('sha256').update(malformed).digest('hex') }];
  await fs.writeFile(path.join(directory, image.path), malformed);
  assert.deepEqual((await read()).screenshots, []);
});

test('screenshot reload checks every run identity and the persisted manifest before model upload', async t => {
  const { gh, envelope, run, image } = await screenshotArtifact(t);
  assert.equal((await readRunScreenshots(gh, 'bot', 'repo', run))[0].sha256, image.sha256);
  for (const [field, value] of Object.entries({ schemaVersion: 2, repository: 'other/repo', prNumber: 8, revision: 'c'.repeat(40), environment: 'production', runId: 'other', attempt: 2, actionsRunId: '11', actionsAttempt: 3 })) {
    const original = envelope[field];
    envelope[field] = value;
    await assert.rejects(() => readRunScreenshots(gh, 'bot', 'repo', run), /identity changed/);
    envelope[field] = original;
  }
  run.screenshots = [{ ...image, sha256: 'd'.repeat(64) }];
  await assert.rejects(() => readRunScreenshots(gh, 'bot', 'repo', run), /manifest changed/);
});
