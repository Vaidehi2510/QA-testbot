const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executePlan, parseTap, runnerCommand, runProcess, readRevision, snapshotCheckout, collectScreenshots, startScreenshotCapture } = require('../src/executor');
const { dispatchExecution } = require('../src/dispatch');
const { prepare } = require('../src/prepare-execution');

const fixture = path.resolve(__dirname, '../fixtures/tiny-app');

test('graceful termination escalates for an unresponsive process and repeats owned-resource cleanup', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  let cleanups = 0;
  const result = await runProcess(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
    cwd: os.tmpdir(), timeoutMs: 500, terminationGraceMs: 200, onStop: () => { cleanups++; },
  });
  assert.match(result.output, /ready/);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(cleanups, 2);
  assert.throws(() => runProcess(process.execPath, [], { cwd: os.tmpdir(), timeoutMs: 100, terminationGraceMs: 99999 }), /grace period/);
});

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

const screenshotPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZz8AAAAASUVORK5CYII=', 'base64');

test('screenshots are content-addressed evidence bound to exact revision and check', (t) => {
  const options = setup(t);
  const directory = path.join(options.cwd, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'checkout-mobile.png'), screenshotPng);
  const collected = collectScreenshots(directory, options.outputDir, { revision: options.metadata.revision, checkId: 'ui-mobile' });
  assert.equal(collected.screenshots.length, 1);
  assert.deepEqual(collected.limitations, []);
  const screenshot = collected.screenshots[0];
  assert.equal(screenshot.revision, options.metadata.revision);
  assert.equal(screenshot.checkId, 'ui-mobile');
  assert.equal(screenshot.mimeType, 'image/png');
  assert.equal(screenshot.name, 'checkout-mobile.png');
  assert.match(screenshot.path, /^screenshots\/[a-f0-9]{64}\.png$/);
  assert.equal(screenshot.sha256, require('node:crypto').createHash('sha256').update(screenshotPng).digest('hex'));
  assert.deepEqual(fs.readFileSync(path.join(options.outputDir, screenshot.path)), screenshotPng);
  assert.equal(collected.totalBytes, screenshotPng.length);
});

test('screenshot capture rejects symlinks, directories, malformed magic and mismatched extensions', (t) => {
  const options = setup(t);
  const directory = path.join(options.cwd, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(options.cwd, 'secret.png'), screenshotPng);
  fs.symlinkSync(path.join(options.cwd, 'secret.png'), path.join(directory, 'linked.png'));
  fs.mkdirSync(path.join(directory, 'nested.png'));
  fs.writeFileSync(path.join(directory, 'fake.png'), 'not an image');
  fs.writeFileSync(path.join(directory, 'wrong.jpg'), screenshotPng);
  fs.writeFileSync(path.join(directory, 'empty.png'), '');
  const result = collectScreenshots(directory, options.outputDir, { revision: 'revision', checkId: 'ui' });
  assert.deepEqual(result.screenshots, []);
  assert.equal(result.limitations.length, 5);
  assert.match(result.limitations.join('\n'), /nonregular|signature/);
  assert.equal(fs.existsSync(path.join(options.outputDir, 'screenshots')), false);
});

test('screenshot byte, pixel and count limits reject oversized evidence before artifact publication', (t) => {
  const options = setup(t);
  const directory = path.join(options.cwd, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'huge.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
  const inflated = Buffer.from(screenshotPng);
  inflated.writeUInt32BE(10000, 16);
  inflated.writeUInt32BE(10000, 20);
  fs.writeFileSync(path.join(directory, 'pixels.png'), inflated);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(directory, `state-${i}.png`), screenshotPng);
  const result = collectScreenshots(directory, options.outputDir, { revision: 'revision', checkId: 'ui' });
  assert.equal(result.screenshots.length, 4);
  assert.equal(result.limitations.length, 3);
  assert.match(result.limitations.join('\n'), /2 MiB|dimensions|budget/);
  const limited = collectScreenshots(directory, options.outputDir, { revision: 'revision', checkId: 'ui-2', remainingBytes: screenshotPng.length, remainingCount: 1 });
  assert.equal(limited.screenshots.length, 1);
  assert.equal(limited.totalBytes, screenshotPng.length);
});

test('capture directories cannot be replaced with symlinks and excessive entries are bounded', (t) => {
  const options = setup(t);
  const directory = path.join(options.cwd, 'evidence');
  fs.mkdirSync(directory);
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(directory, `text-${i}`), 'not an image');
  const result = collectScreenshots(directory, options.outputDir, { revision: 'revision', checkId: 'ui' });
  assert.equal(result.limitations.length, 65);
  const link = path.join(options.cwd, 'evidence-link');
  fs.symlinkSync(directory, link);
  assert.match(collectScreenshots(link, options.outputDir, { revision: 'revision', checkId: 'ui' }).limitations[0], /not a regular directory/);
});

