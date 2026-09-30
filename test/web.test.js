const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateWebSuite, browserLaunchOptions, runWebAudit } = require('../src/web/audit');
const { executeWebCheck } = require('../src/web/execute');
const revision = 'a'.repeat(40);
const metadata = { repository: 'owner/product', prNumber: 7, revision };
const suite = { targetEnvironment: 'preview', url: 'https://pr-{pr}.example.test/{sha}', pages: ['/'], viewports: [{ name: 'mobile', width: 390, height: 844 }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-web-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test('browser suites bind trusted preview URLs, paths and explicit expected interactions', () => {
  const parsed = validateWebSuite(suite, metadata);
  assert.equal(parsed.url, `https://pr-7.example.test/${revision}`);
  assert.deepEqual(parsed.allowedOrigins, ['https://pr-7.example.test']);
  assert.equal(parsed.allowMutations, false);
  for (const change of [{ targetEnvironment: 'production' }, { url: 'file:///etc/passwd' }, { url: 'https://user:password@example.test/' },
    { pages: ['//other.test'] }, { pages: ['/\\other.test'] }, { allowedOrigins: ['https://other.test/path'] }, { timeoutMs: Infinity },
    { viewports: [{ name: 'huge', width: 99999, height: 100 }] }, { allowMutations: 'true' }, { revisionHeader: 'a\nb' }]) {
    assert.throws(() => validateWebSuite({ ...suite, ...change }, metadata));
  }
  for (const steps of [[{ action: 'eval', selector: 'body', value: 'fetch("secret")' }], [{ action: 'click', selector: '#purchase' }], [{ action: 'expectUrl', path: '//other.test' }]]) {
    assert.throws(() => validateWebSuite({ ...suite, journeys: [{ name: 'invalid', start: '/', steps }] }, metadata));
  }
});

test('shipped CSS rules select automated UI coverage without imposing routine manual visual signoff', () => {
  const { generatePlan } = require('../src/planner');
  const rules = require('../qa-rules.json');
  const plan = generatePlan({ repository: 'owner/product', number: 7, revision, body: 'Checkout remains readable on mobile and desktop.',
    files: [{ filename: 'checkout.css', patch: '+main { width: 1200px; }' }], specifications: [], existingTests: [] }, rules,
  { runners: [{ id: 'ui-tests', type: 'web-preview', baseline: true, suite }] });
  assert.ok(plan.checks.some(check => check.method === 'automated' && check.runner === 'ui-tests'));
  assert.equal(plan.checks.some(check => check.method === 'human' && check.kind === 'subjective'), false);
});

test('browser starts sandboxed with fresh settings and without inherited integration or model secrets', () => {
  const launch = browserLaunchOptions({ HOME: '/temporary', PATH: '/usr/bin', OPENROUTER_API_KEY: 'sensitive', LOCAL_MODEL_API_KEY: 'sensitive',
    GITHUB_TOKEN: 'sensitive', SLACK_WEBHOOK_URL: 'sensitive', NODE_OPTIONS: '--require=/malicious.js', QA_BROWSER_EXECUTABLE: '/reviewed/chrome' });
  assert.equal(launch.chromiumSandbox, true);
  assert.deepEqual(launch.env, { PATH: '/usr/bin', HOME: '/temporary' });
  assert.equal(launch.executablePath, '/reviewed/chrome');
  assert.doesNotMatch(JSON.stringify(launch), /sensitive|malicious|no-sandbox/);
});

function browserFixture({ servedRevision = revision, overflow = false, violations = [], routeRequest, throwJourney = false } = {}) {
  const frames = {}, handlers = {}, calls = { captured: 0, closed: 0 };
  let route;
  const response = { status: () => 200, headerValue: async () => servedRevision, url: () => 'https://pr-7.example.test/',
    request: () => ({ resourceType: () => 'document' }), frame: () => frames };
  const locator = { click: async () => { if (throwJourney) throw new Error('Expected purchase button is absent'); }, fill: async () => {}, press: async () => {},
    waitFor: async () => {}, filter: () => locator };
  const page = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, mainFrame: () => frames,
    on: (event, handler) => { handlers[event] = handler; }, url: () => 'https://pr-7.example.test/',
    goto: async () => { handlers.response?.(response); if (routeRequest) await route({ request: () => routeRequest, abort: async () => { calls.aborted = true; },
      continue: async () => { calls.continued = true; } }); return response; },
    evaluate: async () => ({ overflow, brokenImages: [], title: 'Checkout' }), screenshot: async () => { calls.captured++; return png; },
    locator: () => locator, getByRole: () => locator, waitForURL: async () => {}, close: async () => {} };
  const context = { route: async (_pattern, callback) => { route = callback; }, routeWebSocket: async () => {}, newPage: async () => page, close: async () => {} };
  const chromium = { launch: async () => ({ newContext: async options => { calls.context = options; return context; }, close: async () => { calls.closed++; } }) };
  return { chromium, axeFactory: () => ({ analyze: async () => ({ violations, incomplete: [] }) }),
    proxyFactory: async () => ({ server: 'http://127.0.0.1:12345', blocked: 0, close: async () => {} }), calls };
}

test('missing deployment identity stays blocked and cannot supply screenshots as exact-SHA evidence', async t => {
  const fixture = browserFixture({ servedRevision: null, overflow: true });
  const result = await runWebAudit({ ...fixture, suite, metadata, outputDir: await directory(t) });
  assert.equal(result.result.status, 'blocked');
  assert.deepEqual(result.screenshots, []);
  assert.equal(fixture.calls.captured, 0);
  assert.equal(fixture.calls.closed, 1);
  assert.equal(result.result.counts.failed, 0);
  assert.equal(result.revisionVerified, false);
  assert.match(result.result.details, /unbound diagnostics/);
  assert.match(result.limitations.join(' '), /withheld/);
});

test('layout and accessibility defects fail QA with observable evidence and revision-bound screenshots', async t => {
  const fixture = browserFixture({ overflow: true, violations: [{ id: 'label', impact: 'critical', help: 'Input needs a label', nodes: [{ target: ['#email'] }] }] });
  const outputDir = await directory(t);
  const evidence = await runWebAudit({ ...fixture, suite, metadata, outputDir });
  assert.equal(evidence.result.status, 'failed');
  assert.equal(evidence.result.counts.failed, 2);
  assert.match(evidence.result.evidence[0].excerpt, /overflows.*\n.*label/s);
  assert.equal(evidence.screenshots[0].revision, revision);
  assert.deepEqual(await fs.readFile(path.join(outputDir, evidence.screenshots[0].path)), png);
  assert.equal(fixture.calls.context.serviceWorkers, 'block');
  assert.equal(fixture.calls.context.acceptDownloads, false);
});

test('unexpected origins and state-changing requests remain blocked coverage, never a successful audit', async t => {
  for (const [url, method] of [['https://external.test/data', 'GET'], ['https://pr-7.example.test/purchase', 'POST']]) {
    const fixture = browserFixture({ routeRequest: { url: () => url, method: () => method } });
    const result = await runWebAudit({ ...fixture, suite, metadata, outputDir: await directory(t) });
    assert.equal(result.result.status, 'blocked'); assert.equal(fixture.calls.aborted, true); assert.equal(fixture.calls.continued, undefined);
  }
  const allowed = browserFixture({ routeRequest: { url: () => 'https://pr-7.example.test/purchase', method: () => 'POST' } });
  assert.equal((await runWebAudit({ ...allowed, suite: { ...suite, allowMutations: true }, metadata, outputDir: await directory(t) })).result.status, 'passed');
  assert.equal(allowed.calls.continued, true);
  assert.equal(allowed.calls.context.proxy.server, 'http://127.0.0.1:12345');
  assert.equal(allowed.calls.context.proxy.bypass, '<-loopback>');
});

test('a missing interaction fails its journey and browser startup errors cannot become passing tests', async t => {
  const result = await runWebAudit({ ...browserFixture({ throwJourney: true }), suite: { ...suite, journeys: [{ name: 'purchase', start: '/', steps: [
    { action: 'click', selector: '#purchase' }, { action: 'expectVisible', selector: '#confirmation' }] }] }, metadata, outputDir: await directory(t) });
  assert.equal(result.result.status, 'failed');
  assert.match(result.result.evidence[0].excerpt, /purchase button is absent/);
  const unavailable = await runWebAudit({ suite, metadata, outputDir: await directory(t), chromium: { launch: async () => { throw new Error('No installed browser'); } }, axeFactory: () => {} });
  assert.equal(unavailable.result.status, 'execution_error');
});

test('browser worker deadline and malformed identity fail closed without trusting a zero exit code', async t => {
  const outputDir = await directory(t);
  const timeout = await executeWebCheck({ suite, metadata, outputDir, checkId: 'ui', processRunner: async () => ({ exitCode: null, timedOut: true }) });
  assert.equal(timeout.result.status, 'execution_error'); assert.match(timeout.result.details, /deadline/);
  await assert.rejects(() => executeWebCheck({ suite, metadata, outputDir, checkId: 'ui', processRunner: async (_command, args, options) => {
    const request = JSON.parse(await fs.readFile(args[2], 'utf8'));
    assert.equal(request.metadata.revision, revision);
    assert.equal(options.maxOutput, 64000);
    await fs.writeFile(path.join(outputDir, 'web-result.json'), JSON.stringify({ ...metadata, revision: 'b'.repeat(40), checkId: 'ui', result: { checkId: 'ui', status: 'passed' } }));
    return { exitCode: 0 };
  } }), /identity mismatch/);
});

test('the executor integrates bot-owned browser evidence without running product scripts or duplicating results', async t => {
  const web = require('../src/web/execute');
  const original = web.executeWebCheck;
  t.after(() => { web.executeWebCheck = original; });
  const { executePlan } = require('../src/executor');
  const root = await directory(t), outputDir = path.join(root, 'output'), product = path.join(root, 'product');
  await fs.mkdir(product);
  const sentinel = 'Product source must remain unchanged';
  await fs.writeFile(path.join(product, 'source.txt'), sentinel);
  web.executeWebCheck = async ({ outputDir: webDir, checkId, metadata: requested }) => {
    assert.equal(requested.revision, revision);
    const sha256 = require('node:crypto').createHash('sha256').update(png).digest('hex');
    const imagePath = `screenshots/${sha256}.png`;
    await fs.mkdir(path.join(webDir, 'screenshots'), { recursive: true });
    await fs.writeFile(path.join(webDir, imagePath), png);
    await fs.writeFile(path.join(webDir, 'audit.json'), '{"fixture":true}');
    return { result: { checkId, status: 'failed', counts: { tests: 2, passed: 1, failed: 1, skipped: 0, cancelled: 0 },
      details: 'Checkout overflows mobile viewport', evidence: [{ path: 'audit.json', excerpt: 'Horizontal overflow' }] },
      screenshots: [{ name: 'checkout', path: imagePath, sha256, mimeType: 'image/png', revision, checkId }], limitations: ['Only configured pages inspected'] };
  };
  const envelope = await executePlan({ plan: { checks: [{ id: 'ui', runner: 'ui-tests', method: 'automated' }] },
    config: { runners: [{ id: 'ui-tests', type: 'web-preview', suite }], execution: { isolation: 'process' } },
    cwd: product, outputDir, allowLocal: true, metadata: { ...metadata, fixture: true, runId: 'local-fixture', attempt: 1 } });
  assert.equal(envelope.results.length, 1);
  assert.equal(envelope.results[0].status, 'failed');
  assert.equal(envelope.results[0].execution, 'sandboxed-browser-preview');
  assert.equal(envelope.execution.browserPreview, true);
  assert.equal(envelope.screenshots.length, 1);
  assert.deepEqual(await fs.readFile(path.join(outputDir, envelope.screenshots[0].path)), png);
  assert.equal(await fs.readFile(path.join(product, 'source.txt'), 'utf8'), sentinel);
  assert.deepEqual(await fs.readdir(product), ['source.txt']);
});
