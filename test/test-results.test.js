const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseGoJson, parseVitestJson } = require('../src/test-results');
const { runnerCommand, executePlan } = require('../src/executor');
const events = (...rows) => rows.map(([Action, Test, Package = 'example']) => JSON.stringify({ Action, Package, ...(Test ? { Test } : {}) })).join('\n');
test('Go JSON requires completed test and package events and preserves failures/skips', () => {
  assert.deepEqual(parseGoJson(events(['start'], ['run', 'TestA'], ['pass', 'TestA'], ['pass'])), { valid: true, tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 });
  assert.equal(parseGoJson(events(['start'], ['run', 'TestA'], ['fail', 'TestA'], ['fail'])).failed, 1);
  assert.equal(parseGoJson(events(['start'], ['run', 'TestA'], ['skip', 'TestA'], ['pass'])).skipped, 1);
  assert.equal(parseGoJson(events(['start'], ['fail'])).cancelled, 1);
  for (const text of ['', 'not json', events(['start'], ['pass']), events(['start'], ['run', 'TestA'], ['pass', 'TestA']), events(['start'], ['run', 'TestA'], ['fail', 'TestA'], ['pass']), events(['start'], ['run', 'TestA'], ['pass', 'TestA'], ['pass', 'TestA'], ['pass'])]) assert.equal(parseGoJson(text).valid, false);
});
function vitest(statuses = ['passed']) {
  return { numTotalTests: statuses.length, numPassedTests: statuses.filter(value => value === 'passed').length, numFailedTests: statuses.filter(value => value === 'failed').length, numPendingTests: statuses.filter(value => ['pending', 'skipped'].includes(value)).length, numTodoTests: statuses.filter(value => value === 'todo').length, success: !statuses.includes('failed'), testResults: [{ name: 'example.test.ts', status: statuses.includes('failed') ? 'failed' : 'passed', assertionResults: statuses.map((status, i) => ({ title: `case${i}`, status })) }] };
}
test('Vitest JSON checks assertion counts instead of trusting success summaries', () => {
  assert.deepEqual(parseVitestJson(JSON.stringify(vitest())), { valid: true, tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 });
  const combined = parseVitestJson(JSON.stringify(vitest(['passed', 'failed', 'pending', 'todo'])));
  assert.equal(combined.failed, 1); assert.equal(combined.skipped, 2);
  for (const value of [vitest([]), { ...vitest(), numTotalTests: 9 }, { ...vitest(['failed']), success: true }, { ...vitest(), testResults: [...vitest().testResults, ...vitest().testResults] }]) assert.equal(parseVitestJson(JSON.stringify(value)).valid, false);
  assert.equal(parseVitestJson('noise\n' + JSON.stringify(vitest())).valid, false);
});
test('nested runner directories are confined and Go package arguments cannot inject flags', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-adapters-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'frontend')); fs.writeFileSync(path.join(root, 'frontend/package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const command = runnerCommand({ type: 'npm-script', cwd: 'frontend', script: 'test', format: 'vitest-json' }, root);
  assert.equal(command.cwd, 'frontend'); assert.equal(command.command, 'node'); assert.deepEqual(JSON.parse(command.args.at(-1)), { script: 'test' });
  assert.deepEqual(runnerCommand({ type: 'go-test', packages: ['./internal/...'] }, root).args, ['test', '-json', '-count=1', './internal/...']);
  for (const packages of [['-exec=evil'], ['../outside'], ['./../outside'], ['https://evil.test']]) assert.throws(() => runnerCommand({ type: 'go-test', packages }, root));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape')); assert.throws(() => runnerCommand({ type: 'npm-script', cwd: 'escape', script: 'test', format: 'vitest-json' }, root));
});
test('real process output from a nested JSON runner is evaluated and source stays intact', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-json-run-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'product'); fs.mkdirSync(path.join(cwd, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'frontend/package.json'), JSON.stringify({ scripts: { test: 'node report.cjs' } }));
  const source = `const fs=require('node:fs'); const filename=process.argv.find(value=>value.startsWith('--outputFile=')).slice('--outputFile='.length); fs.writeFileSync(filename,${JSON.stringify(JSON.stringify(vitest(['passed', 'failed'])))}); console.log('JSON report written to '+filename); console.error('Unstructured test diagnostic'); process.exitCode=1;`;
  fs.writeFileSync(path.join(cwd, 'frontend/report.cjs'), source);
  const result = await executePlan({ cwd, outputDir: path.join(root, 'out'), isolation: 'process', allowLocal: true, metadata: { fixture: true, repository: 'example/fixture', prNumber: 1, revision: 'a'.repeat(40), runId: 'fixture', attempt: 1 }, config: { runners: [{ id: 'ui', type: 'npm-script', cwd: 'frontend', script: 'test', format: 'vitest-json' }] }, plan: { checks: [{ id: 'ui-check', runner: 'ui', method: 'automated' }] } });
  assert.equal(result.results[0].status, 'failed'); assert.equal(result.results[0].counts.failed, 1);
  assert.equal(fs.readFileSync(path.join(cwd, 'frontend/report.cjs'), 'utf8'), source);
});

