const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { reviewLocal } = require('../src/ai/review');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-local-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, 'product');
  await fs.mkdir(repositoryPath);
  const git = (...args) => execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'qa-test@example.test');
  git('config', 'user.name', 'QA Test');
  await fs.writeFile(path.join(repositoryPath, 'app.js'), 'module.exports = value => value;\n');
  await fs.mkdir(path.join(repositoryPath, 'test'));
  await fs.writeFile(path.join(repositoryPath, 'test/app.test.js'), 'assert.equal(app(1), 1);\n');
  git('add', '.'); git('commit', '-qm', 'Initial fixture');
  git('checkout', '-qb', 'feature');
  await fs.writeFile(path.join(repositoryPath, 'app.js'), 'module.exports = value => Math.max(0, value);\n');
  git('add', '.'); git('commit', '-qm', 'Reject negative quantities');
  const revision = git('rev-parse', 'HEAD');
  const config = { environment: 'synthetic', runners: [
    { id: 'baseline', type: 'node-test', baseline: true, files: ['test/app.test.js'] },
    { id: 'boundary', type: 'node-test', files: ['test/boundary.test.js'] },
  ], ai: { enabled: true, model: 'test/qa' } };
  const configFile = path.join(root, 'config.json'), rulesFile = path.join(root, 'rules.json'), description = path.join(root, 'description.txt');
  await fs.writeFile(configFile, JSON.stringify(config));
  await fs.writeFile(rulesFile, '[]');
  await fs.writeFile(description, 'Negative quantities must be rejected.');
  const options = { repo: repositoryPath, base: 'main', head: 'HEAD', repository: 'example/product', pr: '42', config: configFile, rules: rulesFile,
    'description-file': description, 'output-dir': path.join(root, 'output') };
  const calls = [];
  const team = async request => {
    calls.push({ stage: request.stage, results: structuredClone(request.results), prior: structuredClone(request.prior) });
    const result = { status: 'completed', stage: request.stage, revision: request.pr.revision, analysisKey: request.analysisKey,
      roles: [{ role: request.stage === 'planning' ? 'planner' : 'triage', model: 'test/qa', status: 'completed', summary: 'Reviewed supplied evidence.' }],
      selectedRunnerIds: request.stage === 'planning' ? ['boundary'] : [], findings: [], questions: [], candidates: [], limitations: [],
      usage: { totalTokens: 100 }, cost: 0.01, budget: { calls: (request.prior?.budget?.calls || 0) + 1, reservedCostUsd: 0.1, reservedTokens: 1000 } };
    await request.onCheckpoint(result);
    return result;
  };
  const run = overrides => reviewLocal({ options: { ...options, ...overrides }, team, log: () => {}, env: {} });
  async function writeResults(results, changes = {}) {
    const filename = path.join(root, 'results.json');
    await fs.writeFile(filename, JSON.stringify({ schemaVersion: 1, repository: 'example/product', prNumber: 42, revision, results, ...changes }));
    return filename;
  }
  return { root, options, revision, calls, run, writeResults, team };
}
const passing = checkId => ({ checkId, status: 'passed', counts: { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 } });

test('local resume imports evidence for AI-selected trusted runners and avoids rerunning planning', async t => {
  const f = await fixture(t);
  const first = await f.run();
  const selected = first.plan.checks.find(check => check.runner === 'boundary');
  assert.ok(selected.id.startsWith('ai-runner-'));
  assert.equal(first.outcome.status, 'blocked');
  const filename = await f.writeResults([passing('runner-baseline'), passing(selected.id)]);
  const second = await f.run({ results: filename });
  assert.equal(second.key, first.key);
  assert.equal(second.outcome.status, 'passed');
  assert.equal(second.results.length, 2);
  assert.deepEqual(f.calls.map(call => call.stage), ['planning', 'completion', 'completion']);
  assert.equal(f.calls[2].results.length, 2);
  assert.equal(second.ai.completion.budget.calls, 3);
  assert.ok(second.limitations.some(value => value.includes('provenance was not independently verified')));
  await f.run({ results: filename });
  assert.equal(f.calls.length, 3);
});

test('malformed, stale, duplicate, count-free, zero-test, and contradictory passes fail before any model call', async t => {
  const f = await fixture(t);
  const variants = [
    { results: [null] }, { results: [passing('runner-baseline'), passing('runner-baseline')] },
    { results: [{ checkId: 'runner-baseline', status: 'passed' }] },
    { results: [{ ...passing('runner-baseline'), counts: { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 } }] },
    { results: [{ ...passing('runner-baseline'), counts: { tests: 1, passed: 1, failed: 1, skipped: 0, cancelled: 0 } }] },
    { results: [{ ...passing('runner-baseline'), counts: { tests: 1, passed: 0, failed: 0, skipped: 1, cancelled: 0 } }] },
    { results: [{ ...passing('runner-baseline'), counts: { tests: 1, passed: 0, failed: 0, skipped: 0, cancelled: 1 } }] },
    { results: [{ ...passing('runner-baseline'), counts: { tests: 1, passed: 2, failed: -1, skipped: 0, cancelled: 0 } }] },
    { results: [{ ...passing('runner-baseline'), revision: 'b'.repeat(40) }] },
    { results: [passing('runner-baseline')], revision: 'b'.repeat(40) },
    { results: [passing('runner-baseline')], repository: 'other/product' },
    { results: [passing('runner-baseline')], prNumber: 43 },
  ];
  for (const { results, ...changes } of variants) {
    const filename = await f.writeResults(results, changes);
    await assert.rejects(f.run({ results: filename }), /Imported|imported|match/);
  }
  assert.equal(f.calls.length, 0);
});

test('unknown imported checks are rejected after trusted planning but before completion review', async t => {
  const f = await fixture(t);
  const filename = await f.writeResults([passing('untrusted-command')]);
  await assert.rejects(f.run({ results: filename }), /unexpected imported/);
  assert.deepEqual(f.calls.map(call => call.stage), ['planning']);
});

test('new imported results clear previous successful review before a failing triage can checkpoint', async t => {
  const f = await fixture(t);
  const first = await f.run();
  const selected = first.plan.checks.find(check => check.runner === 'boundary');
  const filename = await f.writeResults([passing('runner-baseline'), passing(selected.id)]);
  const completed = await f.run({ results: filename });
  assert.equal(completed.outcome.status, 'passed');
  await f.writeResults([{ checkId: 'runner-baseline', status: 'failed', counts: { tests: 1, passed: 0, failed: 1, skipped: 0, cancelled: 0 } }, passing(selected.id)]);
  await assert.rejects(reviewLocal({ options: { ...f.options, results: filename }, log: () => {}, env: {},
    team: async request => { assert.equal(request.stage, 'completion'); throw new Error('Provider unavailable'); } }), /Provider unavailable/);
  const state = JSON.parse(await fs.readFile(path.join(f.options['output-dir'], 'state.json'), 'utf8'));
  const persisted = state.runs[completed.key];
  assert.equal(persisted.outcome.status, 'failed');
  assert.equal(persisted.ai.completion, undefined);
  assert.equal(persisted.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'blocked');
});
