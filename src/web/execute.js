const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateWebSuite } = require('./audit');
const { redact } = require('../ai/context');

// Only trusted bot code launches the browser. No target scripts or integration
// credentials are passed into this short-lived process or its browser children.
async function executeWebCheck({ suite, metadata, outputDir, checkId, timeoutMs = 180000, env = process.env, processRunner }) {
  validateWebSuite(suite, metadata);
  const runProcess = processRunner || require('../executor').runProcess;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-web-request-'));
  const output = path.resolve(outputDir);
  await fs.mkdir(output, { recursive: true });
  try {
    const requestPath = path.join(temporary, 'request.json');
    await fs.writeFile(requestPath, JSON.stringify({ suite, metadata, checkId,
      browserExecutable: env.QA_BROWSER_EXECUTABLE, browserCache: env.PLAYWRIGHT_BROWSERS_PATH }), { mode: 0o600 });
    const execution = await runProcess(process.execPath, [path.join(__dirname, 'worker.js'), '--request', requestPath, '--output', output],
      { cwd: temporary, timeoutMs: Math.min(600000, Math.max(100, timeoutMs)), maxOutput: 64000 });
    if (execution.exitCode !== 0 || execution.error || execution.cancelled || execution.timedOut || execution.overflow) {
      const log = redact(execution.output || execution.error || '').slice(-16000);
      await fs.writeFile(path.join(output, 'browser-worker.log'), log, { mode: 0o600 });
      return { result: { checkId, status: 'execution_error', details: execution.timedOut ? 'Browser suite exceeded its total deadline; browser process group terminated.' : 'Browser worker failed; no successful evidence was accepted.',
        evidence: [{ type: 'log', path: 'browser-worker.log', excerpt: log.slice(-4000) }] }, screenshots: [], limitations: ['Browser execution did not finish.'] };
    }
    const filename = path.join(output, 'web-result.json');
    if ((await fs.stat(filename)).size > 2 * 1024 * 1024) throw new Error('Browser result exceeds its size limit');
    const evidence = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (evidence.revision !== metadata.revision || evidence.repository !== metadata.repository || evidence.prNumber !== metadata.prNumber || evidence.checkId !== checkId || evidence.result?.checkId !== checkId) throw new Error('Browser evidence identity mismatch');
    return evidence;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
module.exports = { executeWebCheck };
