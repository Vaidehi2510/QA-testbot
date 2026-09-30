const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { createDashboard } = require('../src/dashboard');
const { DEFAULT_AI_CONFIG } = require('../src/ai/settings');

const model = { id: 'example/reviewer', name: 'Example reviewer', description: 'Test catalog model', contextLength: 64000, inputModalities: ['text'], outputModalities: ['text'], supportedParameters: ['tools'], pricing: { prompt: 0.000001, completion: 0.000002 } };
const vision = { ...model, id: 'example/vision', inputModalities: ['text', 'image'] };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-dashboard-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'qa-config.json'), statePath = path.join(directory, 'state.json');
  const base = { enabled: false, runners: [{ id: 'trusted-tests' }], drive: { folderId: 'preserved' }, customOption: 'preserved', ...(options.initialAI ? { ai: options.initialAI } : {}) };
  await fs.writeFile(configPath, JSON.stringify(base));
  let catalogCalls = 0;
  const server = createDashboard({ configPath, statePath, apiKey: 'test-secret-never-exposed',
    client: { listModels: async () => { catalogCalls++; return [model, vision]; } }, ...options });
  t.after(() => server.close());
  const request = (url, { method = 'GET', headers = {}, body, rawBody } = {}) => new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.url = url; req.method = method; req.headers = { host: '127.0.0.1:8787', ...headers }; req.socket = { localPort: 8787 };
    const responseHeaders = {};
    const res = { headersSent: false,
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
      writeHead(status, extra = {}) { this.status = status; this.headersSent = true; Object.entries(extra).forEach(([name, value]) => this.setHeader(name, value)); },
      end(content = '') {
        const text = String(content);
        resolve({ status: this.status, headers: responseHeaders, text, json: responseHeaders['content-type']?.startsWith('application/json') ? JSON.parse(text) : undefined });
      },
    };
    req.on('error', reject);
    server.emit('request', req, res);
    req.end(rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : '');
  });
  const settings = async () => (await request('/api/settings')).json;
  const authorization = async () => ({
    'content-type': 'application/json', 'x-qa-csrf': (await request('/api/bootstrap')).json.csrfToken,
    'if-match': (await settings()).revision,
  });
  return { directory, configPath, statePath, base, request, settings, authorization, catalogCalls: () => catalogCalls };
}

