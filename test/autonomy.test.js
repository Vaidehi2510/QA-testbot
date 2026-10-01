const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runAutonomous } = require('../src/autonomy/run');
const { validateGoals, inventoryTargets, compileCandidates, hash } = require('../src/autonomy/schema');
const { validateWebSuite } = require('../src/web/audit');
const { parseArgs } = require('../src/autonomy/cli');
const { writeJson, outsideProduct } = require('../src/autonomy/store');
const { localProfileModel } = require('../src/ai/settings');
const goals = { schemaVersion: 1, goals: [{ id: 'invalid-email', name: 'Reject an invalid email', start: '/', requirement: 'Submitting an invalid email displays the specified validation message.',
  inputs: { email: 'not-an-email' }, assertions: [{ id: 'error', action: 'expectText', selector: '#error', text: 'Enter a valid email address' }] }] };
const profile = { id: 'fixture:local', contextLength: 100000, tools: true, vision: false };
const ai = { enabled: true, backend: 'local', local: { baseUrl: 'http://127.0.0.1:11434/v1', models: [profile] }, model: profile.id,
  roles: ['planner'], maxToolRounds: 0, maxCallsPerRun: 4, maxCostUsd: 0, maxOutputTokens: 1000 };
const suite = { targetEnvironment: 'preview', url: 'http://127.0.0.1:45678', pages: ['/'], viewports: [{ name: 'desktop', width: 900, height: 700 }], timeoutMs: 500 };
function git(repo, ...args) { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim(); }
async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-autonomy-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'product'); await fs.mkdir(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'qa@example.invalid'); git(repo, 'config', 'user.name', 'QA Fixture');
  await fs.writeFile(path.join(repo, 'app.js'), 'export const validate = email => email.includes("@");\n');
  await fs.writeFile(path.join(repo, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-syntheticsecretsecret\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Synthetic initial revision');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const configPath = path.join(root, 'config.json'), suitePath = path.join(root, 'suite.json'), goalsPath = path.join(root, 'goals.json');
  await fs.writeFile(configPath, JSON.stringify(changes.config || { ai, runners: [] }));
  await fs.writeFile(suitePath, JSON.stringify(changes.suite || suite)); await fs.writeFile(goalsPath, JSON.stringify(changes.goals || goals));
  const options = { repo, base: revision, head: revision, repository: 'fixture/product', pr: '7', product: 'fixture',
    config: configPath, suite: suitePath, goals: goalsPath, 'output-dir': path.join(root, 'bot-output') };
  return { root, repo, revision, options, configPath, suitePath, goalsPath };
}
function browserEvidence({ suite: input, metadata, checkId }, changes = {}) {
  return { schemaVersion: 1, ...metadata, checkId, runId: crypto.randomUUID(), revisionVerified: true, suiteDigest: hash(validateWebSuite(input, metadata)),
    inventory: [{ ...metadata, revisionVerified: true, page: 'http://127.0.0.1:45678/', path: '/', title: 'Synthetic fixture', visibleText: ['Email validation'],
      elements: [{ role: 'textbox', name: 'Email address', selector: '#email', tag: 'input', type: 'text' }, { role: 'button', name: 'Place order', selector: '#buy', tag: 'button', type: 'button' }] }],
    result: { checkId, status: 'passed', counts: { tests: 8, passed: 8, failed: 0, skipped: 0, cancelled: 0 }, details: '8 browser checks passed.' }, repairs: [], screenshots: [], limitations: [], ...changes };
}
function fakeClient({ proposal, price = 0, toolRound = false } = {}) {
  const calls = [];
  return { calls, listModels: async () => [{ ...localProfileModel(profile), pricing: { prompt: price, completion: price, request: 0 } }],
    chat: async request => {
      calls.push(request);
      if (toolRound && calls.length === 1) return { model: profile.id, cost: 0, message: { role: 'assistant', tool_calls: [{ id: 'read-app', type: 'function', function: { name: 'read_file', arguments: '{"path":"app.js"}' } }] } };
      const input = JSON.parse(request.messages[1].content), elements = input.observedPages.flatMap(page => page.elements);
      const steps = [{ action: 'fill', targetId: elements.find(element => element.name === 'Email address').targetId, inputId: 'email' },
        { action: 'click', targetId: elements.find(element => element.name === 'Place order').targetId }, { action: 'assert', assertionId: 'error' }];
      return { model: profile.id, cost: 0, usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 }, finishReason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(proposal || { candidates: [{ goalId: 'invalid-email', steps }], limitations: [] }) } };
    } };
}
const quiet = () => {};

