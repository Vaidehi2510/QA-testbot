const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executePlan, parseTap, runnerCommand, runProcess, readRevision, snapshotCheckout } = require('../src/executor');
const { dispatchExecution } = require('../src/dispatch');
const { prepare } = require('../src/prepare-execution');

const fixture = path.resolve(__dirname, '../fixtures/tiny-app');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-executor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'app');
  fs.cpSync(fixture, cwd, { recursive: true });
  const runner = { id: 'baseline', type: 'node-test', baseline: true, files: ['calculator.test.js'], timeoutMs: 10000 };
  return { cwd, outputDir: path.join(root, 'results'), allowLocal: true, isolation: 'process', config: { runners: [runner] }, plan: { checks: [{ id: 'shipping', method: 'automated', runner: 'baseline', required: true }] }, metadata: { repository: 'example/synthetic', prNumber: 1, revision: 'a'.repeat(40), environment: 'synthetic-fixture', runId: 'fixture-run', attempt: 1, fixture: true } };
}

test('real node test runner passes the documented synthetic shipping requirements', async (t) => {
  const options = setup(t);
  const run = await executePlan(options);
  assert.equal(run.results[0].status, 'passed');
  assert.equal(run.results[0].counts.tests, 4);
  assert.equal(run.revision, options.metadata.revision);
  assert.equal(run.execution.fixture, true);
  assert.match(fs.readFileSync(path.join(options.outputDir, run.results[0].evidence[0].path), 'utf8'), /threshold ship free/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.outputDir, 'results.json'), 'utf8')), run);
});

