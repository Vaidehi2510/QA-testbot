const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { reviewLocal, parseArgs } = require('../src/ai/review');
const { executeWebCheck } = require('../src/web/execute');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, runners = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-ai-web-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'product');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src/view.js'), 'module.exports = "product source remains untouched";\n');
  await fs.writeFile(path.join(repo, 'README.md'), 'The configured preview must expose the checkout action at mobile and desktop sizes.\n');
  git(repo, 'init', '--quiet'); git(repo, 'add', '--all');
  git(repo, '-c', 'user.name=QA Browser Fixture', '-c', 'user.email=qa-browser@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const config = { environment: 'synthetic', runners, specificationPaths: ['README.md'], ai: { enabled: true, model: 'test/qa', allowImages: true } };
  const suite = { targetEnvironment: 'preview', url: 'https://pr-{pr}.example.test', pages: ['/checkout'], viewports: [{ name: 'mobile', width: 390, height: 844 }] };
  const configFile = path.join(root, 'config.json'), suiteFile = path.join(root, 'suite.json'), rulesFile = path.join(root, 'rules.json');
  await fs.writeFile(configFile, JSON.stringify(config)); await fs.writeFile(suiteFile, JSON.stringify(suite)); await fs.writeFile(rulesFile, '[]');
  const options = { repo, base: revision, head: revision, repository: 'owner/product', pr: '7', config: configFile, rules: rulesFile,
    'web-suite': suiteFile, 'output-dir': path.join(root, 'bot-reports') };
  return { root, repo, revision, config, suite, options };
}
function fakeTeam(calls, candidates = []) {
  return async args => {
    calls.push({ stage: args.stage, results: structuredClone(args.results), screenshots: structuredClone(args.pr.screenshots), plan: structuredClone(args.plan), trustedRunners: structuredClone(args.trustedRunners) });
    const result = { stage: args.stage, revision: args.pr.revision, status: 'completed', roles: [], selectedRunnerIds: [], findings: [], questions: [], candidates,
      limitations: [], usage: {}, cost: 0, budget: { calls: calls.length, reservedCostUsd: 0, reservedTokens: 0 }, transcript: [] };
    await args.onCheckpoint(result);
    return result;
  };
}
function fakeBrowser(calls, status = 'failed', { screenshot = false } = {}) {
  return async args => {
    calls.push(args);
    await fs.mkdir(args.outputDir, { recursive: true });
    await fs.writeFile(path.join(args.outputDir, 'audit.json'), JSON.stringify({ fixture: true, status }));
    const screenshots = [];
    if (screenshot) {
      const sha256 = crypto.createHash('sha256').update(png).digest('hex');
      const filename = `screenshots/${sha256}.png`;
      await fs.mkdir(path.join(args.outputDir, 'screenshots'));
      await fs.writeFile(path.join(args.outputDir, filename), png);
      screenshots.push({ name: 'mobile checkout', path: filename, sha256, mimeType: 'image/png', revision: args.metadata.revision, checkId: args.checkId });
    }
    return { schemaVersion: 1, ...args.metadata, checkId: args.checkId,
      result: { checkId: args.checkId, status, counts: { tests: 2, passed: status === 'passed' ? 2 : 1, failed: status === 'failed' ? 1 : 0, skipped: status === 'blocked' ? 1 : 0, cancelled: 0 },
        details: status === 'failed' ? 'Checkout overflows the mobile viewport.' : status === 'blocked' ? 'Deployed revision could not be established.' : 'Two configured browser assertions passed.',
        evidence: [{ type: 'browser', path: 'audit.json', excerpt: status }] }, screenshots,
      limitations: status === 'blocked' ? ['Images withheld: preview deployment identity was not established.'] : [] };
  };
}

