const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const crypto = require('node:crypto');
const { githubSnapshot } = require('./ai/snapshot');
const { screenshotType } = require('./images');

function targetAccessMode(config = {}) {
  const mode = config.targetAccess ?? 'report-status';
  if (!['read-only', 'report-status'].includes(mode)) throw new Error('targetAccess must be read-only or report-status');
  return mode;
}

function assertRepositorySeparation(config, targetRepository, botRepository) {
  targetAccessMode(config);
  for (const name of [targetRepository, botRepository]) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(name)
      || ['.', '..'].includes(name.split('/')[1]) || /\.git$/i.test(name)) throw new Error('Target and bot repositories must use distinct owner/repository names');
  }
  if (String(targetRepository).toLowerCase() === String(botRepository).toLowerCase()) {
    throw new Error('Product code must remain unchanged: use a separate BOT_REPOSITORY for bot state, workflows, and reports');
  }
}

function selectedPRNumbers(config = {}, prNumber) {
  const configured = config.scope?.prNumbers;
  if (configured !== undefined && (!Array.isArray(configured) || configured.length > 100
    || configured.some(number => !Number.isSafeInteger(number) || number < 1))) throw new Error('scope.prNumbers must contain at most 100 positive integer PR numbers');
  if (prNumber !== undefined && prNumber !== null && prNumber !== '') {
    if (!/^\d+$/.test(String(prNumber)) || !Number.isSafeInteger(Number(prNumber)) || Number(prNumber) < 1) throw new Error('PR_NUMBER must be a positive integer');
    return [Number(prNumber)];
  }
  return configured?.length ? [...new Set(configured)] : null;
}

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
  const aiSnapshot = config.ai?.enabled ? await githubSnapshot(gh, owner, repo, pr.head.sha, tree.tree, files, config.ai) : {};
  return { repository: `${owner}/${repo}`, number, title: pr.title, body: pr.body || '', url: pr.html_url,
    author: pr.user.login, state: pr.state, revision: pr.head.sha, baseRevision: pr.base.sha,
    labels: (pr.labels || []).map(l => l.name), files: files.map(f => ({ filename: f.filename, patch: f.patch || '', status: f.status })),
    existingTests, specifications, inspectionLimitations, ...aiSnapshot,
    comments: comments.map(c => ({ id: c.id, user: c.user?.login, body: c.body, createdAt: c.created_at })) };
}

