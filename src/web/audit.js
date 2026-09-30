// Browser QA lives in the bot repository. Target files are never mounted or edited.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { screenshotType } = require('../images');
const { redact } = require('../ai/context');
const { createPreviewProxy } = require('./proxy');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const positive = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Browser target must be an explicit HTTP(S) preview URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Browser URLs cannot contain credentials, fragments, or non-HTTP protocols');
  return url;
}
function validateWebSuite(input, metadata) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.targetEnvironment !== 'preview') throw new Error('Web QA requires a trusted suite with targetEnvironment: preview');
  if (!metadata || !/^[a-f0-9]{40}$/.test(metadata.revision) || !positive(metadata.prNumber, 1, 1e9)) throw new Error('Browser QA requires an exact commit SHA and PR number');
  const rendered = String(input.url || '').replaceAll('{sha}', metadata.revision).replaceAll('{pr}', String(metadata.prNumber));
  if (/[{}]/.test(rendered)) throw new Error('Unsupported browser URL template');
  const url = safeUrl(rendered);
  const allowedOrigins = [...new Set([url.origin, ...(input.allowedOrigins || []).map(value => {
    const origin = safeUrl(value);
    if (origin.href !== `${origin.origin}/`) throw new Error('allowedOrigins entries must be complete origins without paths');
    return origin.origin;
  })])];
  if (allowedOrigins.length > 12) throw new Error('Browser origin allowlist is too large');
  const pages = input.pages || ['/'];
  if (!Array.isArray(pages) || !pages.length || pages.length > 8 || pages.some(value => typeof value !== 'string' || value.length > 1000 || !value.startsWith('/') || value.startsWith('//') || new URL(value, url).origin !== url.origin)) throw new Error('Configure one to eight same-origin page paths');
  const viewports = input.viewports || [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }];
  if (!Array.isArray(viewports) || !viewports.length || viewports.length > 3 || viewports.some(value => !value || !/^[a-zA-Z0-9_-]{1,30}$/.test(value.name) || !positive(value.width, 240, 2560) || !positive(value.height, 240, 1600))) throw new Error('Configure one to three named, bounded browser viewports');
  const timeoutMs = input.timeoutMs ?? 15000;
  if (!positive(timeoutMs, 100, 30000)) throw new Error('Browser timeoutMs must be between 100 and 30000');
  const revisionHeader = input.revisionHeader === undefined ? 'x-qa-revision' : input.revisionHeader;
  if (revisionHeader !== null && (typeof revisionHeader !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(revisionHeader))) throw new Error('revisionHeader must be an HTTP header name or null');
  if (input.allowMutations !== undefined && typeof input.allowMutations !== 'boolean') throw new Error('allowMutations must be boolean');
  const journeys = input.journeys || [];
  if (!Array.isArray(journeys) || journeys.length > 8) throw new Error('Configure at most eight browser journeys');
  for (const journey of journeys) {
    if (!journey || typeof journey.name !== 'string' || !journey.name.trim() || journey.name.length > 150 || !pages.includes(journey.start) || !Array.isArray(journey.steps) || !journey.steps.length || journey.steps.length > 20) throw new Error('Journeys need a name, a configured start path, and one to twenty steps');
    let assertions = 0;
    for (const step of journey.steps) {
      if (!step || !['click', 'fill', 'press', 'expectVisible', 'expectText', 'expectUrl'].includes(step.action)) throw new Error('Unsupported browser step; arbitrary JavaScript is not allowed');
      if (step.action.startsWith('expect')) assertions++;
      if (step.action !== 'expectUrl' && !((typeof step.selector === 'string' && step.selector.length <= 300 && step.selector.trim()) || (typeof step.role === 'string' && /^[a-z]+$/.test(step.role) && typeof step.name === 'string' && step.name.length <= 300))) throw new Error('A browser step needs a bounded selector or accessible role/name');
      if (['fill', 'press'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 1000)) throw new Error('Browser input must be a bounded synthetic value');
      if (step.action === 'expectText' && (typeof step.text !== 'string' || !step.text || step.text.length > 1000)) throw new Error('Expected text must be explicit');
      if (step.action === 'expectUrl' && (typeof step.path !== 'string' || !step.path.startsWith('/') || step.path.startsWith('//') || new URL(step.path, url).origin !== url.origin)) throw new Error('Expected URL must be a same-origin path');
    }
    if (!assertions) throw new Error('Every browser journey needs an explicit expected assertion');
  }
  return { url: url.href, origin: url.origin, allowedOrigins, pages: [...new Set(pages)], viewports, timeoutMs, revisionHeader,
    allowMutations: input.allowMutations === true, journeys, targetEnvironment: 'preview' };
}

