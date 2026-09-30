const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const emptyState = () => ({ version: 1, prs: {}, runs: {}, effects: {}, comments: {} });
function validateState(value) {
  if (value.version !== 1 || !value.prs || !value.runs || !value.effects || !value.comments) throw new Error('Invalid state; refusing to discard durable history');
  return value;
}

// A process lock and atomic rename prevent lost updates, even across CLI processes.
class FileStore {
  constructor(directory) { this.directory = directory; this.filename = path.join(directory, 'state.json'); }
  async load() {
    try { return validateState(JSON.parse(await fs.readFile(this.filename, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
  }
  async save(state) {
    await fs.mkdir(this.directory, { recursive: true });
    const temp = `${this.filename}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(validateState(state), null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, this.filename);
  }
  async withLock(fn) {
    await fs.mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, 'state.lock');
    let handle;
    for (let i = 0; i < 100; i++) {
      try { handle = await fs.open(lock, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Do not reclaim locks by PID or age: that races another reclaimer.
        // After a crash an operator can remove the lock once all local workers stop.
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (!handle) throw new Error('State locked: stop local workers before removing a stale state.lock');
    await handle.writeFile(String(process.pid));
    try { return await fn(await this.load(), state => this.save(state)); }
    finally { await handle.close(); await fs.unlink(lock); }
  }
}

// GitHub Contents uses blob SHA compare-and-swap. A durable lease complements the
// workflow concurrency group and also excludes other controller installations.
class GitHubStore {
  constructor({ gh, owner, repo, branch = 'qa-state', baseRef = 'main', dryRun = false }) {
    Object.assign(this, { gh, owner, repo, branch, baseRef, dryRun });
  }
  async ensureBranch() {
    if (this.dryRun) return;
    const { gh, owner, repo, branch, baseRef } = this;
    try { await gh.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }); }
    catch (error) {
      if (error.status !== 404) throw error;
      const { data } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${baseRef}` });
      try { await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: data.object.sha }); }
      catch (e) { if (e.status !== 422) throw e; }
    }
  }
  async load() {
    try {
      const { data } = await this.gh.rest.repos.getContent({ owner: this.owner, repo: this.repo, path: 'state.json', ref: this.branch });
      this.sha = data.sha;
      // The Contents endpoint omits inline content for files larger than 1 MiB.
      const blob = data.content ? data : (await this.gh.rest.git.getBlob({ owner: this.owner, repo: this.repo, file_sha: data.sha })).data;
      return validateState(JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')));
    } catch (error) { if (error.status !== 404) throw error; this.sha = undefined; return emptyState(); }
  }
  async save(state) {
    if (this.dryRun) return;
    const { data } = await this.gh.rest.repos.createOrUpdateFileContents({ owner: this.owner, repo: this.repo,
      branch: this.branch, path: 'state.json', sha: this.sha,
      message: 'chore: persist QA run state', content: Buffer.from(JSON.stringify(validateState(state))).toString('base64') });
    this.sha = data.content.sha;
  }
  async putRequest(key, request) {
    if (this.dryRun) return;
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid request key');
    const args = { owner: this.owner, repo: this.repo, path: `requests/${key}.json`, ref: this.branch };
    try {
      const { data } = await this.gh.rest.repos.getContent(args);
      const existing = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(request)) throw new Error('Immutable execution request conflict');
    } catch (error) {
      if (error.status !== 404) throw error;
      await this.gh.rest.repos.createOrUpdateFileContents({ owner: this.owner, repo: this.repo, branch: this.branch,
        path: args.path, message: `chore: queue QA request ${key.slice(0, 12)}`, content: Buffer.from(JSON.stringify(request)).toString('base64') });
    }
  }
  async withLock(fn) {
    if (this.dryRun) return fn(await this.load(), async () => {});
    await this.ensureBranch();
    const state = await this.load();
    const now = Date.now();
    if (state.lease && Date.parse(state.lease.expiresAt) > now) throw new Error('Another controller holds the state lease; next reconciliation will retry');
    state.lease = { id: crypto.randomUUID(), expiresAt: new Date(now + 20 * 60 * 1000).toISOString() };
    await this.save(state); // CAS conflict aborts before side effects.
    try { return await fn(state, value => this.save(value)); }
    finally { delete state.lease; await this.save(state); }
  }
}

module.exports = { emptyState, validateState, FileStore, GitHubStore };