async function fetchReleasePRs(gh, owner, repo, config, trackedNumbers = [], { prNumber } = {}) {
  const explicit = selectedPRNumbers(config, prNumber);
  if (explicit) {
    const prs = [];
    for (const number of explicit) prs.push(await fetchPR(gh, owner, repo, number, config));
    return prs;
  }
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

async function upsertComment(gh, owner, repo, prNumber, marker, body, { dryRun = false, targetAccess } = {}) {
  if (targetAccessMode({ targetAccess }) === 'read-only') return { status: 'skipped', reason: 'Target repository is read-only' };
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
  if (targetAccessMode(config) === 'read-only') return { status: 'skipped', reason: 'Target repository is read-only' };
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

// Keep the target write boundary explicit even if a caller bypasses reconcile.
// These adapters only publish QA metadata and never change product source files.
function createTargetReporters(gh, owner, repo, config = {}, { dryRun = false } = {}) {
  const mode = targetAccessMode(config);
  const skipped = () => ({ status: 'skipped', reason: 'Target repository is read-only' });
  return {
    async plan(run) {
      if (mode === 'read-only') return skipped();
      return upsertComment(gh, owner, repo, run.pr.number, '<!-- qa-plan:auto -->', `${run.plan.markdown}\n\nTested revision: \`${run.revision}\`.\nHuman responses: \`/qa-tested check:<id> revision:${run.revision} result:pass|fail reason:<explanation>\`.`, { dryRun, targetAccess: mode });
    },
    async status(run) {
      if (mode === 'read-only') return skipped();
      if (!dryRun) {
        const outcome = run.outcome.status;
        await gh.rest.repos.createCommitStatus({ owner, repo, sha: run.revision, context: 'qa-bot',
          state: outcome === 'passed' ? 'success' : outcome === 'failed' ? 'failure' : outcome === 'execution_error' ? 'error' : 'pending',
          description: `QA ${outcome}; attempt ${run.attempt}`.slice(0, 140), target_url: run.evidenceUrl || run.pr.url });
      }
      return updateLabels(gh, owner, repo, run.pr.number, run.outcome, config, { dryRun });
    },
  };
}

async function workflowRuns(gh, owner, repo) {
  // All pages are needed to recover a long outage without losing older requests.
  return gh.paginate(gh.rest.actions.listWorkflowRuns, { owner, repo, workflow_id: 'qa-execute.yml', per_page: 100 });
}

async function readResultsArtifact(gh, owner, repo, workflow, key) {
  const artifacts = await gh.paginate(gh.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: workflow.id, per_page: 100 });
  const artifact = artifacts.find(a => a.name === `qa-results-${key}-attempt-${workflow.run_attempt}` && !a.expired);
  if (!artifact || artifact.size_in_bytes > 16 * 1024 * 1024) return null;
  const { data } = await gh.rest.actions.downloadArtifact({ owner, repo, artifact_id: artifact.id, archive_format: 'zip' });
  const bytes = Buffer.from(data);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Result artifact exceeds size limit');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-result-'));
  try {
    const filename = path.join(directory, 'artifact.zip');
    await fs.writeFile(filename, bytes);
    // Never extract or execute artifact content in the privileged controller.
    const { stdout } = await execFileAsync('unzip', ['-p', filename, 'results.json'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const envelope = JSON.parse(stdout);
    const screenshots = [];
    let imageBytes = 0;
    const limitations = Array.isArray(envelope.screenshotLimitations) ? envelope.screenshotLimitations.filter(value => typeof value === 'string').slice(0, 30) : [];
    for (const item of (Array.isArray(envelope.screenshots) ? envelope.screenshots : []).slice(0, 4)) {
      try {
        if (!/^screenshots\/[a-f0-9]{64}\.(png|jpg)$/.test(item.path || '') || item.revision !== envelope.revision ||
          !envelope.results?.some(result => result.checkId === item.checkId)) throw new Error('Invalid screenshot identity');
        const { stdout: image } = await execFileAsync('unzip', ['-p', filename, item.path], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
        imageBytes += image.length;
        if (imageBytes > 6 * 1024 * 1024 || crypto.createHash('sha256').update(image).digest('hex') !== item.sha256) throw new Error('Screenshot size/hash mismatch');
        const type = screenshotType(image);
        if (!type || type.mimeType !== item.mimeType) throw new Error('Screenshot signature or dimensions mismatch');
        screenshots.push({ name: String(item.name || item.path).slice(0, 150), path: item.path, mimeType: item.mimeType, sha256: item.sha256,
          revision: item.revision, checkId: item.checkId, data: image.toString('base64') });
      } catch { limitations.push('Screenshot evidence was missing, oversized, or invalid; visual coverage is incomplete.'); }
    }
    return { ...envelope, screenshots, screenshotLimitations: limitations };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function readRunScreenshots(gh, owner, repo, run) {
  const envelope = await readResultsArtifact(gh, owner, repo, { id: Number(run.actionsRunId), run_attempt: run.actionsAttempt }, run.key);
  if (envelope?.schemaVersion !== 1 || envelope.repository !== run.repository || Number(envelope.prNumber) !== run.pr.number ||
    envelope.revision !== run.revision || envelope.environment !== run.environment || envelope.runId !== run.runId ||
    envelope.attempt !== run.attempt || String(envelope.actionsRunId) !== String(run.actionsRunId) || Number(envelope.actionsAttempt) !== Number(run.actionsAttempt)) {
    throw new Error('Screenshot report identity changed');
  }
  const expected = run.screenshots || [];
  const images = envelope.screenshots || [];
  if (images.length !== expected.length || images.some(image => !expected.some(item => item.path === image.path && item.sha256 === image.sha256 &&
    item.checkId === image.checkId && item.revision === image.revision && item.mimeType === image.mimeType))) throw new Error('Screenshot manifest changed');
  return images;
}

module.exports = { getClient, fetchPR, fetchReleasePRs, upsertComment, updateLabels, workflowRuns, readResultsArtifact, readRunScreenshots,
  targetAccessMode, assertRepositorySeparation, selectedPRNumbers, createTargetReporters };