test('dashboard bootstrap and settings never expose server credentials or unrelated config', async t => {
  const f = await fixture(t);
  const settings = await f.request('/api/settings'), bootstrap = await f.request('/api/bootstrap');
  assert.equal(settings.status, 200);
  assert.equal(settings.json.credentialConfigured, true);
  assert.deepEqual(settings.json.ai, DEFAULT_AI_CONFIG);
  assert.match(bootstrap.json.csrfToken, /^[a-f0-9]{64}$/);
  assert.ok(!settings.text.includes('test-secret'));
  assert.ok(!settings.text.includes('folderId'));
  assert.equal(settings.headers['cache-control'], 'no-store');
  assert.match(settings.headers['content-security-policy'], /frame-ancestors 'none'/);
});
test('catalog browsing works without credentials and caches requests', async t => {
  const f = await fixture(t, { apiKey: '' });
  const [a, b] = await Promise.all([f.request('/api/models'), f.request('/api/models')]);
  assert.equal(a.status, 200); assert.deepEqual(a.json.models, [model, vision]); assert.deepEqual(a.json, b.json);
  assert.equal(f.catalogCalls(), 1); assert.equal((await f.settings()).credentialConfigured, false);
});
test('catalog errors return an actionable response without provider errors or secrets', async t => {
  const f = await fixture(t, { client: { listModels: async () => { throw new Error('private-provider-response test-secret'); } } });
  const response = await f.request('/api/models');
  assert.equal(response.status, 503); assert.doesNotMatch(response.text, /private-provider|test-secret/);
});
test('dashboard blocks DNS rebinding, mismatched ports, cross-origin and cross-site access', async t => {
  const f = await fixture(t);
  for (const headers of [
    { host: 'evil.example:8787' }, { host: '127.0.0.1:9999' }, { host: '127.0.0.1:8787@evil.example' },
    { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) assert.equal((await f.request('/api/bootstrap', { headers })).status, 403);
  assert.equal((await f.request('/api/bootstrap', { headers: { host: 'localhost:8787', origin: 'http://localhost:8787' } })).status, 200);
});
test('settings mutation requires CSRF, conditional revision, JSON and bounded request bodies', async t => {
  const f = await fixture(t), headers = await f.authorization(), body = { ai: DEFAULT_AI_CONFIG };
  for (const token of ['', 'bad-token', 'é'.repeat(64)]) {
    assert.equal((await f.request('/api/settings', { method: 'PUT', headers: { ...headers, 'x-qa-csrf': token }, body })).status, 403);
  }
  assert.equal((await f.request('/api/settings', { method: 'PUT', headers: { ...headers, 'content-type': 'text/plain' }, body })).status, 415);
  assert.equal((await f.request('/api/settings', { method: 'PUT', headers: { ...headers, 'if-match': '' }, body })).status, 428);
  assert.equal((await f.request('/api/settings', { method: 'PUT', headers, rawBody: '{' })).status, 400);
  assert.equal((await f.request('/api/settings', { method: 'PUT', headers, rawBody: ' '.repeat(40000) })).status, 413);
  assert.equal((await f.request('/api/settings', { method: 'PUT', headers: { ...headers, 'content-length': '40000' }, body })).status, 413);
});
test('valid model settings save atomically and preserve all other configuration', async t => {
  const f = await fixture(t), headers = await f.authorization();
  const ai = { ...DEFAULT_AI_CONFIG, enabled: true, model: model.id, allowImages: true, roleModels: { 'ui-ux': vision.id }, maxCostUsd: 0.25 };
  const response = await f.request('/api/settings', { method: 'PUT', headers, body: { ai } });
  assert.equal(response.status, 200);
  const stored = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(stored, { ...f.base, ai });
  assert.notEqual(response.json.revision, headers['if-match']);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['qa-config.json']);
});
test('stale browser settings cannot overwrite concurrent edits or production activation', async t => {
  const f = await fixture(t), headers = await f.authorization();
  await fs.writeFile(f.configPath, JSON.stringify({ ...f.base, enabled: true, customOption: 'new configuration' }));
  const response = await f.request('/api/settings', { method: 'PUT', headers, body: { ai: DEFAULT_AI_CONFIG } });
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).customOption, 'new configuration');
});
test('concurrent configuration saves serialize and reject stale revisions', async t => {
  const f = await fixture(t), headers = await f.authorization(), body = { ai: { ...DEFAULT_AI_CONFIG, model: model.id } };
  const responses = await Promise.all([f.request('/api/settings', { method: 'PUT', headers, body }), f.request('/api/settings', { method: 'PUT', headers, body })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
});
test('settings reject secret storage, malformed models and missing vision capability', async t => {
  const f = await fixture(t), headers = await f.authorization();
  const invalid = [
    { ai: DEFAULT_AI_CONFIG, apiKey: 'no' },
    { ai: { ...DEFAULT_AI_CONFIG, apiKey: 'no' } },
    { ai: { ...DEFAULT_AI_CONFIG, enabled: true, model: 'not-a-model' } },
    { ai: { ...DEFAULT_AI_CONFIG, enabled: true, model: 'missing/model' } },
    { ai: { ...DEFAULT_AI_CONFIG, enabled: true, model: model.id, allowImages: true } },
    { ai: { ...DEFAULT_AI_CONFIG, maxCostUsd: -1 } },
  ];
  for (const body of invalid) assert.equal((await f.request('/api/settings', { method: 'PUT', headers, body })).status, 400);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')), f.base);
});
test('dashboard serves only its fixed assets and applies method boundaries', async t => {
  const f = await fixture(t);
  for (const url of ['/', '/app.js', '/style.css']) assert.equal((await f.request(url)).status, 200);
  for (const url of ['/qa-config.json', '/.env', '/src/run.js', '/api/review', '/%2e%2e/package.json']) assert.equal((await f.request(url)).status, 404);
  const result = await f.request('/api/settings', { method: 'DELETE' });
  assert.equal(result.status, 405); assert.equal(result.headers.allow, 'GET, PUT');
  assert.equal((await f.request('/api/bootstrap', { method: 'POST' })).status, 405);
});
test('run history projects evidence and AI reviews without unrelated durable state', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/runs')).json, { runs: [], localOnly: true });
  await fs.writeFile(f.statePath, JSON.stringify({ secrets: 'do-not-expose', runs: {
    earlier: { key: 'earlier', createdAt: '2026-01-01', privateDebug: 'do-not-expose', outcome: { status: 'blocked' } },
    latest: { key: 'latest', createdAt: '2026-02-01', ai: { completion: { status: 'completed', findings: [{ title: '<script>alert(1)</script>' }] } }, results: [] },
  } }));
  const response = await f.request('/api/runs');
  assert.equal(response.status, 200); assert.equal(response.json.runs[0].key, 'latest');
  assert.equal(response.json.runs[1].outcome.status, 'blocked');
  assert.equal(response.json.runs[0].ai.completion.findings[0].title, '<script>alert(1)</script>');
  assert.doesNotMatch(response.text, /do-not-expose/);
});

const localProfile = { id: 'local-reviewer:latest', contextLength: 32768, tools: true, vision: false };
const localAI = { ...DEFAULT_AI_CONFIG, backend: 'local', local: { baseUrl: 'http://127.0.0.1:11434/v1', models: [localProfile] } };
test('local settings save offline using explicit profiles without contacting any model provider', async t => {
  let factoryCalls = 0;
  const f = await fixture(t, { clientFactory: () => { factoryCalls++; throw new Error('offline secret'); }, localApiKey: '' });
  const ai = { ...localAI, enabled: true, model: localProfile.id };
  const response = await f.request('/api/settings', { method: 'PUT', headers: await f.authorization(), body: { ai } });
  assert.equal(response.status, 200); assert.equal(factoryCalls, 0); assert.equal(f.catalogCalls(), 0);
  assert.equal(response.json.credentialConfigured, false); assert.equal(response.json.credentialRequired, false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')), { ...f.base, ai });
});
test('catalog follows saved backend and keeps local credential state separate from OpenRouter', async t => {
  const calls = [];
  const f = await fixture(t, { initialAI: localAI, apiKey: '', localApiKey: 'local-only-private', clientFactory: options => {
    calls.push(options); return { listModels: async () => [{ ...model, id: localProfile.id, backend: 'local' }] };
  } });
  const settings = await f.settings();
  assert.equal(settings.credentialConfigured, true); assert.equal(settings.credentialRequired, false);
  assert.deepEqual(settings.credentials, { local: true, openrouter: false });
  assert.ok(!JSON.stringify(settings).includes('local-only-private'));
  const result = await f.request('/api/models');
  assert.equal(result.status, 200); assert.equal(result.json.backend, 'local');
  assert.equal(result.json.models[0].id, localProfile.id); assert.equal(f.catalogCalls(), 0);
  assert.equal(calls[0].ai.backend, 'local'); assert.equal(calls[0].env.LOCAL_MODEL_API_KEY, 'local-only-private');
});
test('draft catalog preview requires CSRF and validates loopback endpoints before creating clients', async t => {
  let factoryCalls = 0;
  const f = await fixture(t, { clientFactory: () => { factoryCalls++; return { listModels: async () => [] }; } });
  const headers = await f.authorization();
  const preview = ai => f.request('/api/models', { method: 'POST', headers, body: { ai } });
  assert.equal((await f.request('/api/models', { method: 'POST', body: { ai: { backend: 'local', local: localAI.local } } })).status, 403);
  for (const baseUrl of ['https://evil.example/v1', 'http://localhost:11434/v1', 'http://127.1:11434/v1', 'http://127.0.0.1:11434/v1?secret=1', 'http://127.0.0.1:11434/admin', 'http://user:password@127.0.0.1/v1']) {
    assert.equal((await preview({ backend: 'local', local: { baseUrl, models: [] } })).status, 400);
  }
  assert.equal((await preview({ backend: 'local', local: localAI.local, apiKey: 'do-not-store' })).status, 400);
  assert.equal((await preview({ backend: 'local', local: { ...localAI.local, apiKey: 'do-not-store' } })).status, 400);
  assert.equal(factoryCalls, 0);
  const response = await preview({ backend: 'local', local: localAI.local });
  assert.equal(response.status, 200); assert.equal(factoryCalls, 1); assert.equal(f.catalogCalls(), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')), f.base);
});
test('draft catalogs cache separately across backend, endpoint and capability profiles', async t => {
  const seen = [];
  const f = await fixture(t, { clientFactory: ({ ai }) => ({ listModels: async () => { seen.push(ai); return [{ id: ai.local.models[0]?.id || 'unprofiled' }]; } }) });
  const headers = await f.authorization();
  const preview = local => f.request('/api/models', { method: 'POST', headers, body: { ai: { backend: 'local', local } } });
  await f.request('/api/models'); await preview(localAI.local); await preview(localAI.local);
  await preview({ ...localAI.local, baseUrl: 'http://127.0.0.1:1234/v1' });
  await preview({ ...localAI.local, models: [{ ...localProfile, vision: true }] });
  assert.equal(seen.length, 3); assert.equal(f.catalogCalls(), 1);
  assert.equal((await f.settings()).ai.backend, 'openrouter');
});
test('offline local catalogs report local recovery steps and never fall back to OpenRouter', async t => {
  const f = await fixture(t, { initialAI: localAI, clientFactory: () => ({ listModels: async () => { throw new Error('private local key'); } }) });
  const response = await f.request('/api/models');
  assert.equal(response.status, 503); assert.match(response.text, /Local model server/); assert.match(response.text, /still save/);
  assert.doesNotMatch(response.text, /private local key/); assert.equal(f.catalogCalls(), 0);
});
test('local models require explicit tools and screenshot capability declarations before assignment', async t => {
  const f = await fixture(t), headers = await f.authorization();
  for (const ai of [
    { ...localAI, enabled: true, model: 'unknown-model' },
    { ...localAI, model: localProfile.id, local: { ...localAI.local, models: [{ ...localProfile, tools: false }] } },
    { ...localAI, enabled: true, model: localProfile.id, allowImages: true },
    { ...localAI, local: { ...localAI.local, models: [{ id: 'unconfirmed', contextLength: 32768 }] } },
  ]) assert.equal((await f.request('/api/settings', { method: 'PUT', headers, body: { ai } })).status, 400);
  assert.equal(f.catalogCalls(), 0); assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')), f.base);
});