test('execution detects an intentionally introduced boundary defect with assertion evidence', async (t) => {
  const options = setup(t);
  const file = path.join(options.cwd, 'calculator.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('amount >= 100', 'amount > 100'));
  const run = await executePlan(options);
  assert.equal(run.results[0].status, 'failed');
  assert.equal(run.results[0].counts.failed, 1);
  assert.match(run.results[0].evidence[0].excerpt, /ERR_ASSERTION|AssertionError/);
});

test('npm script runner consumes TAP produced by a real configured test script', async (t) => {
  const options = setup(t);
  options.config.runners[0] = { id: 'baseline', type: 'npm-script', script: 'test', format: 'tap' };
  assert.equal((await executePlan(options)).results[0].status, 'passed');
});

test('zero tests, missing TAP, skipped tests and incomplete output never pass', async (t) => {
  const cases = [
    ['', 'execution_error'],
    ["console.log('TAP version 13\\n1..0');", 'execution_error'],
    ["console.log('TAP version 13\\nok 1 - placeholder # SKIP\\n1..1');", 'skipped'],
    ["console.log('TAP version 13\\nok 1 - partial\\n1..2');", 'execution_error'],
  ];
  for (const [source, expected] of cases) {
    const options = setup(t);
    fs.writeFileSync(path.join(options.cwd, 'report.js'), source);
    fs.writeFileSync(path.join(options.cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node report.js' } }));
    options.config.runners[0] = { id: 'baseline', type: 'npm-script', script: 'test', format: 'tap' };
    assert.equal((await executePlan(options)).results[0].status, expected);
  }
});

test('timeout terminates the runner and records execution error', async (t) => {
  const options = setup(t);
  fs.writeFileSync(path.join(options.cwd, 'calculator.test.js'), 'setInterval(() => {}, 1000);');
  options.config.runners[0].timeoutMs = 150;
  const run = await executePlan(options);
  assert.equal(run.results[0].status, 'execution_error');
  assert.match(run.results[0].details, /timeout/);
});

test('only supported trusted runners execute; human checks do not pause independent checks', async (t) => {
  const options = setup(t);
  options.plan.checks.unshift({ id: 'visual', method: 'human', required: true }, { id: 'browser', method: 'unsupported', required: true });
  options.plan.checks.push({ id: 'rogue', method: 'automated', runner: 'from-pr', command: 'echo fake success' });
  const run = await executePlan(options);
  assert.deepEqual(run.results.map(({ status }) => status), ['passed', 'execution_error']);
  assert.deepEqual(run.results.map(({ checkId }) => checkId), ['shipping', 'rogue']);
});

test('trusted test globs expand deterministically and fail when no files match', (t) => {
  const { cwd } = setup(t);
  assert.deepEqual(runnerCommand({ type: 'node-test', files: ['*.test.js'] }, cwd).args, ['--test', '--test-reporter=tap', '--', 'calculator.test.js']);
  assert.throws(() => runnerCommand({ type: 'node-test', files: ['missing/*.test.js'] }, cwd), /zero files/);
});

test('PR-controlled filenames beginning with a dash cannot inject runner options', async (t) => {
  const options = setup(t);
  fs.renameSync(path.join(options.cwd, 'calculator.test.js'), path.join(options.cwd, '--calculator.test.js'));
  options.config.runners[0].files = ['*.test.js'];
  const run = await executePlan(options);
  assert.equal(run.results[0].status, 'execution_error');
  assert.match(run.results[0].details, /Unsafe test path argument/);
});

test('local execution requires fixture provenance and explicit caller opt-in', async (t) => {
  const options = setup(t);
  await assert.rejects(executePlan({ ...options, allowLocal: false }), /explicitly trusted fixtures/);
  await assert.rejects(executePlan({ ...options, metadata: { ...options.metadata, fixture: false } }), /explicitly trusted fixtures/);
});

test('test path traversal and shell option injection are rejected', (t) => {
  const { cwd } = setup(t);
  for (const filename of ['../secret.js', '/tmp/secret.js', '--eval=attack', 'bad\\path.js']) {
    assert.throws(() => runnerCommand({ type: 'node-test', files: [filename] }, cwd), /explicit relative test files/);
  }
  assert.throws(() => runnerCommand({ type: 'npm-script', script: 'test; touch injected', format: 'tap' }, cwd), /Invalid trusted/);
});

test('PR test file symlinks cannot escape the target checkout', (t) => {
  const { cwd } = setup(t);
  fs.symlinkSync(__filename, path.join(cwd, 'escape.js'));
  assert.throws(() => runnerCommand({ type: 'node-test', files: ['escape.js'] }, cwd), /escapes checkout/);
});

test('fixture child environment excludes integration credentials and NODE_OPTIONS', async (t) => {
  const options = setup(t);
  const previous = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = 'secret-synthetic-canary';
  t.after(() => previous === undefined ? delete process.env.SLACK_WEBHOOK_URL : process.env.SLACK_WEBHOOK_URL = previous);
  const run = await runProcess(process.execPath, ['-e', 'console.log(process.env.SLACK_WEBHOOK_URL || "absent")'], { cwd: options.cwd, timeoutMs: 1000 });
  assert.equal(run.output.trim(), 'absent');
});

test('output overflow and missing executable are explicit execution errors', async (t) => {
  const { cwd } = setup(t);
  const oversized = await runProcess(process.execPath, ['-e', 'console.log("x".repeat(10000))'], { cwd, timeoutMs: 1000, maxOutput: 100 });
  assert.equal(oversized.overflow, true);
  const missing = await runProcess('qa-command-does-not-exist', [], { cwd, timeoutMs: 1000 });
  assert.match(missing.error, /ENOENT/);
});

test('contradictory and cancelled TAP output cannot become success', () => {
  assert.equal(parseTap('TAP version 13\nnot ok 1 - failed\n1..1\n# tests 1\n# pass 1\n# fail 0\n').valid, false);
  assert.equal(parseTap('TAP version 13\nBail out! crashed\n1..0\n').valid, false);
  assert.equal(parseTap('TAP version 13\nok 1 - omitted # SKIP\n1..1\n# tests 1\n# pass 1\n# skipped 0\n').valid, false);
  const canceled = parseTap('TAP version 13\nnot ok 1 - interrupted\n1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 1\n');
  assert.equal(canceled.cancelled, 1);
});

test('dispatch is opt-in and DRY_RUN never calls GitHub', async () => {
  const calls = [];
  const options = { gh: { rest: { actions: { createWorkflowDispatch: async (request) => calls.push(request) } } }, owner: 'bot', repo: 'qa', requestKey: 'a'.repeat(64) };
  assert.equal((await dispatchExecution(options)).dispatched, false);
  assert.equal((await dispatchExecution({ ...options, enabled: true, dryRun: true })).dispatched, false);
  assert.equal(calls.length, 0);
  assert.equal((await dispatchExecution({ ...options, enabled: true })).dispatched, true);
  assert.deepEqual(calls[0].inputs, { request_key: options.requestKey });
});

test('actual git revision is verified and dirty or stale source is rejected', (t) => {
  const { cwd } = setup(t);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=QA Fixture', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  assert.equal(readRevision(cwd, { revision }), revision);
  assert.throws(() => readRevision(cwd, { revision: '0'.repeat(40) }), /differs/);
  fs.appendFileSync(path.join(cwd, 'calculator.js'), '\n// modified after commit\n');
  assert.throws(() => readRevision(cwd, { revision }), /clean/);
});

test('local container source snapshots exclude Git metadata and preserve source', (t) => {
  const { cwd } = setup(t);
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, '.git', 'config'), 'synthetic credential canary');
  const snapshot = snapshotCheckout(cwd);
  t.after(() => fs.rmSync(snapshot.root, { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(snapshot.source, '.git')), false);
  assert.equal(fs.readFileSync(path.join(snapshot.source, 'calculator.js'), 'utf8'), fs.readFileSync(path.join(cwd, 'calculator.js'), 'utf8'));
});

test('trusted preparation persists exact source attestation and forces container mode', async (t) => {
  const options = setup(t);
  const previousOwner = process.env.TARGET_OWNER;
  const previousRepo = process.env.TARGET_REPO;
  process.env.TARGET_OWNER = 'example';
  process.env.TARGET_REPO = 'synthetic';
  t.after(() => {
    previousOwner === undefined ? delete process.env.TARGET_OWNER : process.env.TARGET_OWNER = previousOwner;
    previousRepo === undefined ? delete process.env.TARGET_REPO : process.env.TARGET_REPO = previousRepo;
  });
  const request = { plan: options.plan, config: options.config, metadata: options.metadata };
  const calls = [];
  const gh = { rest: { repos: { getContent: async () => ({ data: { encoding: 'base64', size: 200, content: Buffer.from(JSON.stringify(request)).toString('base64') } }) } } };
  const target = { rest: { repos: { downloadTarballArchive: async (args) => { calls.push(args); return { data: Buffer.from('synthetic archive') }; } } } };
  await prepare({ gh, target, botRepository: 'bot/qa', requestKey: 'b'.repeat(64), outputDir: options.outputDir });
  assert.equal(calls[0].ref, options.metadata.revision);
  const saved = JSON.parse(fs.readFileSync(path.join(options.outputDir, 'request.json'), 'utf8'));
  assert.equal(saved.metadata.fixture, false);
  assert.equal(saved.config.execution.isolation, 'container');
  const attestation = JSON.parse(fs.readFileSync(path.join(options.outputDir, 'source.json'), 'utf8'));
  assert.match(attestation.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(readRevision(options.cwd, saved.metadata, path.join(options.outputDir, 'source.json')), saved.metadata.revision);
  await assert.rejects(prepare({ gh, target, botRepository: 'bot/qa', requestKey: '../untrusted', outputDir: options.outputDir }), /Invalid persisted/);
});

test('archive unpacking rejects traversal and symbolic links before executing source', (t) => {
  const { cwd } = setup(t);
  const unpackScript = path.resolve(__dirname, '../src/unpack-source.py');
  const testScript = `
import hashlib, importlib.util, io, json, pathlib, tarfile
spec = importlib.util.spec_from_file_location('unpack', ${JSON.stringify(unpackScript)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = pathlib.Path(${JSON.stringify(cwd)})
for index, name in enumerate(['root/../../escape', 'root/link', 'root/safe.js']):
    archive = root / ('source' + str(index) + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as output:
        entry = tarfile.TarInfo(name)
        if index == 1:
            entry.type = tarfile.SYMTYPE
            entry.linkname = '/etc/passwd'
            output.addfile(entry)
        else:
            entry.size = 4
            output.addfile(entry, io.BytesIO(b'test'))
    attestation = root / ('source' + str(index) + '.json')
    attestation.write_text(json.dumps({'sourceSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))
    try:
        module.unpack(archive, attestation, root / ('out' + str(index)))
        assert index == 2, 'unsafe archive accepted'
    except ValueError:
        assert index != 2, 'safe archive rejected'
`;
  const result = spawnSync('python3', ['-B', '-c', testScript], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
