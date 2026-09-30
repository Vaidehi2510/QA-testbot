const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { executeWebCheck } = require('./execute');

async function main() {
  const revision = 'f'.repeat(40);
  let broken = true, servedRevision = revision, outsideRequests = 0;
  const outside = http.createServer((_req, res) => { outsideRequests++; res.end('outside permitted preview'); });
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${outside.address().port}/` }); res.end(); return; }
    if (req.url !== '/') { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'x-qa-revision': servedRevision });
    res.end(`<!doctype html><html lang="en"><head><title>Checkout QA fixture</title><link rel="icon" href="data:,"><style>body{font:18px Arial;margin:24px;color:#111;background:white}main{max-width:560px}input,button{font:inherit;padding:10px}label{display:block;margin:12px 0} .broken{width:3000px}</style></head><body><main><h1>Checkout</h1><p>Synthetic browser QA fixture</p>
      ${broken ? '<div class="broken">This region overflows on purpose.</div><img src="/missing.png">' : ''}
      ${broken ? '' : '<label for="email">Email address</label>'}<input id="email" type="text"><button id="buy" type="button">Place order</button><p id="error" role="status"></p>
      <script>${broken ? 'console.error("Intentional checkout error");' : ''}document.getElementById('buy').onclick=()=>{document.getElementById('error').textContent='Enter a valid email address';};</script>
      </main></body></html>`);
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-web-demo-'));
  try {
    await new Promise((resolve, reject) => { outside.once('error', reject); outside.listen(0, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const env = { ...process.env };
    if (!env.QA_BROWSER_EXECUTABLE && process.platform === 'darwin') {
      const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      try { await fs.access(chrome); env.QA_BROWSER_EXECUTABLE = chrome; } catch { /* Use installed Playwright Chromium. */ }
    }
    const suite = { targetEnvironment: 'preview', url: `http://127.0.0.1:${server.address().port}`, pages: ['/'],
      journeys: [{ name: 'invalid email', start: '/', steps: [{ action: 'fill', selector: '#email', value: 'invalid' },
        { action: 'click', role: 'button', name: 'Place order' }, { action: 'expectText', selector: '#error', text: 'Enter a valid email address' }] }] };
    const run = label => executeWebCheck({ suite, metadata: { repository: 'fixture/shop', prNumber: 1, revision }, outputDir: path.join(directory, label), checkId: 'ui-tests', env });
    const bad = await run('defect');
    assert.equal(bad.result.status, 'failed', JSON.stringify(bad));
    assert.ok(bad.observations.some(item => item.name.includes('accessibility') && item.status === 'failed'));
    assert.ok(bad.observations.some(item => item.name.includes('horizontal layout') && item.status === 'failed'));
    assert.ok(bad.observations.some(item => item.name.includes('images') && item.status === 'failed'));
    console.log(`[REAL Chromium] Broken fixture: ${bad.result.details}`);
    servedRevision = 'e'.repeat(40);
    const stale = await run('stale-preview');
    assert.equal(stale.result.status, 'blocked');
    assert.equal(stale.result.counts.failed, 0);
    assert.equal(stale.screenshots.length, 0);
    console.log('[REAL Chromium] Stale preview: blocked; observed defects were not attributed to the requested SHA.');
    servedRevision = revision;
    broken = false;
    const fixed = await run('fixed');
    assert.equal(fixed.result.status, 'passed', JSON.stringify(fixed));
    assert.ok(fixed.screenshots.length > 0);
    console.log(`[REAL Chromium] Corrected fixture: ${fixed.result.details}`);
    const redirected = await executeWebCheck({ suite: { ...suite, pages: ['/redirect'], journeys: [], viewports: [{ name: 'desktop', width: 1280, height: 800 }] },
      metadata: { repository: 'fixture/shop', prNumber: 1, revision }, outputDir: path.join(directory, 'redirect'), checkId: 'ui-tests', env });
    assert.notEqual(redirected.result.status, 'passed');
    assert.equal(outsideRequests, 0, 'Redirects must not reach an unlisted origin');
    console.log('[REAL Chromium] Redirect outside the configured preview origin was blocked.');
    console.log('Browser demo passed: desktop/mobile scans, accessibility, responsive overflow, broken assets, console errors, synthetic journey assertions, and SHA-bound screenshots. No model API calls or product files changed.');
  } finally { await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => outside.close(resolve))]); await fs.rm(directory, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
