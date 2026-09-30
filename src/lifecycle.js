const crypto = require('node:crypto');
const { deriveOutcome } = require('./core');
const { recordDecision } = require('./decisions');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const prKey = pr => `${pr.repository}#${pr.number}`;
const now = () => new Date().toISOString();

function assessPR(state, pr, plan, config, { rerunToken = '' } = {}) {
  if (!/^[a-f0-9]{40}$/i.test(pr.revision || '')) throw new Error('PR must include a full tested revision');
  const assessmentId = digest([pr.repository, pr.number, pr.revision, plan.fingerprint, rerunToken]);
  const previous = state.prs[prKey(pr)];
  const previousRun = previous && state.runs[previous.currentRunKey];
  if (previousRun?.assessmentId === assessmentId) return { run: previousRun, created: false };
  // A deliberate rerun token is idempotent across subsequent duplicate deliveries.
  const duplicate = rerunToken && Object.values(state.runs).find(r => r.assessmentId === assessmentId);
  if (duplicate) return { run: duplicate, created: false };
  // Reverting to an earlier SHA is a fresh assessment, not a resurrection of old QA.
  const key = state.runs[assessmentId] ? digest([assessmentId, previous?.currentRunKey]) : assessmentId;
  if (previous) {
    const old = state.runs[previous.currentRunKey];
    old.supersededAt = now();
    for (const decision of old.decisions) decision.invalidatedAt ||= now();
  }
  const attempt = Object.values(state.runs).filter(r => r.repository === pr.repository && r.pr.number === pr.number && r.revision === pr.revision).length + 1;
  const run = { key, assessmentId, repository: pr.repository, pr: { number: pr.number, title: pr.title, author: pr.author, url: pr.url },
    revision: pr.revision, environment: config.environment || config.execution?.image || 'node:22-bookworm-slim', runId: key, attempt, plan,
    results: [], decisions: [], createdAt: now(), phase: 'queued', report: { status: 'pending' },
    requests: plan.checks.filter(c => c.method === 'human').map(c => ({ checkId: c.id, revision: pr.revision, status: 'open', createdAt: now() })) };
  run.outcome = deriveOutcome(plan, [], [], pr.revision);
  state.runs[key] = run;
  state.prs[prKey(pr)] = { revision: pr.revision, fingerprint: plan.fingerprint, currentRunKey: key };
  return { run, created: true };
}

function isCurrent(state, run) { return state.prs[`${run.repository}#${run.pr.number}`]?.currentRunKey === run.key; }
function errorResults(run, message) {
  return run.plan.checks.filter(c => c.method === 'automated').map(c => ({ checkId: c.id, status: 'execution_error', details: message }));
}
function archiveCompletion(run) {
  if (!run.completionEvent) return;
  run.completionHistory ||= [];
  if (run.completionHistory.some(item => item.event === run.completionEvent)) return;
  const { completionHistory, ...snapshot } = run;
  run.completionHistory.push({ event: run.completionEvent, results: run.results, outcome: run.outcome,
    report: structuredClone(run.report), completedAt: run.completedAt, snapshot: structuredClone(snapshot) });
}
function completeRun(state, key, envelope, workflow) {
  const run = state.runs[key];
  if (!run) throw new Error('Completion does not match a persisted request');
  const eventKey = `${workflow.id}:${workflow.run_attempt}`;
  if (run.completionEvent === eventKey && !run.resultCollectionPending) return { run, duplicate: true };
  if (run.actionsRunId && String(run.actionsRunId) !== String(workflow.id)) return { run, duplicate: true };
  if (run.actionsAttempt && Number(workflow.run_attempt) < run.actionsAttempt) return { run, duplicate: true };
  if (workflow.status && workflow.status !== 'completed') return { run, incomplete: true };
  if (run.completionEvent !== eventKey) archiveCompletion(run);
  if (/^\d+$/.test(String(workflow.id))) run.actionsRunId = String(workflow.id);
  run.actionsAttempt = Number(workflow.run_attempt);
  let error;
  if (!envelope) error = `No structured results: workflow ${workflow.conclusion || 'unknown'}`;
  else if (envelope.schemaVersion !== 1 || envelope.repository !== run.repository || Number(envelope.prNumber) !== run.pr.number ||
    envelope.revision !== run.revision || envelope.environment !== run.environment || envelope.runId !== run.runId ||
    envelope.attempt !== run.attempt || String(envelope.actionsRunId) !== String(workflow.id) || Number(envelope.actionsAttempt) !== Number(workflow.run_attempt)) {
    error = 'Result identity does not match the exact persisted execution request';
  } else if (!Array.isArray(envelope.results)) error = 'Invalid result schema';
  else {
    const allowed = new Set(run.plan.checks.filter(c => c.method === 'automated').map(c => c.id));
    const ids = envelope.results.map(r => r.checkId);
    const statuses = ['passed', 'failed', 'skipped', 'blocked', 'execution_error'];
    if (new Set(ids).size !== ids.length || envelope.results.some(r => !allowed.has(r.checkId) || !statuses.includes(r.status))) error = 'Unexpected or duplicate result records';
    if (envelope.results.some(r => {
      if (!r.counts) return false;
      const { tests, passed, failed, skipped, cancelled = 0 } = r.counts;
      return ![tests, passed, failed, skipped, cancelled].every(n => Number.isSafeInteger(n) && n >= 0)
        || tests < 1 || tests !== passed + failed + skipped + cancelled
        || (r.status === 'passed' && (failed + skipped + cancelled > 0));
    })) error = 'Structured test counts contradict the reported result';
  }
  run.results = error ? errorResults(run, error) : structuredClone(envelope.results);
  if (workflow.conclusion !== 'success') {
    // Even a report saying pass cannot override cancellation, timeout, or job failure.
    const failed = run.results.some(r => r.status === 'failed' || r.status === 'execution_error');
    if (!failed) run.results = errorResults(run, `Workflow concluded ${workflow.conclusion}; QA execution did not complete successfully`);
  }
  run.phase = 'completed';
  run.completedAt = now();
  run.completionEvent = eventKey;
  run.resultCollectionPending = !envelope;
  run.evidenceUrl = workflow.html_url;
  run.outcome = deriveOutcome(run.plan, run.results, run.decisions, run.revision);
  run.report.status = 'pending';
  return { run, duplicate: false };
}

