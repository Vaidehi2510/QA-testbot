const crypto = require('node:crypto');
const { renderReport } = require('./report.js');

const API = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER = 'application/vnd.google-apps.folder';
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const queryValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const safeName = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
const properties = (run, kind) => ({
  managedBy: 'qa-testbot', kind, repository: digest(run.repository), pr: String(run.pr.number),
  ...(kind === 'run' ? { runId: String(run.runId).slice(0, 80), attempt: String(run.attempt), revision: String(run.revision).slice(0, 80), actionsRunId: String(run.actionsRunId || ''), actionsAttempt: String(run.actionsAttempt || '') } : {}),
  identity: digest(JSON.stringify(kind === 'repository' ? [run.repository] : kind === 'run' ? [run.repository, run.pr.number, run.runId, run.attempt, run.revision, run.actionsRunId, run.actionsAttempt] : [run.repository, run.pr.number, kind])),
});

class DriveError extends Error {
  constructor(message, status) { super(message); this.name = 'DriveError'; this.status = status; }
}

class DriveAdapter {
  constructor({ folderId, sharedDriveId, credentials, accessToken, getAccessToken, fetchImpl = globalThis.fetch, dryRun = /^(true|1|yes)$/i.test(process.env.DRY_RUN || ''), timeoutMs = 10000, maxAttempts = 3, onCheckpoint = async () => {} } = {}) {
    Object.assign(this, { folderId, sharedDriveId, credentials, accessToken, getAccessToken, fetchImpl, dryRun, timeoutMs, onCheckpoint });
    this.maxAttempts = Math.max(1, Math.min(5, maxAttempts));
  }