test('fixture process screenshot requests stay visibly unsupported and do not imply UI verification', async (t) => {
  const options = setup(t);
  options.config.execution = { captureScreenshots: true };
  const run = await executePlan(options);
  assert.equal(run.results[0].status, 'passed');
  assert.deepEqual(run.screenshots, []);
  assert.match(run.screenshotLimitations[0], /container isolation/);
});

test('screenshot storage is a bounded tmpfs volume kept alive by a separate read-only helper', async (t) => {
  const options = setup(t);
  const commands = [];
  const capture = startScreenshotCapture('reviewed/browser@sha256:abc', {
    control: args => { commands.push(args); return { status: 0 }; },
    processRunner: async (command, args, limits) => {
      commands.push([command, ...args]);
      assert.equal(command, 'docker');
      assert.equal(args[0], 'exec');
      assert.equal(limits.maxOutput, 9 * 1024 * 1024);
      assert.equal(limits.timeoutMs, 15000);
      return { exitCode: 0, output: JSON.stringify({ files: [{ name: 'mobile.png', dataBase64: screenshotPng.toString('base64') }], limitations: [] }) };
    },
  });
  assert.deepEqual(commands[0].slice(0, 2), ['volume', 'create']);
  assert.ok(commands[0].includes('type=tmpfs'));
  assert.ok(commands[0].includes('o=size=8m,nr_inodes=128,uid=1000,gid=1000,mode=0777'));
  assert.equal(commands[1][0], 'run');
  assert.ok(commands[1].includes('--network=none'));
  assert.ok(commands[1].includes('--user=1000:1000'));
  assert.ok(commands[1].includes('--read-only'));
  const mounts = commands[1].filter(value => value.startsWith('type='));
  assert.equal(mounts.length, 1);
  assert.match(mounts[0], /^type=volume,src=qa-screenshots-[a-f0-9]+,dst=\/qa-evidence,readonly,volume-nocopy$/);
  assert.match(capture.mount[1], /^type=volume,src=qa-screenshots-[a-f0-9]+,dst=\/qa-evidence,volume-nocopy$/);
  assert.equal(commands[1].some(value => value.includes('ulimit') || value.includes('/workspace')), false);
  const collected = await capture.collect(options.outputDir, { revision: 'revision', checkId: 'ui' });
  assert.equal(collected.screenshots.length, 1);
  assert.deepEqual(collected.limitations, []);
  assert.equal(capture.cleanup(), true);
  assert.deepEqual(commands.at(-2).slice(0, 2), ['rm', '-f']);
  assert.deepEqual(commands.at(-1).slice(0, 3), ['volume', 'rm', '-f']);
  const count = commands.length;
  capture.cleanup();
  assert.equal(commands.length, count);
});

test('screenshot helper startup failure still removes its container and volume', () => {
  const commands = [];
  assert.throws(() => startScreenshotCapture('reviewed/browser', {
    control: args => { commands.push(args); return { status: args[0] === 'run' ? 1 : 0 }; },
  }), /trusted screenshot reader/);
  assert.deepEqual(commands.at(-2).slice(0, 2), ['rm', '-f']);
  assert.deepEqual(commands.at(-1).slice(0, 3), ['volume', 'rm', '-f']);
});

test('screenshot reader errors and malformed file data remain limitations, never visual evidence', async (t) => {
  const options = setup(t);
  for (const result of [
    { exitCode: 0, output: 'not JSON' },
    { exitCode: 0, output: '{}', overflow: true },
    { exitCode: 1, output: '' },
    { exitCode: 0, output: JSON.stringify({ files: [{ name: '../outside.png', dataBase64: screenshotPng.toString('base64') }], limitations: [] }) },
    { exitCode: 0, output: JSON.stringify({ files: [{ name: 'fake.png', dataBase64: Buffer.from('not an image').toString('base64') }], limitations: [] }) },
  ]) {
    const capture = startScreenshotCapture('reviewed/browser', { control: () => ({ status: 0 }), processRunner: async () => result });
    try {
      const collected = await capture.collect(options.outputDir, { revision: 'revision', checkId: 'ui' });
      assert.deepEqual(collected.screenshots, []);
      assert.ok(collected.limitations.length > 0);
    } finally { capture.cleanup(); }
  }
});
