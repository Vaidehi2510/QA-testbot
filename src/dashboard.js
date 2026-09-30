const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { OpenRouterClient } = require('./ai/openrouter');
const { DEFAULT_AI_CONFIG, validateAIConfig } = require('./ai/settings');

const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const fingerprint = (source) => `"${crypto.createHash('sha256').update(source).digest('hex')}"`;
const fail = (status, message) => Object.assign(new Error(message), { status });

function secureRequest(req) {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(host) || Number(host.split(':')[1]) !== req.socket.localPort) {
    throw fail(403, 'Use the localhost URL printed by the dashboard.');
  }
  if (req.headers.origin && req.headers.origin !== `http://${host}`) throw fail(403, 'Cross-origin requests are not allowed.');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw fail(403, 'Cross-origin requests are not allowed.');
}

function readBody(req, limit = 32 * 1024) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw fail(415, 'Use application/json.');
  if (Number(req.headers['content-length']) > limit) throw fail(413, 'Settings request is too large.');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) { reject(fail(413, 'Settings request is too large.')); return; }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (length > limit) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(fail(400, 'Settings must be valid JSON.')); }
    });
  });
}

async function withConfigLock(configPath, operation) {
  const lockPath = `${configPath}.dashboard.lock`;
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await fs.open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!handle) throw fail(409, 'Another dashboard is saving. Retry, or remove the dashboard lock after stopping all dashboard processes.');
  try { return await operation(); }
  finally { await handle.close(); await fs.unlink(lockPath); }
}

function createDashboard({ configPath = path.resolve('qa-config.json'), statePath = path.resolve('.qa-local/state.json'), client,
  apiKey = process.env.OPENROUTER_API_KEY, assetsPath = path.join(__dirname, '..', 'ui') } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const router = client || new OpenRouterClient({ apiKey });
  let catalog, catalogAt = 0, catalogRequest;
  const getModels = async () => {
    if (catalog && Date.now() - catalogAt < 300_000) return catalog;
    if (!catalogRequest) catalogRequest = Promise.resolve().then(() => router.listModels()).then((models) => {
      if (!Array.isArray(models)) throw new Error('Invalid model catalog');
      catalog = models;
      catalogAt = Date.now();
      return models;
    }).catch(() => { throw fail(503, 'OpenRouter model catalog is unavailable. Check connectivity and retry.'); }).finally(() => { catalogRequest = undefined; });
    return catalogRequest;
  };
  const readConfig = async () => {
    const source = await fs.readFile(configPath, 'utf8');
    return { config: JSON.parse(source), revision: fingerprint(source) };
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      secureRequest(req);
      const route = new URL(req.url, `http://${req.headers.host}`).pathname;
      const allowedMethod = route === '/api/settings' ? ['GET', 'PUT'] : ['GET'];
      if (!allowedMethod.includes(req.method)) { res.setHeader('Allow', allowedMethod.join(', ')); throw fail(405, 'Method not allowed.'); }
      if (req.method === 'PUT') {
        const supplied = req.headers['x-qa-csrf'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw fail(403, 'Refresh the dashboard before saving.');
      }
      if (route === '/api/bootstrap') return send(200, { csrfToken: token });
      if (route === '/api/models') return send(200, { models: await getModels(), fetchedAt: new Date(catalogAt).toISOString() });
      if (route === '/api/settings' && req.method === 'GET') {
        const { config, revision } = await readConfig();
        const ai = validateAIConfig(config.ai || DEFAULT_AI_CONFIG);
        return send(200, { ai, credentialConfigured: Boolean(apiKey), revision });
      }
      if (route === '/api/settings' && req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !body.ai || typeof body.ai !== 'object') throw fail(400, 'Provide only the ai settings object.');
        if (!req.headers['if-match']) throw fail(428, 'Reload settings before saving.');
        let ai;
        try { ai = validateAIConfig(body.ai, { models: await getModels() }); }
        catch (error) { if (error.status) throw error; throw fail(400, error.message); }
        const savedRevision = await withConfigLock(configPath, async () => {
          const { config, revision } = await readConfig();
          if (req.headers['if-match'] !== revision) throw fail(409, 'Configuration changed since you opened it. Reload before saving to preserve those changes.');
          const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
          try {
            const source = JSON.stringify({ ...config, ai }, null, 2) + '\n';
            await fs.writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
            // Detect edits made outside the dashboard while validation was running.
            if ((await readConfig()).revision !== revision) throw fail(409, 'Configuration changed while saving. Reload and retry.');
            await fs.rename(temporary, configPath);
            return fingerprint(source);
          } finally { await fs.rm(temporary, { force: true }); }
        });
        return send(200, { ai, credentialConfigured: Boolean(apiKey), revision: savedRevision });
      }
      if (route === '/api/runs') {
        let state;
        try {
          const info = await fs.stat(statePath);
          if (info.size > 20 * 1024 * 1024) throw fail(413, 'Local state is too large to display. Inspect the saved report directly.');
          state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        } catch (error) { if (error.code !== 'ENOENT') throw error; state = { runs: {} }; }
        const runs = Object.values(state.runs || {}).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 50).map(run => ({
          key: run.key || run.runId, runId: run.runId, repository: run.repository, revision: run.revision,
          createdAt: run.createdAt, completedAt: run.completedAt, phase: run.phase, outcome: run.outcome,
          pr: run.pr && { number: run.pr.number, title: run.pr.title }, ai: run.ai, plan: run.plan,
          results: run.results, report: run.report && { markdown: run.report.markdown, status: run.report.status },
        }));
        return send(200, { runs, localOnly: true });
      }
      if (ASSETS[route]) {
        const [filename, type] = ASSETS[route];
        const data = await fs.readFile(path.join(assetsPath, filename));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(data);
      }
      throw fail(404, 'Not found.');
    } catch (error) {
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Dashboard could not read its local configuration or state. Check the server terminal and configuration files.' });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.QA_DASHBOARD_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QA_DASHBOARD_PORT must be between 1 and 65535');
  const server = createDashboard({ configPath: process.env.QA_CONFIG || path.resolve('qa-config.json'), statePath: process.env.QA_STATE_PATH || path.resolve('.qa-local/state.json') });
  server.on('error', error => { process.stderr.write(`Dashboard could not start: ${error.code || error.message}\n`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`QA team dashboard: http://127.0.0.1:${port}\nAPI keys remain in the server environment. Ctrl+C stops the dashboard.\n`));
}

module.exports = { createDashboard };