  async rawRequest(url, options) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await this.fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
            if (!response.ok) throw new DriveError(`Google Drive request failed (HTTP ${response.status})`, response.status);
            return await response.json();
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DriveError('Google Drive request timed out')); }, this.timeoutMs); }),
        ]);
      } catch (error) {
        const status = error.status;
        if (attempt === this.maxAttempts || (status && status !== 429 && status < 500)) {
          throw error instanceof DriveError ? error : new DriveError('Google Drive network request failed');
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * 2 ** (attempt - 1))));
      } finally { clearTimeout(timer); }
    }
  }

  async token() {
    if (this.getAccessToken) {
      let token;
      try { token = await this.getAccessToken(); } catch { throw new DriveError('Google Drive access-token callback failed'); }
      if (!token || typeof token !== 'string') throw new DriveError('Google Drive access-token callback returned no token');
      return token;
    }
    if (this.accessToken) return this.accessToken;
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) return this.cachedToken;
    let credentials;
    try { credentials = typeof this.credentials === 'string' ? JSON.parse(this.credentials) : this.credentials; } catch { throw new DriveError('Invalid Google Drive service-account JSON'); }
    if (!credentials?.client_email || !credentials?.private_key) throw new DriveError('Google Drive credentials are not configured');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/drive.file', aud: TOKEN_URL, iat: now, exp: now + 3600 })).toString('base64url');
    let signature;
    try { signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), credentials.private_key).toString('base64url'); } catch { throw new DriveError('Invalid Google Drive service-account private key'); }
    const response = await this.rawRequest(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString(),
    });
    if (!response.access_token) throw new DriveError('Google Drive token exchange returned no access token');
    this.cachedToken = response.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(0, (Number(response.expires_in || 3600) - 60) * 1000);
    return this.cachedToken;
  }

  async request(path, { method = 'GET', headers, body, query = {}, upload = false } = {}) {
    const token = await this.token();
    const url = new URL(`${upload ? 'https://www.googleapis.com/upload/drive/v3' : API}${path}`);
    for (const [key, val] of Object.entries(query)) if (val !== undefined) url.searchParams.set(key, String(val));
    return this.rawRequest(url.toString(), { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  }

  async find(parent, appProperties) {
    const query = { q: `'${queryValue(parent)}' in parents and trashed = false and appProperties has { key='identity' and value='${queryValue(appProperties.identity)}' }`, fields: 'files(id,webViewLink),nextPageToken,incompleteSearch', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true };
    if (this.sharedDriveId) Object.assign(query, { driveId: this.sharedDriveId, corpora: 'drive' });
    const files = [];
    for (let page = 0; page < 10; page++) {
      const data = await this.request('/files', { query });
      if (data.incompleteSearch) throw new DriveError('Google Drive search was incomplete; refusing to create duplicate reports');
      files.push(...(data.files || []));
      if (files.length > 1) throw new DriveError('Duplicate managed Drive report identities require reconciliation');
      if (!data.nextPageToken) return files[0];
      query.pageToken = data.nextPageToken;
    }
    throw new DriveError('Google Drive search exceeded its page limit');
  }

  async reserve(run, key) {
    run.report ||= { status: 'pending' };
    run.report.driveIds ||= {};
    if (!run.report.driveIds[key]) {
      const response = await this.request('/files/generateIds', { query: { count: 1, space: 'drive', type: 'files' } });
      if (!response.ids?.[0]) throw new DriveError('Google Drive did not reserve an ID');
      run.report.driveIds[key] = response.ids[0];
      await this.onCheckpoint(run);
    }
    return run.report.driveIds[key];
  }

  async upsert(run, { parent, name, kind, content }) {
    const appProperties = properties(run, kind);
    const found = await this.find(parent, appProperties);
    const id = found?.id || await this.reserve(run, `${kind}:${appProperties.identity}`);
    if (kind === 'repository' || kind === 'pr') {
      if (found) return found;
      try {
        return await this.request('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, mimeType: FOLDER, parents: [parent], appProperties }), query: { supportsAllDrives: true, fields: 'id,webViewLink' } });
      } catch (error) {
        if (error.status === 409) return this.request(`/files/${encodeURIComponent(id)}`, { query: { supportsAllDrives: true, fields: 'id,webViewLink' } });
        throw error;
      }
    }
    const metadata = { name, mimeType: 'text/markdown', appProperties, ...(!found ? { id, parents: [parent] } : {}) };
    const boundary = `qa_${crypto.randomBytes(16).toString('hex')}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    try {
      return await this.request(found ? `/files/${encodeURIComponent(id)}` : '/files', { method: found ? 'PATCH' : 'POST', upload: true, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body, query: { uploadType: 'multipart', supportsAllDrives: true, fields: 'id,webViewLink' } });
    } catch (error) {
      if (error.status === 409) {
        // Re-apply content after a committed create whose response was lost.
        return this.request(`/files/${encodeURIComponent(id)}`, { method: 'PATCH', upload: true, headers: { 'Content-Type': 'text/markdown; charset=UTF-8' }, body: content, query: { uploadType: 'media', supportsAllDrives: true, fields: 'id,webViewLink' } });
      }
      throw error;
    }
  }

  async upsertReport(run, { current = true } = {}) {
    const markdown = renderReport(run);
    if (this.dryRun) return { status: 'preview', markdown, path: `${safeName(run.repository)}/PR-${run.pr.number}/run-${safeName(run.runId)}-attempt-${run.attempt}.md` };
    if (!this.folderId) return { status: 'pending', reason: 'Google Drive folder is not configured' };
    if (!this.credentials && !this.accessToken && !this.getAccessToken) return { status: 'pending', reason: 'Google Drive authentication is not configured' };
    const repository = await this.upsert(run, { parent: this.folderId, name: safeName(run.repository), kind: 'repository' });
    const pr = await this.upsert(run, { parent: repository.id, name: `PR-${run.pr.number}`, kind: 'pr' });
    const content = renderReport({ ...run, report: { ...run.report, status: 'uploaded' } });
    const execution = run.actionsRunId ? `-actions-${safeName(run.actionsRunId)}-${run.actionsAttempt || 1}` : '';
    const historical = await this.upsert(run, { parent: pr.id, name: `run-${safeName(run.runId)}-attempt-${run.attempt}${execution}-${safeName(run.revision)}.md`, kind: 'run', content });
    const summary = current ? await this.upsert(run, { parent: pr.id, name: 'current.md', kind: 'current', content }) : undefined;
    return { status: 'uploaded', id: historical.id, url: historical.webViewLink || `https://drive.google.com/file/d/${historical.id}/view`, ...(summary ? { currentId: summary.id, currentUrl: summary.webViewLink || `https://drive.google.com/file/d/${summary.id}/view` } : {}), driveIds: { ...run.report?.driveIds } };
  }
}

module.exports = { DriveAdapter, DriveError };