test('local web suite is planned and executed by the bot; a failed UI check survives completed AI review without product changes', async t => {
  const { repo, revision, options, suite } = await fixture(t);
  const teamCalls = [], browserCalls = [];
  const source = await fs.readFile(path.join(repo, 'src/view.js'), 'utf8');
  const candidate = { id: 'suggestion-only', title: 'Add checkout regression', filename: 'src/view.js', source: 'throw new Error("never execute or apply")', assertion: 'Checkout fits mobile width', requirement: 'README.md' };
  const run = await reviewLocal({ options, client: {}, team: fakeTeam(teamCalls, [candidate]), webRunner: fakeBrowser(browserCalls, 'failed', { screenshot: true }), log: () => {}, env: {} });
  assert.equal(browserCalls.length, 1);
  assert.equal(browserCalls[0].checkId, 'runner-ui-tests');
  assert.equal(browserCalls[0].metadata.revision, revision);
  assert.deepEqual(browserCalls[0].suite, suite);
  assert.ok(run.plan.checks.some(check => check.id === 'runner-ui-tests' && check.method === 'automated' && check.runner === 'ui-tests'));
  assert.equal(teamCalls[0].trustedRunners.find(runner => runner.id === 'ui-tests').type, 'web-preview');
  assert.equal(run.ai.completion.status, 'completed');
  assert.equal(run.outcome.status, 'failed');
  assert.equal(run.results[0].status, 'failed');
  assert.equal(teamCalls.find(call => call.stage === 'completion').results[0].status, 'failed');
  assert.equal(teamCalls.find(call => call.stage === 'completion').screenshots[0].revision, revision);
  assert.equal(await fs.readFile(path.join(repo, 'src/view.js'), 'utf8'), source);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');
  const candidates = await fs.readdir(path.join(options['output-dir'], 'candidates', run.key));
  assert.equal(candidates.length, 1);
  assert.match(candidates[0], /^[a-f0-9]+\.json$/);
});

test('an existing configured UI runner stays intact when the CLI adds its dedicated preview suite', async t => {
  const { options } = await fixture(t, [{ id: 'ui-tests', type: 'node-test', files: ['test/ui.js'], required: false }]);
  const teamCalls = [], browserCalls = [];
  const run = await reviewLocal({ options, client: {}, team: fakeTeam(teamCalls), webRunner: fakeBrowser(browserCalls, 'passed'), log: () => {}, env: {} });
  assert.equal(browserCalls[0].checkId, 'runner-web-preview-cli');
  const configured = teamCalls[0].trustedRunners;
  assert.equal(configured.find(runner => runner.id === 'ui-tests').type, 'node-test');
  assert.equal(configured.find(runner => runner.id === 'web-preview-cli').type, 'web-preview');
  assert.ok(run.plan.checks.some(check => check.id === 'runner-web-preview-cli'));
});

test('web-suite dry-run launches no browser or model and creates no durable files', async t => {
  const { options, repo } = await fixture(t);
  const preview = await reviewLocal({ options: { ...options, dryRun: true }, env: {}, log: () => {}, client: {},
    team: async () => assert.fail('Dry-run called a model'), webRunner: async () => assert.fail('Dry-run launched a browser') });
  assert.equal(preview.status, 'preview');
  assert.ok(preview.plan.checks.some(check => check.runner === 'ui-tests'));
  await assert.rejects(fs.stat(options['output-dir']), error => error.code === 'ENOENT');
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(parseArgs(['--web-suite', 'bot-suite.json', '--dry-run'])['web-suite'], 'bot-suite.json');
});