test('autonomous execution validates, independently replays, retains and reuses goal-bound regression journeys without product writes', async t => {
  const f = await fixture(t), client = fakeClient({ toolRound: true });
  await fs.writeFile(f.configPath, JSON.stringify({ ai: { ...ai, maxToolRounds: 1 }, runners: [] }));
  const requests = [], browserRunner = async args => { requests.push(args); return browserEvidence(args); };
  const run = await runAutonomous({ options: f.options, client, browserRunner, log: quiet });
  assert.equal(run.outcome.status, 'passed'); assert.equal(run.autonomy.goals.length, 1); assert.equal(requests.length, 3);
  assert.equal(client.calls.length, 2); assert.equal(run.ai.latest.calls, 2); assert.equal(run.ai.latest.costUsd, 0);
  assert.notEqual(run.autonomy.goals[0].runIds[0], run.autonomy.goals[0].runIds[1]);
  assert.equal(requests[1].suite.journeys[0].steps[2].text, goals.goals[0].assertions[0].text);
  assert.match(client.calls[1].messages.find(message => message.role === 'tool').content, /validate/);
  assert.doesNotMatch(JSON.stringify(client.calls), /syntheticsecretsecret/);
  const persisted = JSON.parse(await fs.readFile(run.report.path, 'utf8')); assert.equal(persisted.key, run.key);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  const cached = await runAutonomous({ options: f.options, client, browserRunner, log: quiet });
  assert.equal(cached.key, run.key); assert.equal(requests.length, 3); assert.equal(client.calls.length, 2);
  await fs.writeFile(path.join(f.repo, 'app.js'), 'export const validate = email => email.includes("@") && email.length > 3;\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'Synthetic revision two');
  const newer = await runAutonomous({ options: { ...f.options, head: git(f.repo, 'rev-parse', 'HEAD') }, client, browserRunner, log: quiet });
  assert.equal(newer.autonomy.goals[0].reused, true); assert.equal(client.calls.length, 2); assert.equal(requests.length, 6);
  const attempt = await runAutonomous({ options: { ...f.options, 'rerun-token': 'explicit-new-attempt' }, client, browserRunner, log: quiet });
  assert.notEqual(attempt.key, run.key); assert.equal(attempt.autonomy.goals[0].reused, true);
});

test('model output cannot invent business assertions, execute code, reference unknown elements, or place assertions before state-changing actions', () => {
  const revision = 'a'.repeat(40), expected = validateGoals(goals);
  const inventory = inventoryTargets(browserEvidence({ suite, metadata: { repository: 'fixture/product', revision, prNumber: 7 }, checkId: 'discover' }).inventory, revision, 'http://127.0.0.1:45678');
  const targetId = [...inventory.targets.keys()][0];
  const invalid = [
    [{ action: 'eval', targetId, value: 'fetch("https://attacker.invalid")' }],
    [{ action: 'assert', assertionId: 'error', text: 'Success' }],
    [{ action: 'click', targetId: 'unknown' }, { action: 'assert', assertionId: 'error' }],
    [{ action: 'fill', targetId, inputId: 'secret-from-env' }, { action: 'assert', assertionId: 'error' }],
    [{ action: 'click', targetId }],
    [{ action: 'assert', assertionId: 'error' }, { action: 'click', targetId }],
  ];
  for (const steps of invalid) assert.throws(() => compileCandidates({ candidates: [{ goalId: 'invalid-email', steps }], limitations: [] }, expected.goals, inventory.targets));
  assert.throws(() => validateGoals({ ...goals, goals: [{ ...goals.goals[0], assertions: [] }] }), /explicit trusted assertions/);
  assert.throws(() => validateGoals({ ...goals, goals: [{ ...goals.goals[0], start: '//other.invalid' }] }));
});

test('failed candidates remain failures, are not retried into passes, and are never retained', async t => {
  const f = await fixture(t), client = fakeClient(), requests = [];
  const run = await runAutonomous({ options: f.options, client, log: quiet, browserRunner: async args => {
    requests.push(args); const output = browserEvidence(args);
    if (args.checkId.startsWith('goal-')) output.result = { ...output.result, status: 'failed', counts: { tests: 8, passed: 7, failed: 1, skipped: 0, cancelled: 0 } };
    return output;
  } });
  assert.equal(run.outcome.status, 'failed'); assert.equal(requests.length, 2); assert.deepEqual(run.autonomy.goals, []);
  assert.equal(run.results.find(result => result.checkId.startsWith('replay-')).status, 'blocked');
  const state = JSON.parse(await fs.readFile(path.join(f.options['output-dir'], 'state.json'))); assert.deepEqual(state.autonomy.regressions, {});
});

test('unbound discovery blocks model calls and all trusted goals, even when a page claims it passed', async t => {
  const f = await fixture(t), client = fakeClient();
  const run = await runAutonomous({ options: f.options, client, log: quiet, browserRunner: async args => browserEvidence(args, { revisionVerified: false }) });
  assert.equal(client.calls.length, 0); assert.equal(run.autonomy.goals.length, 0); assert.notEqual(run.outcome.status, 'passed');
});

test('wrong repository, zero tests, different suite, and repeated execution identity cannot establish regression acceptance', async t => {
  for (const mutation of [value => { value.repository = 'other/tenant'; }, value => { value.result.counts = { tests: 0, passed: 0, failed: 0, skipped: 0 }; },
    value => { value.suiteDigest = 'different-suite'; }, value => { value.runId = '11111111-1111-1111-1111-111111111111'; }, value => { value.revisionVerified = 'false'; }]) {
    const f = await fixture(t), client = fakeClient();
    const run = await runAutonomous({ options: f.options, client, log: quiet, browserRunner: async args => { const value = browserEvidence(args); mutation(value); return value; } });
    assert.notEqual(run.outcome.status, 'passed'); assert.equal(run.autonomy.goals.length, 0);
  }
});

test('a model omission or invalid proposal produces visible blocked coverage instead of fabricated passes', async t => {
  for (const proposal of [{ candidates: [], limitations: ['No known route.'] }, { candidates: [{ goalId: 'invalid-email', steps: [{ action: 'assert', assertionId: 'made-up' }] }], limitations: [] }]) {
    const f = await fixture(t);
    const run = await runAutonomous({ options: f.options, client: fakeClient({ proposal }), browserRunner: async args => browserEvidence(args), log: quiet });
    assert.equal(run.results.find(result => result.checkId === 'goal-invalid-email').status, 'blocked'); assert.equal(run.autonomy.goals.length, 0);
  }
});

test('local model budgets reserve before inference and a costly catalog is refused before a paid request', async t => {
  const f = await fixture(t), client = fakeClient({ price: 0.001 });
  const run = await runAutonomous({ options: f.options, client, browserRunner: async args => browserEvidence(args), log: quiet });
  assert.equal(client.calls.length, 0); assert.equal(run.ai.latest.budget.calls, 0); assert.notEqual(run.outcome.status, 'passed');
  const good = fakeClient(), original = good.chat;
  good.chat = async request => {
    const state = JSON.parse(await fs.readFile(path.join(f.options['output-dir'], 'state.json')));
    assert.equal(Object.values(state.runs).at(-1).ai.latest.budget.calls, 1);
    return original(request);
  };
  await runAutonomous({ options: { ...f.options, 'rerun-token': 'budget-check' }, client: good, browserRunner: async args => browserEvidence(args), log: quiet });
});

test('trusted goal changes invalidate retained journeys, including the exact expected business result', async t => {
  const f = await fixture(t), client = fakeClient();
  await runAutonomous({ options: f.options, client, browserRunner: async args => browserEvidence(args), log: quiet });
  const changed = structuredClone(goals); changed.goals[0].assertions[0].text = 'Use a valid email';
  await fs.writeFile(f.goalsPath, JSON.stringify(changed));
  const requests = [];
  const run = await runAutonomous({ options: f.options, client, log: quiet, browserRunner: async args => { requests.push(args); return browserEvidence(args); } });
  assert.equal(client.calls.length, 2); assert.equal(run.autonomy.goals[0].reused, false);
  assert.equal(requests[1].suite.journeys[0].steps.at(-1).text, 'Use a valid email');
});

test('dry run invokes no models or browsers and rejects product-owned policy and output paths, including symlinks', async t => {
  const f = await fixture(t), never = () => { throw new Error('Unexpected execution'); };
  const run = await runAutonomous({ options: { ...f.options, dryRun: true }, client: { listModels: never }, browserRunner: never, log: quiet });
  assert.equal(run.status, 'preview'); await assert.rejects(fs.stat(f.options['output-dir']), { code: 'ENOENT' });
  await assert.rejects(runAutonomous({ options: { ...f.options, 'output-dir': path.join(f.repo, '.qa') }, log: quiet }), /outside the product/);
  const link = path.join(f.root, 'escaped-output'); await fs.symlink(f.repo, link);
  await assert.rejects(outsideProduct(link, f.repo), /outside the product/);
  await fs.writeFile(path.join(f.repo, 'goals.json'), JSON.stringify(goals));
  await assert.rejects(runAutonomous({ options: { ...f.options, goals: path.join(f.repo, 'goals.json') }, log: quiet }), /outside the product/);
  const owned = path.join(f.root, 'owned'); await fs.mkdir(owned); await fs.symlink(f.repo, path.join(owned, 'escape'));
  await assert.rejects(writeJson(owned, 'escape/write.json', {}), /symbolic links/);
  await assert.rejects(writeJson(owned, '../escape.json', {}), /escapes/);
  await fs.writeFile(f.suitePath, JSON.stringify({ ...suite, visual: { baselineDir: path.join(f.repo, 'baselines') } }));
  await assert.rejects(runAutonomous({ options: { ...f.options, dryRun: true }, log: quiet }), /outside the product/);
});

test('baseline coverage stays blocked without execution and only the explicitly enrolled opt-in dispatches immutable checks', async t => {
  const f = await fixture(t, { config: { ai, runners: [{ id: 'node-tests', type: 'node-test', baseline: true }] } });
  const base = { options: f.options, client: fakeClient(), browserRunner: async args => browserEvidence(args), log: quiet };
  const blocked = await runAutonomous(base); assert.equal(blocked.outcome.status, 'blocked');
  assert.equal(blocked.results.find(result => result.checkId === 'runner-node-tests').status, 'blocked');
  let dispatched;
  const run = await runAutonomous({ ...base, options: { ...f.options, executeBaseline: true }, baselineRunner: async request => {
    dispatched = request; return [{ checkId: 'runner-node-tests', status: 'passed', counts: { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 } }];
  } });
  assert.equal(dispatched.revision, f.revision); assert.equal(dispatched.repo, await fs.realpath(f.repo)); assert.equal(run.outcome.status, 'passed');
});

test('final specialist and triage findings accumulate without reclassifying test evidence as an AI pass', async t => {
  const f = await fixture(t, { config: { ai: { ...ai, roles: ['planner', 'code-review', 'triage'] }, runners: [] } });
  const run = await runAutonomous({ options: f.options, client: fakeClient(), browserRunner: async args => browserEvidence(args), log: quiet,
    team: async ({ prior, config }) => ({ ...prior, status: 'completed', roles: [{ role: config.roles[0] }], findings: [{ severity: 'high', title: config.roles[0], description: 'Requires review' }], questions: [], candidates: [], limitations: [] }) });
  assert.equal(run.ai.latest.findings.length, 2); assert.equal(run.outcome.status, 'awaiting_human');
  assert.equal(run.results.find(result => result.checkId === 'goal-invalid-email').status, 'passed');
});

test('CLI accepts only fixed options and cannot become a shell, bypass policy or silently replace duplicate options', () => {
  assert.deepEqual(parseArgs(['--repo', '/product', '--dry-run', '--execute-baseline']), { repo: '/product', dryRun: true, executeBaseline: true });
  for (const argv of [['--command', 'rm -rf product'], ['--repo'], ['--repo', 'a', '--repo', 'b'], ['--dry-run', '--dry-run']]) assert.throws(() => parseArgs(argv));
});

test('an interrupted baseline is not silently retried, and changing a trusted runner definition creates a new attempt', async t => {
  const f = await fixture(t, { config: { ai, runners: [{ id: 'node-tests', type: 'node-test', baseline: true, files: ['test/*.test.js'] }] } });
  let executions = 0;
  const args = { options: { ...f.options, executeBaseline: true }, client: fakeClient(), browserRunner: async request => browserEvidence(request), log: quiet,
    baselineRunner: async () => { executions++; return [{ checkId: 'runner-node-tests', status: 'passed', counts: { tests: 1, passed: 1, failed: 0, skipped: 0 } }]; } };
  const first = await runAutonomous(args), filename = path.join(f.options['output-dir'], 'state.json');
  const state = JSON.parse(await fs.readFile(filename));
  state.runs[first.key].phase = 'running'; state.runs[first.key].autonomy.baselineCompleted = false;
  await fs.writeFile(filename, JSON.stringify(state));
  const resumed = await runAutonomous(args);
  assert.equal(executions, 1); assert.equal(resumed.results.find(result => result.checkId === 'runner-node-tests').status, 'execution_error');
  await fs.writeFile(f.configPath, JSON.stringify({ ai, runners: [{ id: 'node-tests', type: 'node-test', baseline: true, files: ['additional/*.test.js'] }] }));
  const changed = await runAutonomous(args); assert.notEqual(changed.key, first.key); assert.equal(executions, 2);
});

test('declared preview text and result excerpts redact portal tokens before model access and durable reports', async t => {
  const token = 'pst_0123456789abcdef0123456789abcdef';
  const f = await fixture(t, { config: { ai, runners: [{ id: 'unit', type: 'node-test', baseline: true }] } });
  const results = path.join(f.root, 'results.json');
  await fs.writeFile(results, JSON.stringify({ schemaVersion: 1, repository: 'fixture/product', revision: f.revision, prNumber: 7,
    results: [{ checkId: 'runner-unit', status: 'failed', details: `Token ${token}`, evidence: [{ excerpt: token }] }] }));
  const client = fakeClient();
  const run = await runAutonomous({ options: { ...f.options, results }, client, log: quiet, browserRunner: async args => {
    const evidence = browserEvidence(args); evidence.inventory[0].visibleText.push(token); return evidence;
  } });
  assert.doesNotMatch(JSON.stringify(client.calls), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(run.results), new RegExp(token));
  assert.doesNotMatch(await fs.readFile(run.report.path, 'utf8'), new RegExp(token));
  const unsafe = structuredClone(goals); unsafe.goals[0].inputs.email = token;
  assert.throws(() => validateGoals(unsafe), /synthetic values/);
});

test('an outstanding inference reservation survives interruption and is never repeated as a fresh paid call', async t => {
  const f = await fixture(t), client = fakeClient();
  const args = { options: f.options, client, browserRunner: async request => browserEvidence(request), log: quiet };
  const original = await runAutonomous(args), filename = path.join(f.options['output-dir'], 'state.json');
  const state = JSON.parse(await fs.readFile(filename)), run = state.runs[original.key];
  run.phase = 'running'; run.autonomy.candidates = null; run.autonomy.goals = []; state.autonomy.regressions = {};
  run.ai.latest.transcript[0].status = 'reserved'; run.ai.latest.budget.reservedCostUsd = 0.25;
  await fs.writeFile(filename, JSON.stringify(state));
  const resumed = await runAutonomous(args);
  assert.equal(client.calls.length, 1); assert.equal(resumed.ai.latest.budget.reservedCostUsd, 0.25);
  assert.equal(resumed.ai.latest.calls, 1); assert.equal(resumed.outcome.status, 'execution_error');
  assert.equal(resumed.autonomy.goals.length, 0);
});

test('expanded control inventory exposes only verified opaque navigation targets, not new executable model steps', () => {
  const revision = 'a'.repeat(40), initial = browserEvidence({ suite, metadata: { repository: 'fixture/product', revision, prNumber: 7 }, checkId: 'discover' }).inventory[0];
  const expanded = { ...initial, navigationSteps: [{ action: 'click', selector: '#buy' }], elements: [{ role: 'button', name: 'Confirm', selector: '#confirm' }] };
  const inventory = inventoryTargets([initial, expanded], revision, 'http://127.0.0.1:45678');
  const navigation = inventory.pages[1].navigationSteps;
  assert.equal(navigation.length, 1); assert.equal(navigation[0].action, 'click'); assert.equal(inventory.targets.get(navigation[0].targetId).selector, '#buy');
  assert.equal(navigation[0].selector, undefined);
  assert.deepEqual(inventoryTargets([{ ...expanded, revisionVerified: false }], revision, 'http://127.0.0.1:45678').pages, []);
});

test('a corrupted retained journey cannot keep its goal hash while weakening the trusted assertion', async t => {
  const f = await fixture(t), client = fakeClient();
  const original = await runAutonomous({ options: f.options, client, browserRunner: async request => browserEvidence(request), log: quiet });
  const filename = path.join(f.options['output-dir'], 'state.json'), state = JSON.parse(await fs.readFile(filename));
  const record = state.autonomy.regressions[original.autonomy.policyKey]['invalid-email'];
  record.journey.steps.at(-1).text = 'Anything currently displayed';
  await fs.writeFile(filename, JSON.stringify(state));
  const requests = [];
  const run = await runAutonomous({ options: { ...f.options, 'rerun-token': 'validate-retained-contract' }, client, log: quiet,
    browserRunner: async request => { requests.push(request); return browserEvidence(request); } });
  assert.equal(run.outcome.status, 'blocked'); assert.equal(run.autonomy.goals.length, 0); assert.equal(requests.length, 1); assert.equal(client.calls.length, 1);
  assert.match(run.results.find(result => result.checkId === 'goal-invalid-email').details, /trusted assertion/);
});

test('source snapshots inspect the actual requested commit despite local Git replacement objects and hostile diff helpers', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, 'app.js'), 'export const requestedRevision = true;\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'Actual requested contents');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'replace', head, f.revision);
  const marker = path.join(f.root, 'external-helper-ran'), helper = path.join(f.root, 'untrusted-diff-helper');
  await fs.writeFile(helper, '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o700 });
  git(f.repo, 'config', 'diff.external', helper); git(f.repo, 'config', 'core.fsmonitor', helper);
  const snapshot = await require('../src/ai/snapshot').localSnapshot({ repositoryPath: f.repo, base: f.revision, head, config: { ai: {} } });
  assert.equal(snapshot.revision, head); assert.match(snapshot.sourceFiles.find(file => file.path === 'app.js').content, /requestedRevision/);
  assert.ok(snapshot.files.some(file => file.filename === 'app.js')); await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('real Chromium executes model-proposed tests, retains independent replays, semantically maintains a changed selector, and catches a later product regression',
  { skip: process.env.QA_AUTONOMY_BROWSER_TEST !== '1', timeout: 120000 }, async t => {
    const http = require('node:http');
    const f = await fixture(t, { goals: { ...goals, allowSemanticMaintenance: true } });
    let revision = f.revision, buttonId = 'buy', broken = false;
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'x-qa-revision': revision });
      response.end(`<!doctype html><html lang="en"><head><title>Validation fixture</title><link rel="icon" href="data:,"><style>body{font:18px Arial;color:#111;background:white;margin:24px}main{max-width:600px}input,button{font:inherit;padding:12px}label{display:block;margin:12px 0}</style></head><body><main><h1>Place an order</h1><label for="email">Email address</label><input id="email" type="text"><button id="${buttonId}" type="button">Place order</button><p id="error" role="status"></p><script>document.getElementById('${buttonId}').onclick=()=>{document.getElementById('error').textContent='${broken ? 'Order accepted' : 'Enter a valid email address'}';};</script></main></body></html>`);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    await fs.writeFile(f.suitePath, JSON.stringify({ ...suite, url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1500 }));
    const env = { ...process.env };
    if (!env.QA_BROWSER_EXECUTABLE && process.platform === 'darwin') {
      try { await fs.access(require('playwright-core').chromium.executablePath()); }
      catch { env.QA_BROWSER_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; }
    }
    const client = fakeClient();
    const first = await runAutonomous({ options: f.options, client, env, log: quiet });
    assert.equal(first.outcome.status, 'passed', JSON.stringify(first.results)); assert.equal(first.autonomy.goals.length, 1);
    assert.equal(Object.values(first.autonomy.browser).length, 3); assert.equal(client.calls.length, 1);
    assert.notEqual(first.autonomy.goals[0].runIds[0], first.autonomy.goals[0].runIds[1]);
    buttonId = 'purchase-v2';
    await fs.writeFile(path.join(f.repo, 'app.js'), 'export const buttonId = "purchase-v2";\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'Synthetic selector change');
    revision = git(f.repo, 'rev-parse', 'HEAD');
    const maintained = await runAutonomous({ options: { ...f.options, head: revision }, client, env, log: quiet });
    assert.equal(maintained.outcome.status, 'passed', JSON.stringify(maintained.results)); assert.equal(maintained.autonomy.goals[0].reused, true);
    assert.match(maintained.limitations.join('\n'), /semantic locator repair was retained/); assert.equal(client.calls.length, 1);
    const state = JSON.parse(await fs.readFile(path.join(f.options['output-dir'], 'state.json')));
    const record = Object.values(state.autonomy.regressions)[0]['invalid-email'];
    assert.equal(record.journey.steps[1].role, 'button'); assert.equal(record.journey.steps[1].selector, undefined);
    assert.equal(record.journey.steps[2].text, 'Enter a valid email address');
    broken = true;
    await fs.writeFile(path.join(f.repo, 'app.js'), 'export const acceptInvalidEmail = true;\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'Synthetic business regression');
    revision = git(f.repo, 'rev-parse', 'HEAD');
    const failed = await runAutonomous({ options: { ...f.options, head: revision }, client, env, log: quiet });
    assert.equal(failed.outcome.status, 'failed', JSON.stringify(failed.results)); assert.equal(failed.autonomy.goals.length, 0);
    assert.equal(failed.results.find(result => result.checkId === 'goal-invalid-email').status, 'failed');
    assert.equal(failed.results.find(result => result.checkId === 'replay-invalid-email').status, 'blocked');
    assert.equal(client.calls.length, 1); assert.equal(git(f.repo, 'status', '--porcelain'), '');
  });
