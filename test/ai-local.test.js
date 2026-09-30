const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { localSnapshot, readScreenshots, allowedPath } = require('../src/ai/snapshot');
const { createContext } = require('../src/ai/context');
const { parseArgs, reviewLocal } = require('../src/ai/review');

function tempDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ai-local-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(root, filename, contents) {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
function commit(repo, message) {
  git(repo, 'add', '--all', '--force');
  git(repo, '-c', 'user.name=QA Local Fixture', '-c', 'user.email=qa-local@example.invalid', 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}
function repositoryFixture(t) {
  const root = tempDirectory(t);
  const repo = path.join(root, 'app');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet');
  write(repo, 'src/app.js', 'module.exports = "base-committed";\n');
  write(repo, 'test/app.test.js', "const test = require('node:test');\ntest('fixture', () => {});\n");
  write(repo, 'README.md', 'The app returns the configured message.\n');
  const base = commit(repo, 'base');
  write(repo, 'src/app.js', 'module.exports = "head-committed";\n');
  const head = commit(repo, 'head');
  const config = { environment: 'synthetic-local', runners: [{ id: 'baseline', type: 'node-test', baseline: true, files: ['test/app.test.js'] }],
    specificationPaths: ['README.md'], decisionReviewers: ['owner'], ai: { enabled: true, model: 'test/qa' } };
  const configPath = path.join(root, 'config.json');
  const rulesPath = path.join(root, 'rules.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(rulesPath, '[]');
  const options = { repo, base, head, repository: 'example/app', pr: '3', title: 'Change configured message',
    config: configPath, rules: rulesPath, 'output-dir': path.join(root, 'review') };
  return { root, repo, base, head, config, options };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZz8AAAAASUVORK5CYII=', 'base64');
function screenshotManifest(root, { revision = 'a'.repeat(40), images = [{ path: 'screen.png', name: 'Mobile checkout', viewport: '390x844' }], environment = 'synthetic UI fixture' } = {}) {
  const manifest = path.join(root, 'screenshots.json');
  fs.writeFileSync(manifest, JSON.stringify({ revision, environment, images }));
  return manifest;
}

test('local snapshots read exact committed Git objects and ignore dirty and untracked working-tree content', async t => {
  const { repo, base, head, config } = repositoryFixture(t);
  write(repo, 'src/app.js', 'throw new Error("DIRTY_WORKTREE_MUST_NOT_RUN_OR_UPLOAD");\n');
  write(repo, 'src/untracked.js', 'UNTRACKED_MUST_NOT_UPLOAD');
  const snapshot = await localSnapshot({ repositoryPath: repo, base, head, config });
  assert.equal(snapshot.revision, head);
  assert.equal(snapshot.baseRevision, base);
  assert.equal(snapshot.sourceFiles.find(file => file.path === 'src/app.js').content, 'module.exports = "head-committed";\n');
  assert.match(snapshot.files.find(file => file.filename === 'src/app.js').patch, /\+module.exports = "head-committed"/);
  assert.equal(JSON.stringify(snapshot).includes('DIRTY_WORKTREE'), false);
  assert.equal(JSON.stringify(snapshot).includes('UNTRACKED_MUST'), false);
  assert.equal(snapshot.specifications[0].path, 'README.md');
  assert.equal(snapshot.existingTests[0].path, 'test/app.test.js');
  assert.match(fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8'), /DIRTY_WORKTREE/);
});

test('secret and configured path exclusions suppress source and changed-file patch contents before model context', async t => {
  const { repo, base, config } = repositoryFixture(t);
  const excluded = ['.env.production', 'src/private.key', 'src/credentials.json', 'src/internal/hidden.js', 'outside/public.js'];
  for (const filename of excluded) write(repo, filename, 'SENSITIVE_FIXTURE_CANARY');
  write(repo, 'src/visible.js', 'module.exports = "VISIBLE_CHANGE";');
  const head = commit(repo, 'add allowed and excluded files');
  const ai = { ...config.ai, includePaths: ['src/**'], excludePaths: ['src/internal/**'] };
  const snapshot = await localSnapshot({ repositoryPath: repo, base, head, config: { ...config, ai } });
  for (const filename of excluded) {
    assert.equal(allowedPath(filename, ai), false);
    assert.equal(snapshot.sourceFiles.some(file => file.path === filename), false);
    assert.equal(snapshot.repositoryFiles.includes(filename), false);
    assert.equal(snapshot.files.find(file => file.filename === filename).patch, '');
  }
  assert.equal(JSON.stringify(snapshot).includes('SENSITIVE_FIXTURE_CANARY'), false);
  const context = createContext(snapshot, ai);
  assert.equal(context.inventory.changedFiles.some(file => excluded.includes(file.path)), false);
  assert.match(context.inventory.changedFiles.find(file => file.path === 'src/visible.js').patch, /VISIBLE_CHANGE/);
});

test('Git filenames containing tabs cannot be reinterpreted as allowed source aliases', async t => {
  const { repo, base, config } = repositoryFixture(t);
  write(repo, 'src/alias.js\tcredentials.pem', 'PRIVATE_CONTENT_IN_UNSAFE_FILENAME');
  const head = commit(repo, 'control-character filename');
  const snapshot = await localSnapshot({ repositoryPath: repo, base, head, config });
  assert.equal(snapshot.sourceFiles.some(file => file.path === 'src/alias.js'), false);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_CONTENT_IN_UNSAFE_FILENAME'), false);
  assert.equal(createContext(snapshot, config.ai).inventory.changedFiles.some(file => file.path.includes('\t')), false);
});

test('committed symlinks are never dereferenced into local source context', async t => {
  const { root, repo, base, config } = repositoryFixture(t);
  const outside = path.join(root, 'host-secret.js');
  fs.writeFileSync(outside, 'HOST_SECRET_MUST_NOT_UPLOAD');
  fs.symlinkSync(outside, path.join(repo, 'src', 'link.js'));
  const head = commit(repo, 'source symlink');
  const snapshot = await localSnapshot({ repositoryPath: repo, base, head, config });
  assert.equal(snapshot.sourceFiles.some(file => file.path === 'src/link.js'), false);
  assert.equal(JSON.stringify(snapshot).includes('HOST_SECRET_MUST_NOT_UPLOAD'), false);
});

test('local screenshots carry exact revision, digest and context metadata', async t => {
  const root = tempDirectory(t);
  fs.writeFileSync(path.join(root, 'screen.png'), png);
  const manifest = screenshotManifest(root);
  const [image] = await readScreenshots(manifest, 'a'.repeat(40));
  assert.equal(image.revision, 'a'.repeat(40));
  assert.equal(image.name, 'Mobile checkout');
  assert.equal(image.environment, 'synthetic UI fixture');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.sha256, crypto.createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(Buffer.from(image.data, 'base64'), png);
  await assert.rejects(readScreenshots(manifest, 'b'.repeat(40)), /exact reviewed revision/);
});

test('local screenshot manifests reject path traversal, absolute paths and escaping symlinks', async t => {
  const root = tempDirectory(t);
  const directory = path.join(root, 'images');
  fs.mkdirSync(directory);
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, png);
  fs.symlinkSync(outside, path.join(directory, 'link.png'));
  for (const filename of ['../outside.png', outside, '..\\outside.png', 'link.png']) {
    const manifest = screenshotManifest(directory, { images: [{ path: filename }] });
    await assert.rejects(readScreenshots(manifest, 'a'.repeat(40)), /escapes/);
  }
});

test('local screenshots reject oversized files, malformed images, huge dimensions and excess image counts', async t => {
  const root = tempDirectory(t);
  const manifest = screenshotManifest(root);
  for (const bytes of [Buffer.alloc(2 * 1024 * 1024 + 1), png.subarray(0, 8), Buffer.from('not an image')]) {
    fs.writeFileSync(path.join(root, 'screen.png'), bytes);
    await assert.rejects(readScreenshots(manifest, 'a'.repeat(40)), /limit|PNG|JPEG|image/);
  }
  const huge = Buffer.from(png);
  huge.writeUInt32BE(10000, 16); huge.writeUInt32BE(10000, 20);
  fs.writeFileSync(path.join(root, 'screen.png'), huge);
  await assert.rejects(readScreenshots(manifest, 'a'.repeat(40)), /PNG|JPEG|image/);
  screenshotManifest(root, { images: Array.from({ length: 5 }, () => ({ path: 'screen.png' })) });
  await assert.rejects(readScreenshots(manifest, 'a'.repeat(40)), /four/);
});

test('local review dry-run and DRY_RUN environment make no model calls and create no state', async t => {
  const { options, repo } = repositoryFixture(t);
  const before = git(repo, 'status', '--porcelain', '--untracked-files=all');
  const client = { listModels: async () => assert.fail('No catalog access in dry-run'), chat: async () => assert.fail('No model calls in dry-run') };
  const team = async () => assert.fail('No team execution in dry-run');
  const logs = [];
  for (const args of [{ options: { ...options, dryRun: true }, env: {} }, { options, env: { DRY_RUN: 'true' } }]) {
    const result = await reviewLocal({ ...args, client, team, log: value => logs.push(value) });
    assert.equal(result.status, 'preview');
  }
  assert.equal(fs.existsSync(options['output-dir']), false);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), before);
  assert.ok(logs.some(line => line.includes('No model calls or saved state')));
});

function completedTeam(calls) {
  return async options => {
    calls.push({ stage: options.stage, revision: options.pr.revision, results: structuredClone(options.results) });
    const result = { stage: options.stage, revision: options.pr.revision, status: 'completed',
      roles: [{ role: options.stage === 'planning' ? 'planner' : 'triage', status: 'completed', model: 'test/qa', summary: 'Synthetic completed review.' }],
      selectedRunnerIds: [], findings: [], questions: [], candidates: [], limitations: [], cost: 0,
      usage: {}, budget: { calls: calls.length, reservedCostUsd: 0, reservedTokens: 0 }, transcript: [] };
    await options.onCheckpoint(result);
    return result;
  };
}

test('repeated local review reuses durable model stages and a model completion alone cannot pass QA', async t => {
  const { options, repo } = repositoryFixture(t);
  const calls = [];
  const first = await reviewLocal({ options, client: {}, team: completedTeam(calls), log: () => {}, env: {} });
  assert.deepEqual(calls.map(call => call.stage), ['planning', 'completion']);
  assert.equal(first.outcome.status, 'blocked');
  assert.deepEqual(first.results, []);
  assert.match(fs.readFileSync(first.report.path, 'utf8'), /AI QA team/);
  const second = await reviewLocal({ options, client: {}, team: async () => assert.fail('Completed review must not buy a duplicate response'), log: () => {}, env: {} });
  assert.equal(second.key, first.key);
  assert.equal(second.outcome.status, 'blocked');
  const state = JSON.parse(fs.readFileSync(path.join(options['output-dir'], 'state.json'), 'utf8'));
  assert.equal(Object.keys(state.runs).length, 1);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('successful model review preserves a real imported test failure and its exact evidence', async t => {
  const { root, options, head } = repositoryFixture(t);
  const resultsPath = path.join(root, 'results.json');
  const result = { checkId: 'runner-baseline', status: 'failed', details: 'Expected message was incorrect.', counts: { tests: 1, passed: 0, failed: 1, skipped: 0, cancelled: 0 }, evidence: [{ path: 'logs/baseline.log', excerpt: 'AssertionError: expected head-committed' }] };
  fs.writeFileSync(resultsPath, JSON.stringify({ schemaVersion: 1, repository: 'example/app', prNumber: 3, revision: head, results: [result] }));
  const calls = [];
  const run = await reviewLocal({ options: { ...options, results: resultsPath }, client: {}, team: completedTeam(calls), log: () => {}, env: {} });
  assert.equal(run.ai.completion.status, 'completed');
  assert.equal(run.outcome.status, 'failed');
  assert.deepEqual(run.results, [result]);
  assert.deepEqual(calls.find(call => call.stage === 'completion').results, [result]);
  assert.match(fs.readFileSync(run.report.path, 'utf8'), /Expected message was incorrect|AssertionError/);
});

test('local CLI options reject unknown or incomplete flags and accept explicit model selection', () => {
  assert.deepEqual(parseArgs(['--repo', '/tmp/app', '--head', 'release', '--model', 'test/qa', '--dry-run']), { repo: '/tmp/app', head: 'release', model: 'test/qa', dryRun: true });
  for (const argv of [['--api-key', 'do-not-save'], ['--head'], ['--repo', '--dry-run'], ['unflagged']]) assert.throws(() => parseArgs(argv), /Unknown or incomplete/);
});