test('browser review output cannot point into the product checkout directly or through a symlink', async t => {
  const { root, repo, options } = await fixture(t);
  const alias = path.join(root, 'product-alias');
  await fs.symlink(repo, alias);
  for (const output of [repo, path.join(repo, 'new', 'reports'), path.join(alias, 'reports')]) {
    await assert.rejects(reviewLocal({ options: { ...options, 'output-dir': output }, env: {}, log: () => {}, client: {},
      team: async () => assert.fail('Invalid output destination reached the model'), webRunner: async () => assert.fail('Invalid output destination launched a browser') }), /outside the product repository/);
  }
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('same-revision local web review resumes saved browser and model evidence without duplicate executions', async t => {
  const { options } = await fixture(t);
  const teamCalls = [], browserCalls = [];
  const first = await reviewLocal({ options, env: {}, log: () => {}, client: {}, team: fakeTeam(teamCalls), webRunner: fakeBrowser(browserCalls, 'passed') });
  const resumed = await reviewLocal({ options, env: {}, log: () => {}, client: {},
    team: async () => assert.fail('Model stage was already completed'), webRunner: async () => assert.fail('Browser suite was already executed') });
  assert.equal(resumed.key, first.key);
  assert.equal(browserCalls.length, 1);
  assert.equal(teamCalls.length, 2);
  assert.deepEqual(resumed.results, first.results);
  assert.equal(resumed.outcome.status, 'passed');
});

test('unverified preview identity and missing configured baseline evidence keep QA blocked', async t => {
  const preview = await fixture(t);
  const calls = [];
  const blocked = await reviewLocal({ options: preview.options, env: {}, log: () => {}, client: {}, team: fakeTeam(calls), webRunner: fakeBrowser([], 'blocked') });
  assert.equal(blocked.ai.completion.status, 'completed');
  assert.equal(blocked.outcome.status, 'blocked');
  assert.equal(calls.find(call => call.stage === 'completion').screenshots.length, 0);
  assert.match(blocked.limitations.join(' '), /deployment identity/);

  const baseline = await fixture(t, [{ id: 'unit', type: 'node-test', baseline: true, files: ['test/unit.js'] }]);
  const incomplete = await reviewLocal({ options: baseline.options, env: {}, log: () => {}, client: {}, team: fakeTeam([]), webRunner: fakeBrowser([], 'passed') });
  assert.equal(incomplete.results.find(result => result.checkId === 'runner-ui-tests').status, 'passed');
  assert.equal(incomplete.outcome.status, 'blocked');
  assert.equal(incomplete.outcome.checkResults.find(result => result.checkId === 'runner-unit').status, 'blocked');
});

test('browser worker request carries suite and exact identity without model keys, integration keys, or source snapshots', async t => {
  const { root, revision, suite } = await fixture(t);
  const outputDir = path.join(root, 'worker-output');
  const metadata = { repository: 'owner/product', prNumber: 7, revision };
  const evidence = await executeWebCheck({ suite, metadata, outputDir, checkId: 'ui-tests',
    env: { OPENROUTER_API_KEY: 'MODEL_SECRET_CANARY', LOCAL_MODEL_API_KEY: 'LOCAL_SECRET_CANARY', GITHUB_TOKEN: 'GITHUB_SECRET_CANARY',
      SLACK_BOT_TOKEN: 'SLACK_SECRET_CANARY', GOOGLE_SERVICE_ACCOUNT_JSON: 'DRIVE_SECRET_CANARY', QA_BROWSER_EXECUTABLE: '/reviewed/chromium' },
    processRunner: async (_command, args, execution) => {
      const requestText = await fs.readFile(args[2], 'utf8');
      assert.doesNotMatch(requestText, /SECRET_CANARY|sourceFiles|sourceSnapshot|product source/);
      const request = JSON.parse(requestText);
      assert.deepEqual(request.metadata, metadata);
      assert.equal(request.browserExecutable, '/reviewed/chromium');
      assert.equal(execution.env, undefined);
      await fs.writeFile(path.join(outputDir, 'web-result.json'), JSON.stringify({ schemaVersion: 1, ...metadata, checkId: 'ui-tests',
        result: { checkId: 'ui-tests', status: 'blocked', counts: { tests: 1, passed: 0, failed: 0, skipped: 1, cancelled: 0 }, evidence: [] }, screenshots: [], limitations: ['Synthetic worker fixture'] }));
      return { exitCode: 0 };
    } });
  assert.equal(evidence.result.status, 'blocked');
});