function ingestDecisions(state, run, comments, config) {
  let changed = false;
  for (const comment of comments) {
    const key = `${run.repository}:${comment.id}`;
    if (state.comments[key] || !/^\/qa-tested\b/.test(comment.body || '')) continue;
    const pr = { ...run.pr, revision: run.revision, repository: run.repository };
    const result = recordDecision(comment, run.plan, pr, config);
    if (result.accepted && Date.parse(result.decision.timestamp) < Date.parse(run.createdAt)) {
      result.accepted = false; result.reason = 'Decision predates this QA assessment';
    }
    state.comments[key] = { accepted: result.accepted, reason: result.reason, processedAt: now(), runKey: run.key };
    if (!result.accepted) continue;
    run.decisions.push(result.decision);
    const request = run.requests.find(r => r.checkId === result.decision.checkId);
    if (request) { request.status = 'resolved'; request.decision = result.decision; }
    changed = true;
  }
  if (changed) {
    run.outcome = deriveOutcome(run.plan, run.results, run.decisions, run.revision);
    run.report.status = 'pending';
  }
  return changed;
}

function queueEffect(state, key, type, runKey, payload = {}) {
  state.effects[key] ||= { key, type, runKey, payload, status: 'pending', attempts: 0, createdAt: now() };
  return state.effects[key];
}

async function deliverEffect(state, effect, action, save, { maxAttempts = 5, dryRun = false } = {}) {
  if (effect.status === 'done' || effect.status === 'exhausted') return;
  if (dryRun) return { status: 'preview', type: effect.type }; // No external calls or dedupe consumption.
  if (effect.nextAttemptAt && Date.parse(effect.nextAttemptAt) > Date.now()) return;
  effect.attempts++;
  effect.status = 'pending';
  await save(state); // Record intent before an external write.
  try {
    const receipt = await action();
    if (receipt?.status === 'pending') throw new Error(receipt.reason || 'Integration unavailable');
    effect.status = 'done'; effect.receipt = receipt; effect.completedAt = now();
    delete effect.lastError;
  } catch (error) {
    effect.lastError = String(error.message).slice(0, 300);
    effect.status = effect.attempts >= maxAttempts ? 'exhausted' : 'pending';
    effect.nextAttemptAt = new Date(Date.now() + Math.min(3600000, 30000 * 2 ** effect.attempts)).toISOString();
  }
  await save(state);
}

module.exports = { digest, prKey, assessPR, isCurrent, completeRun, ingestDecisions, queueEffect, deliverEffect, archiveCompletion };