function browserLaunchOptions(env = process.env) {
  // The browser receives a minimal environment, never model/GitHub/Slack/Drive keys.
  const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'DISPLAY', 'PLAYWRIGHT_BROWSERS_PATH'].filter(key => env[key]).map(key => [key, env[key]]));
  return { headless: true, chromiumSandbox: true, env: environment,
    ...(env.QA_BROWSER_EXECUTABLE ? { executablePath: env.QA_BROWSER_EXECUTABLE } : {}),
    args: ['--disable-background-networking', '--disable-component-update', '--proxy-bypass-list=<-loopback>', '--disable-http2', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] };
}

async function runWebAudit({ suite: input, metadata, outputDir, checkId = 'web-browser-audit', chromium, axeFactory, proxyFactory = createPreviewProxy, env = process.env }) {
  const suite = validateWebSuite(input, metadata);
  chromium ||= require('playwright-core').chromium;
  axeFactory ||= page => new (require('@axe-core/playwright').default)({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  const output = path.resolve(outputDir);
  await fs.mkdir(output, { recursive: true });
  const observations = [], screenshots = [], limitations = [
    'Browser checks cover configured pages, viewports, and journeys in Chromium. Unvisited states, other engines, assistive technologies, and unstated business requirements remain outside coverage.',
    'Visual enhancement proposals are advisory. Screenshots and automated accessibility checks do not establish complete usability or accessibility.',
  ];
  let imageBytes = 0, browser, unverifiedRevision = false;
  const record = (name, status, details, location = '') => observations.push({ name, status, details: redact(details).slice(0, 4000), location: redact(location).slice(0, 500) });
  const screenshot = async (page, label) => {
    if (screenshots.length >= 4) { limitations.push('Only the first four browser states were captured for AI image review.'); return; }
    try {
      const bytes = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: suite.timeoutMs });
      if (bytes.length > 2 * 1024 * 1024 || imageBytes + bytes.length > 6 * 1024 * 1024 || !screenshotType(bytes)) throw new Error('Screenshot exceeded evidence limits');
      const sha256 = digest(bytes), filename = `screenshots/${sha256}.png`;
      await fs.mkdir(path.join(output, 'screenshots'), { recursive: true });
      await fs.writeFile(path.join(output, filename), bytes, { mode: 0o600 });
      imageBytes += bytes.length;
      screenshots.push({ name: label, path: filename, sha256, mimeType: 'image/png', revision: metadata.revision, checkId });
    } catch { limitations.push(`Screenshot unavailable for ${label}; visual coverage is incomplete.`); }
  };
  try {
    browser = await chromium.launch(browserLaunchOptions(env));
    for (const viewport of suite.viewports) {
      const proxy = await proxyFactory(suite);
      let context;
      try {
      context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block', acceptDownloads: false,
        proxy: { server: proxy.server, bypass: '<-loopback>' }, permissions: [], ignoreHTTPSErrors: false, reducedMotion: 'reduce' });
      let requestsBlocked = 0;
      await context.route('**/*', async route => {
        try {
          const target = safeUrl(route.request().url());
          const method = route.request().method();
          if (!suite.allowedOrigins.includes(target.origin) || !suite.allowMutations && !['GET', 'HEAD', 'OPTIONS'].includes(method)) { requestsBlocked++; return route.abort(); }
          await route.continue();
        } catch { requestsBlocked++; await route.abort().catch(() => {}); }
      });
      // WebSockets can mutate server state and evade the HTTP method allowlist.
      await context.routeWebSocket('**/*', socket => { requestsBlocked++; socket.close(); });
        const targets = [...suite.pages.map(start => ({ start })), ...suite.journeys];
        for (const target of targets) {
          const page = await context.newPage();
          page.setDefaultTimeout(suite.timeoutMs);
          page.setDefaultNavigationTimeout(suite.timeoutMs);
          const label = `${viewport.name}: ${target.name || target.start}`;
          const errors = [], failedResources = [];
          let finalDocument, journeyStarted = false;
          page.on('pageerror', error => { if (errors.length < 10) errors.push(redact(error.message).slice(0, 500)); });
          page.on('console', message => { if (message.type() === 'error' && errors.length < 10) errors.push(redact(message.text()).slice(0, 500)); });
          page.on('response', response => {
            if (response.request().resourceType() === 'document' && response.frame() === page.mainFrame()) finalDocument = response;
            if (response.status() >= 400 && failedResources.length < 10) failedResources.push(`${response.status()} ${redact(response.url()).slice(0, 300)}`);
          });
          page.on('requestfailed', request => { if (failedResources.length < 10) failedResources.push(`Request failed: ${redact(request.url()).slice(0, 300)}`); });
          page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
          // Do not retain or follow application-created popups or downloads.
          page.on('popup', popup => popup.close().catch(() => {}));
          try {
            const destination = new URL(target.start, suite.url).href;
            const response = await page.goto(destination, { waitUntil: 'load' });
            if (!response || response.status() >= 400) record(`${label} loads`, 'failed', `Main document HTTP ${response?.status() || 'unavailable'}`, destination);
            else record(`${label} loads`, 'passed', `Main document HTTP ${response.status()}`, destination);
            const servedRevision = suite.revisionHeader && await response?.headerValue(suite.revisionHeader);
            let bound = servedRevision?.trim() === metadata.revision && new URL(page.url()).origin === suite.origin;
            if (!bound) unverifiedRevision = true;
            record(`${label} deployment identity`, bound ? 'passed' : 'blocked', bound ? 'The preview reports the exact requested commit.' : 'Preview commit could not be verified. Supply a preview/proxy revision header tied to its deployed commit; caller-provided SHA alone is insufficient.', destination);
            if (target.steps) {
              journeyStarted = true;
              for (const step of target.steps) {
                const locator = step.action === 'expectUrl' ? null : step.selector ? page.locator(step.selector) : page.getByRole(step.role, { name: step.name, exact: true });
                if (step.action === 'click') await locator.click();
                else if (step.action === 'fill') await locator.fill(step.value);
                else if (step.action === 'press') await locator.press(step.value);
                else if (step.action === 'expectVisible') await locator.waitFor({ state: 'visible' });
                else if (step.action === 'expectText') {
                  await locator.filter({ hasText: step.text }).waitFor({ state: 'visible' });
                } else if (step.action === 'expectUrl') await page.waitForURL(new URL(step.path, suite.url).href);
              }
              record(`${label} journey`, 'passed', 'Every configured interaction and expected assertion completed.', page.url());
              journeyStarted = false;
              const finalRevision = suite.revisionHeader && await (finalDocument || response)?.headerValue(suite.revisionHeader);
              bound = bound && finalRevision?.trim() === metadata.revision && new URL(page.url()).origin === suite.origin;
              if (!bound) unverifiedRevision = true;
              record(`${label} final deployment identity`, bound ? 'passed' : 'blocked', bound ? 'The journey ended on the expected deployment.' : 'The journey changed deployment identity or left the configured preview origin.', page.url());
            }
            const layout = await page.evaluate(() => ({
              overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
              brokenImages: [...document.images].filter(image => image.complete && image.currentSrc && image.naturalWidth === 0).map(image => image.getAttribute('src')).slice(0, 10),
              title: document.title,
            }));
            record(`${label} horizontal layout`, layout.overflow ? 'failed' : 'passed', layout.overflow ? 'Content overflows the configured viewport horizontally.' : 'No horizontal viewport overflow detected.', page.url());
            record(`${label} images`, layout.brokenImages.length ? 'failed' : 'passed', layout.brokenImages.length ? `Broken images: ${layout.brokenImages.join(', ')}` : 'Loaded images have valid dimensions.', page.url());
            const accessibility = await axeFactory(page).analyze();
            const violations = accessibility.violations || [];
            record(`${label} accessibility`, violations.length ? 'failed' : 'passed', violations.length ? violations.slice(0, 15).map(item => `${item.id} (${item.impact}): ${item.help}; ${(item.nodes || []).slice(0, 3).map(node => JSON.stringify(node.target)).join(', ')}`).join('\n') : 'No violations found by the configured automated WCAG rules.', page.url());
            if (accessibility.incomplete?.length) limitations.push(`${label}: ${accessibility.incomplete.length} accessibility rules were inconclusive; these are not established passes.`);
            record(`${label} browser errors`, errors.length ? 'failed' : 'passed', errors.length ? errors.join('\n') : 'No captured console errors or uncaught exceptions.', page.url());
            record(`${label} resources`, failedResources.length ? 'failed' : 'passed', failedResources.length ? failedResources.join('\n') : 'No captured HTTP resource errors.', page.url());
            // Images are eligible for AI review only when deployment identity was observed.
            if (bound) await screenshot(page, label);
            else limitations.push(`${label}: images withheld from AI because the deployed revision was not established.`);
          } catch (error) {
            record(`${label} ${journeyStarted ? 'journey' : 'execution'}`, journeyStarted ? 'failed' : 'execution_error', error.message, target.start);
          } finally { await page.close().catch(() => {}); }
        }
        if (requestsBlocked) record(`${viewport.name} network coverage`, 'blocked', `${requestsBlocked} page request(s) were blocked by the trusted origin/method policy. Configure required synthetic preview dependencies before claiming full coverage.`);
        // Chromium also attempts background service connections through its
        // context proxy. They remain denied but are not product test failures.
        // Failed page requests, including redirected resources, are captured above.
        if (proxy.blocked) limitations.push(`${viewport.name}: the proxy refused ${proxy.blocked} unapproved connection(s). Page-level request failures are recorded separately from browser background traffic.`);
      } finally { try { if (context) await context.close(); } finally { await proxy.close(); } }
    }
  } catch (error) { record('Browser startup or execution', 'execution_error', error.message); }
  finally { if (browser) await browser.close().catch(() => {}); }
  const status = unverifiedRevision ? 'blocked' : ['failed', 'execution_error', 'blocked', 'skipped'].find(value => observations.some(item => item.status === value)) || (observations.length ? 'passed' : 'blocked');
  const counts = { tests: observations.length, passed: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const item of observations) {
    if (item.status === 'passed') counts.passed++;
    else if (item.status === 'failed') counts.failed++;
    else if (item.status === 'execution_error') counts.cancelled++;
    else counts.skipped++;
  }
  if (unverifiedRevision) {
    counts.passed = 0; counts.failed = 0; counts.cancelled = 0; counts.skipped = counts.tests;
    limitations.push('One or more preview documents could not be bound to the requested commit. All browser counts are withheld as blocked; observations are unbound diagnostics, not confirmed defects at that SHA.');
  }
  const evidencePath = `browser-${digest(checkId).slice(0, 16)}.json`;
  const result = { checkId, status, counts, details: unverifiedRevision ? 'Preview revision identity was not verified. Browser observations are unbound diagnostics; no pass or defect is attributed to the requested SHA.' : `${counts.tests} browser checks: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} blocked, ${counts.cancelled} execution errors.`,
    evidence: [{ type: 'browser', path: evidencePath, excerpt: observations.filter(item => item.status !== 'passed').map(item => `${item.name}: ${item.details}`).join('\n').slice(0, 6000) }] };
  const evidence = { schemaVersion: 1, repository: metadata.repository, prNumber: metadata.prNumber, revision: metadata.revision,
    environment: 'disposable-web-preview', revisionVerified: !unverifiedRevision && observations.some(item => item.name.endsWith('deployment identity') && item.status === 'passed'), checkId, result, observations, screenshots, limitations: [...new Set(limitations)], completedAt: new Date().toISOString() };
  await fs.writeFile(path.join(output, evidencePath), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return evidence;
}

module.exports = { validateWebSuite, browserLaunchOptions, runWebAudit };