test('Vitest file capture rejects missing, malformed, symlinked, and oversized reports', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vitest-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = {
    missing: "console.log('Tests passed!');",
    malformed: "fs.writeFileSync(filename,'not JSON');",
    symlink: `const outside=require('node:path').join(process.cwd(),'outside.json'); fs.writeFileSync(outside,${JSON.stringify(JSON.stringify(vitest()))}); fs.symlinkSync(outside,filename);`,
    oversized: "fs.writeFileSync(filename,' '.repeat(512*1024));"
  };
  for (const [name, action] of Object.entries(fixtures)) {
    const cwd = path.join(root, name); fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node report.cjs' } }));
    fs.writeFileSync(path.join(cwd, 'report.cjs'), `const fs=require('node:fs'); const filename=process.argv.find(value=>value.startsWith('--outputFile=')).slice('--outputFile='.length); ${action}`);
    const envelope = await executePlan({ cwd, outputDir: path.join(root, `${name}-out`), isolation: 'process', allowLocal: true, metadata: { fixture: true, repository: 'example/fixture', prNumber: 1, revision: 'a'.repeat(40), runId: name, attempt: 1 }, config: { runners: [{ id: 'ui', type: 'npm-script', script: 'test', format: 'vitest-json' }] }, plan: { checks: [{ id: 'ui-check', runner: 'ui', method: 'automated' }] } });
    assert.equal(envelope.results[0].status, 'execution_error', name);
    assert.equal(envelope.results[0].counts, undefined, name);
    assert.match(envelope.results[0].evidence[0].excerpt, /Unable to collect Vitest JSON report/, name);
  }
});

// Opt in with a reviewed, already-built public fixture image containing Go,
// Node, and /opt/qa/node_modules/vitest. No image or dependencies are downloaded
// by this test; the actual test processes run with networking disabled.
test('real Docker Go and TypeScript Vitest suites pass from bounded scratch without changing source', { skip: !process.env.QA_PUBLIC_TEST_IMAGE, timeout: 300000 }, async t => {
  const { spawnSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-public-adapters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'product');
  fs.mkdirSync(path.join(cwd, 'frontend'), { recursive: true });
  const files = {
    'go.mod': 'module example.com/qa-public-fixture\n\ngo 1.26\n',
    'math.go': 'package fixture\nfunc Add(a, b int) int { return a + b }\n',
    'math_test.go': 'package fixture\nimport "testing"\nfunc TestAddition(t *testing.T) { if Add(2,3) != 5 { t.Fatal("incorrect addition") } }\nfunc TestZero(t *testing.T) { if Add(0,0) != 0 { t.Fatal("incorrect zero") } }\n',
    'frontend/package.json': JSON.stringify({ name: 'public-qa-fixture', private: true, type: 'module', scripts: { test: 'vitest run' } }),
    'frontend/vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({test:{include:['*.test.ts'],maxWorkers:1}});\n",
    'frontend/math.test.ts': "import { test, expect } from 'vitest';\ntest('adds synthetic numbers', () => expect(2+3).toBe(5));\ntest('renders a synthetic label', () => expect('Checkout').toMatch(/Check/));\n"
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), contents);
  function git(...args) {
    const result = spawnSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Public QA Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic public test fixture');
  const revision = git('rev-parse', 'HEAD');
  function snapshot(directory, relative = '') {
    return fs.readdirSync(directory).filter(name => name !== '.git').sort().flatMap(name => {
      const filename = path.join(directory, name), entry = path.join(relative, name), stat = fs.lstatSync(filename);
      const content = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? fs.readlinkSync(filename) : createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      return [[entry, stat.mode, content], ...(stat.isDirectory() ? snapshot(filename, entry) : [])];
    });
  }
  const before = snapshot(cwd);
  const envelope = await executePlan({
    cwd, outputDir: path.join(root, 'results'),
    metadata: { repository: 'example/qa-public-fixture', prNumber: 1, revision, runId: 'public-adapters', attempt: 1 },
    config: {
      execution: { image: process.env.QA_PUBLIC_TEST_IMAGE, scratchWorktree: true, scratchMb: 1024, memoryMb: 2048, cpus: 2 },
      runners: [{ id: 'go', type: 'go-test', packages: ['./...'], timeoutMs: 180000 }, { id: 'vitest', type: 'npm-script', cwd: 'frontend', script: 'test', format: 'vitest-json', timeoutMs: 60000 }]
    },
    plan: { checks: [{ id: 'go', runner: 'go', method: 'automated' }, { id: 'vitest', runner: 'vitest', method: 'automated' }] }
  });
  assert.deepEqual(snapshot(cwd), before, 'committed files, modes, and directory tree must remain unchanged');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(envelope.results.length, 2);
  for (const result of envelope.results) {
    assert.equal(result.status, 'passed', `${result.checkId}: ${result.details}\n${result.evidence?.[0]?.excerpt || ''}`);
    assert.deepEqual(result.counts, { tests: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0 });
  }
});
