const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DriveAdapter } = require('../src/drive.js');

function fixture() {
  return { repository: 'org/app', pr: { number: 7, title: 'Checkout', author: 'author', url: 'https://github.com/org/app/pull/7' }, revision: 'a'.repeat(40), environment: 'synthetic', runId: 'run1', attempt: 1, actionsRunId: '123', actionsAttempt: 1, createdAt: '2026-01-01T00:00:00Z', plan: { checks: [{ id: 'unit', method: 'automated', required: true }] }, results: [{ checkId: 'unit', status: 'passed' }], decisions: [], report: { status: 'pending' } };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function driveServer() {
  const files = new Map();
  const requests = [];
  let nextId = 1;
  const server = { files, requests, failUploads: false, loseUploadResponse: false };
  server.fetch = async (input, options) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    requests.push({ url, ...options });
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.ok(!url.pathname.includes('permissions'));
    if (url.pathname.endsWith('/generateIds')) return response({ ids: [`file-${nextId++}`] });
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    if (method === 'GET' && url.pathname.endsWith('/files')) {
      assert.equal(url.searchParams.get('driveId'), 'shared-drive');
      assert.equal(url.searchParams.get('corpora'), 'drive');
      assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
      const q = url.searchParams.get('q');
      const parent = q.match(/^'([^']+)' in parents/)[1];
      const identity = q.match(/value='([^']+)'/)[1];
      return response({ files: [...files.values()].filter((file) => file.parents.includes(parent) && file.appProperties.identity === identity).map(({ id }) => ({ id })) });
    }
    if (method === 'GET') return response(files.get(url.pathname.split('/').at(-1)));
    const upload = url.pathname.includes('/upload/');
    if (upload && server.failUploads) return response({}, 503);
    let metadata;
    let content;
    if (upload && url.searchParams.get('uploadType') === 'media') content = options.body;
    else if (upload) {
      const parts = options.body.split('\r\n\r\n');
      metadata = JSON.parse(parts[1].split('\r\n--')[0]);
      content = parts.slice(2).join('\r\n\r\n').split('\r\n--')[0];
    } else metadata = JSON.parse(options.body);
    const id = method === 'PATCH' ? url.pathname.split('/').at(-1) : metadata.id;
    if (method === 'POST' && files.has(id)) return response({}, 409);
    files.set(id, { ...(files.get(id) || {}), ...metadata, id, ...(content ? { content } : {}) });
    if (upload && server.loseUploadResponse) {
      server.loseUploadResponse = false;
      throw new Error('Connection lost after Drive committed create');
    }
    return response({ id });
  };
  return server;
}

function adapter(server, options = {}) {
  return new DriveAdapter({ folderId: 'configured-folder', sharedDriveId: 'shared-drive', accessToken: 'test-token', fetchImpl: server.fetch, dryRun: false, ...options });
}

test('Drive dry-run renders a report without credentials or network access', async () => {
  const result = await new DriveAdapter({ dryRun: true, fetchImpl: () => { throw new Error('Network forbidden'); } }).upsertReport(fixture());
  assert.equal(result.status, 'preview');
  assert.match(result.path, /org_app\/PR-7\/run-run1-attempt-1.md/);
  assert.match(result.markdown, /QA outcome:\*\* passed/);
});

test('Drive organizes bounded shared folders and deduplicates repeated historical/current uploads', async () => {
  const server = driveServer(); const run = fixture();
  const checkpoints = [];
  const drive = adapter(server, { onCheckpoint: async (state) => checkpoints.push(JSON.parse(JSON.stringify(state.report.driveIds))) });
  const first = await drive.upsertReport(run);
  assert.equal(first.status, 'uploaded');
  assert.equal(server.files.size, 4);
  assert.equal(checkpoints.length, 4);
  assert.equal(server.files.get('file-1').parents[0], 'configured-folder');
  assert.equal(server.files.get('file-2').parents[0], 'file-1');
  assert.equal(server.files.get(first.id).parents[0], 'file-2');
  assert.match(server.files.get(first.id).content, /Report upload:\*\* uploaded/);
  const second = await drive.upsertReport(run);
  assert.equal(second.id, first.id);
  assert.equal(second.currentId, first.currentId);
  assert.equal(server.files.size, 4);
  assert.equal(checkpoints.length, 4);
});

