const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function getClient({ appId, privateKey, owner, repo, token }) {
  const { Octokit } = await import('@octokit/rest');
  if (token) return new Octokit({ auth: token, request: { timeout: 20000 } });
  const { createAppAuth } = await import('@octokit/auth-app');
  const app = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey }, request: { timeout: 20000 } });
  const { data: install } = await app.rest.apps.getRepoInstallation({ owner, repo });
  return new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId: install.id }, request: { timeout: 20000 } });
}

async function fetchPR(gh, owner, repo, number, config = {}) {
  const [{ data: pr }, files, comments] = await Promise.all([
    gh.rest.pulls.get({ owner, repo, pull_number: number }),
    gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
  ]);
  const inspectionLimitations = [];
  if (pr.changed_files > files.length) inspectionLimitations.push('GitHub truncated the changed file list');
  for (const f of files) if (!f.patch && f.changes > 0 && !/\.(png|jpg|gif|ico|pdf|lock)$/i.test(f.filename)) inspectionLimitations.push(`Diff unavailable for ${f.filename}`);
  const [{ data: tree }, specifications] = await Promise.all([
    gh.rest.git.getTree({ owner, repo, tree_sha: pr.head.sha, recursive: 'true' }),
    Promise.all((config.specificationPaths || []).map(async file => {
      try {
        const { data } = await gh.rest.repos.getContent({ owner, repo, path: file, ref: pr.head.sha });
        if (data.size > 100000 || !data.content) throw new Error('Specification too large or unavailable');
        return { path: file, content: Buffer.from(data.content, 'base64').toString('utf8') };
      } catch (error) {
        inspectionLimitations.push(`Specification unavailable: ${file}`);
        return { path: file, content: '' };
      }
    })),
  ]);
  if (tree.truncated) inspectionLimitations.push('Repository tree truncated: test discovery incomplete');
  const testPaths = tree.tree.filter(f => f.type === 'blob' && /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$/.test(f.path));
  if (testPaths.length > 40) inspectionLimitations.push('Only the first 40 existing test files were inspected');
  const existingTests = await Promise.all(testPaths.slice(0, 40).map(async f => {
    if (f.size > 50000) return { path: f.path, content: '', limitation: 'Test exceeds inspection size limit' };
    try {
      const { data } = await gh.rest.git.getBlob({ owner, repo, file_sha: f.sha });
      return { path: f.path, content: Buffer.from(data.content, 'base64').toString('utf8').slice(0, 50000) };
    } catch { inspectionLimitations.push(`Existing test unavailable: ${f.path}`); return { path: f.path, content: '' }; }
  }));
  return { repository: `${owner}/${repo}`, number, title: pr.title, body: pr.body || '', url: pr.html_url,
    author: pr.user.login, state: pr.state, revision: pr.head.sha, baseRevision: pr.base.sha,
    labels: (pr.labels || []).map(l => l.name), files: files.map(f => ({ filename: f.filename, patch: f.patch || '', status: f.status })),
    existingTests, specifications, inspectionLimitations,
    comments: comments.map(c => ({ id: c.id, user: c.user?.login, body: c.body, createdAt: c.created_at })) };
}

async function fetchReleasePRs(gh, owner, repo, config, trackedNumbers = []) {
  const args = { owner, repo, state: 'all', per_page: 100 };
  if (config.scope?.milestone) {
    const milestones = await gh.paginate(gh.rest.issues.listMilestones, { owner, repo, state: 'all', per_page: 100 });
    const milestone = milestones.find(m => m.title === config.scope.milestone);
    if (!milestone) throw new Error('Configured QA milestone was not found');
    args.milestone = milestone.number;
  } else args.labels = config.scope?.label || config.needsQaLabel;
  const issues = await gh.paginate(gh.rest.issues.listForRepo, args);
  const numbers = [...new Set([...issues.filter(i => i.pull_request).map(i => i.number), ...trackedNumbers])];
  const prs = [];
  for (const number of numbers) prs.push(await fetchPR(gh, owner, repo, number, config));
  return prs;
}

async function upsertComment(gh, owner, repo, prNumber, marker, body, { dryRun = false } = {}) {
  if (dryRun) return { status: 'preview', body };
  const comments = await gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 });
  // An author-controlled marker must not allow the bot to edit somebody else's comment.
  const existing = comments.find(c => c.user?.type === 'Bot' && (c.body || '').startsWith(marker));
  const full = `${marker}\n${body}`;
  const { data } = existing
    ? await gh.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: full })
    : await gh.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: full });
  return { status: 'sent', id: data.id };
}

async function updateLabels(gh, owner, repo, number, outcome, config, { dryRun = false } = {}) {
  const want = outcome.status === 'passed' ? config.completeLabel : config.needsQaLabel;
  const other = want === config.completeLabel ? config.needsQaLabel : config.completeLabel;
  if (dryRun) return { status: 'preview', want };
  for (const name of [want, other]) {
    try { await gh.rest.issues.getLabel({ owner, repo, name }); }
    catch (error) {
      if (error.status !== 404) throw error;
      try { await gh.rest.issues.createLabel({ owner, repo, name, color: name === config.completeLabel ? '0e8a16' : 'e4e669' }); }
      catch (e) { if (e.status !== 422) throw e; }
    }
  }
  await gh.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [want] });
  try { await gh.rest.issues.removeLabel({ owner, repo, issue_number: number, name: other }); }
  catch (error) { if (error.status !== 404) throw error; }
  return { status: 'sent', label: want };
}

async function workflowRuns(gh, owner, repo) {
  // All pages are needed to recover a long outage without losing older requests.
  return gh.paginate(gh.rest.actions.listWorkflowRuns, { owner, repo, workflow_id: 'qa-execute.yml', per_page: 100 });
}

async function readResultsArtifact(gh, owner, repo, workflow, key) {
  const artifacts = await gh.paginate(gh.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: workflow.id, per_page: 100 });
  const artifact = artifacts.find(a => a.name === `qa-results-${key}-attempt-${workflow.run_attempt}` && !a.expired);
  if (!artifact || artifact.size_in_bytes > 5 * 1024 * 1024) return null;
  const { data } = await gh.rest.actions.downloadArtifact({ owner, repo, artifact_id: artifact.id, archive_format: 'zip' });
  const bytes = Buffer.from(data);
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Result artifact exceeds size limit');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-result-'));
  try {
    const filename = path.join(directory, 'artifact.zip');
    await fs.writeFile(filename, bytes);
    // Never extract or execute artifact content in the privileged controller.
    const { stdout } = await execFileAsync('unzip', ['-p', filename, 'results.json'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

module.exports = { getClient, fetchPR, fetchReleasePRs, upsertComment, updateLabels, workflowRuns, readResultsArtifact };