test('Actions attempts and revisions keep historical files; stale upload cannot replace current', async () => {
  const server = driveServer(); const run = fixture(); const drive = adapter(server);
  const first = await drive.upsertReport(run);
  run.actionsAttempt = 2;
  run.results[0].status = 'failed';
  const rerun = await drive.upsertReport(run);
  assert.notEqual(first.id, rerun.id);
  assert.equal(first.currentId, rerun.currentId);
  assert.match(server.files.get(first.id).content, /QA outcome:\*\* passed/);
  const currentContent = server.files.get(first.currentId).content;
  run.revision = 'b'.repeat(40);
  const stale = await drive.upsertReport(run, { current: false });
  assert.notEqual(stale.id, rerun.id);
  assert.equal(stale.currentId, undefined);
  assert.equal(server.files.get(first.currentId).content, currentContent);
  assert.equal(server.files.size, 6);
});

test('pre-generated IDs prevent duplicates when a committed upload response is lost', async () => {
  const server = driveServer(); server.loseUploadResponse = true;
  const result = await adapter(server).upsertReport(fixture());
  assert.equal(result.status, 'uploaded');
  assert.equal(server.files.size, 4);
  assert.ok(server.requests.some((r) => r.method === 'PATCH' && r.url.searchParams.get('uploadType') === 'media'));
});

test('failed uploads preserve reserved IDs for restart and do not claim successful report delivery', async () => {
  const server = driveServer(); server.failUploads = true;
  const run = fixture(); let saved;
  await assert.rejects(adapter(server, { maxAttempts: 1, onCheckpoint: async (state) => { saved = JSON.parse(JSON.stringify(state)); } }).upsertReport(run), /HTTP 503/);
  assert.equal(run.report.status, 'pending');
  const reserved = Object.entries(saved.report.driveIds).find(([key]) => key.startsWith('run:'))[1];
  server.failUploads = false;
  const result = await adapter(server).upsertReport(saved);
  assert.equal(result.id, reserved);
  assert.equal(server.files.size, 4);
});

test('Drive missing configuration stays pending and network timeouts are bounded', async () => {
  assert.equal((await new DriveAdapter({ dryRun: false }).upsertReport(fixture())).status, 'pending');
  const drive = new DriveAdapter({ folderId: 'root', accessToken: 'secret', dryRun: false, timeoutMs: 5, maxAttempts: 1, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(drive.upsertReport(fixture()), /timed out/);
});

test('Drive follows partial empty pages and refuses incomplete searches before creating files', async () => {
  const queries = [];
  const drive = new DriveAdapter({ accessToken: 'token', dryRun: false, fetchImpl: async (input) => {
    const url = new URL(input); queries.push(url);
    return response(url.searchParams.get('pageToken') ? { files: [{ id: 'existing' }] } : { files: [], nextPageToken: 'page-2' });
  } });
  assert.deepEqual(await drive.find('parent', { identity: 'key' }), { id: 'existing' });
  assert.equal(queries.length, 2);
  drive.fetchImpl = async () => response({ files: [], incompleteSearch: true });
  await assert.rejects(drive.find('parent', { identity: 'key' }), /search was incomplete/);
});

test('service-account authentication signs and caches a least-scope JWT with a fixed Google audience', async () => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let requests = 0;
  const drive = new DriveAdapter({ dryRun: false, credentials: { client_email: 'qa@example.iam.gserviceaccount.com', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://attacker.invalid/token' }, fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const jwt = new URLSearchParams(options.body).get('assertion');
    const [header, claims, signature] = jwt.split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url')));
    const payload = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/drive.file');
    assert.equal(payload.aud, url);
    assert.equal(payload.exp - payload.iat, 3600);
    assert.equal(payload.sub, undefined);
    return response({ access_token: 'cached-token', expires_in: 3600 });
  } });
  assert.equal(await drive.token(), 'cached-token');
  assert.equal(await drive.token(), 'cached-token');
  assert.equal(requests, 1);
});
