// Reports describe structured results; free-form summaries never decide QA status.
const { deriveOutcome } = require('./core.js');

const value = (v) => v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const cell = (v) => value(v).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const list = (items) => items.length ? items.map((item) => `- ${cell(item)}`).join('\n') : '- None recorded.';
const short = (v, limit = 600) => { const text = value(v); return text.length > limit ? `${text.slice(0, limit)}… (see run artifacts)` : text; };
function link(url, label = url) {
  try { if (new URL(url).protocol === 'https:') return `[${cell(label).replace(/\[/g, '\\[').replace(/\]/g, '\\]')}](${String(url).replace(/[()\s]/g, encodeURIComponent)})`; } catch {}
  return cell(label || 'Not available');
}

function reportDocument(run) {
  const outcome = deriveOutcome(run.plan || { checks: [] }, run.results || [], run.decisions || [], run.revision);
  return { ...run, outcome };
}

function testCountSummary(results = []) {
  const keys = ['tests', 'passed', 'failed', 'skipped', 'cancelled'];
  const reported = results.filter((result) => result.counts && keys.every((key) => Number.isSafeInteger(result.counts[key]) && result.counts[key] >= 0));
  if (!reported.length) return 'Tests: per-test counts are unavailable; check outcomes are recorded separately.';
  const counts = Object.fromEntries(keys.map((key) => [key, reported.reduce((sum, result) => sum + result.counts[key], 0)]));
  return `Tests: ${counts.tests} total, ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.cancelled} cancelled${reported.length < results.length ? ` (counts supplied by ${reported.length} of ${results.length} executed checks)` : ''}.`;
}

function evidenceEntries(result) {
  return Array.isArray(result.evidence) ? result.evidence.filter((entry) => entry && typeof entry === 'object') : [];
}

function logPath(entry) {
  const path = String(entry.path || '');
  return /^logs\/[A-Za-z0-9_./-]{1,180}$/.test(path) && !path.split('/').includes('..') ? path : undefined;
}

function evidenceSummary(result, run) {
  const entries = evidenceEntries(result);
  const paths = entries.map(logPath).filter(Boolean);
  const supplied = Array.isArray(result.evidence) ? result.evidence.length > 0 : Boolean(result.evidence);
  const summary = paths.length ? paths.slice(0, 2).map(cell).join(', ') : supplied ? 'Evidence reference recorded' : 'No per-check evidence recorded';
  return `${summary}${run.evidenceUrl ? `; ${link(run.evidenceUrl, 'run artifacts')}` : ''}`;
}

function failureEvidence(results, run) {
  const failures = results.filter((result) => ['failed', 'execution_error'].includes(result.status));
  if (!failures.length) return ['No automated failures or execution errors recorded.'];
  const lines = [run.evidenceUrl ? `Full logs: ${link(run.evidenceUrl, 'open the GitHub Actions run and its artifacts')}.` : 'Full log link is unavailable.'];
  for (const result of failures.slice(0, 8)) {
    lines.push('', `### ${cell(result.checkId)} (${cell(result.status)})`, '', cell(short(result.details || result.error)));
    const entries = evidenceEntries(result).slice(0, 2);
    for (const entry of entries) {
      lines.push('', `Artifact path: ${logPath(entry) ? `\`${logPath(entry)}\`` : 'not available'}.`);
      if (typeof entry.excerpt === 'string' && entry.excerpt) {
        // Indented code prevents log text from becoming links or Markdown markup.
        const clean = entry.excerpt.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
        const excerpt = clean.slice(0, 1500).split(/\r?\n/).slice(0, 24).join('\n');
        lines.push('', 'Log excerpt (test output; truncated when necessary):', '', ...excerpt.split('\n').map((line) => `    ${line}`));
        if (excerpt.length < clean.length) lines.push('', 'Excerpt truncated; see the full log artifact.');
      }
    }
    if (!entries.length) lines.push('', 'No inline log excerpt is available; use the run artifacts.');
  }
  if (failures.length > 8) lines.push('', `${failures.length - 8} additional failed checks are listed in the results; see run artifacts for their evidence.`);
  return lines;
}

function decisionApplicability(decision, run) {
  if (decision.invalidatedAt) return `Invalidated ${cell(decision.invalidatedAt)}; does not apply`;
  if (run.supersededAt) return 'Historical; run superseded and does not establish current QA';
  return decision.revision === run.revision ? 'Current revision' : 'Historical; does not apply';
}

function runHistory(run) {
  const history = run.completionHistory || [];
  if (!history.length) return ['No previous execution attempts recorded for this assessment.'];
  return ['| Actions run / attempt | Completed | Recorded outcome | Historical report | Test evidence |',
    '| --- | --- | --- | --- | --- |',
    ...history.map((entry) => {
      const snapshot = entry.snapshot || entry;
      const event = String(entry.event || '').match(/^(\d+):(\d+)$/);
      const id = snapshot.actionsRunId || event?.[1] || 'Not recorded';
      const attempt = snapshot.actionsAttempt || event?.[2] || 'Not recorded';
      const report = snapshot.report || entry.report;
      return `| ${cell(id)} / ${cell(attempt)} | ${cell(snapshot.completedAt || entry.completedAt)} | ${cell(snapshot.outcome?.status || entry.outcome?.status || 'Not recorded')} | ${report?.status === 'uploaded' && report.url ? link(report.url, 'Open historical report') : 'Report upload pending'} | ${snapshot.evidenceUrl ? link(snapshot.evidenceUrl, 'Open previous run evidence') : 'Not recorded'} |`;
    })];
}

function renderReport(input) {
  const run = reportDocument(input);
  const pr = run.pr || {};
  const plan = run.plan || {};
  const checks = plan.checks || [];
  const results = run.results || [];
  const decisions = run.decisions || [];
  return [
    `# QA report: ${cell(run.repository)} #${cell(pr.number)}`, '',
    `**PR:** ${link(pr.url, pr.title || `#${pr.number}`)}`,
    `**Author:** ${cell(pr.author)}`,
    `**Tested revision:** ${cell(run.revision)}`,
    `**Environment:** ${cell(run.environment)}`,
    `**Run ID / attempt:** ${cell(run.runId)} / ${cell(run.attempt)}`,
    ...(run.actionsRunId ? [`**GitHub Actions run / attempt:** ${cell(run.actionsRunId)} / ${cell(run.actionsAttempt || 1)}`] : []),
    `**Created:** ${cell(run.createdAt)}`,
    ...(run.supersededAt ? [`**Applicability:** Historical run; superseded at ${cell(run.supersededAt)}. This report does not establish QA for the current PR revision.`] : []),
    `**QA outcome:** ${cell(run.outcome.status)}`,
    `**Check counts:** ${Object.entries(run.outcome.counts || {}).map(([k, v]) => `${cell(k)}: ${v}`).join(', ')}`,
    `**${testCountSummary(results)}**`,
    `**Report upload:** ${cell(run.report?.status || 'pending')}`,
    `**Test evidence:** ${run.evidenceUrl ? link(run.evidenceUrl) : 'Not available.'}`, '',
    '## Affected areas', list(plan.areas || []), '',
    '## Affected user journeys', list(plan.journeys || []), '',
    '## QA plan', '',
    '| Check ID | Reason / supporting requirement | Expected result | Execution method | Required |',
    '| --- | --- | --- | --- | --- |',
    ...checks.map((c) => `| ${cell(c.id)} | ${cell(c.reason)}; ${cell(c.supporting || c.support || c.source || c.sources || c.files)} | ${cell(c.expected || c.expectedResult)} | ${cell(c.method || c.execution || c.runner || c.type)} | ${c.required === false ? 'No' : 'Yes'} |`), '',
    '## Executed checks and results', '',
    '| Check ID | Status | Details | Evidence |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${cell(r.checkId)} | ${cell(r.status)} | ${cell(short(r.details || r.error))} | ${evidenceSummary(r, run)} |`), '',
    '## Failure evidence', ...failureEvidence(results, run), '',
    '## Static-analysis findings', list((plan.findings || []).map((f) => typeof f === 'string' ? f : `${f.severity || 'Info'}: ${f.message || f.description || value(f)}${f.file ? ` (${f.file})` : ''}`)), '',
    '## Skipped, blocked, or untested areas',
    list([
      ...results.filter((r) => !['passed', 'failed'].includes(r.status)).map((r) => `${r.checkId}: ${r.status}${r.details ? ` — ${value(r.details)}` : ''}`),
      ...checks.filter((c) => !results.some((r) => r.checkId === c.id)).map((c) => `${c.id}: ${c.method === 'human' || c.type === 'human' ? 'human decision (see below)' : 'no execution result recorded'}`),
    ]), '',
    '## Human questions and decisions',
    list(checks.filter((c) => c.method === 'human' || c.type === 'human' || c.question).map((c) => `${c.id}: ${c.question || c.expected || c.reason}`)), '',
    '| Check ID | Decision | Responder | Explanation | Timestamp | Revision | Applicability |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...decisions.map((d) => `| ${cell(d.checkId)} | ${cell(d.decision || d.status || d.result)} | ${cell(d.responder)} | ${cell(d.explanation)} | ${cell(d.timestamp || d.createdAt)} | ${cell(d.revision)} | ${decisionApplicability(d, run)} |`), '',
    '## Previous execution attempts', ...runHistory(run), '',
    '## Remaining limitations',
    list([...(plan.gaps || []), ...(run.limitations || []), ...(run.outcome.pending || []).map((c) => `Required check remains ${c.status}: ${c.id || c.checkId}`)]), '',
    'Outcome is calculated from structured results and applicable decisions. Report availability is independent of QA outcome.', '',
  ].join('\n');
}

module.exports = { renderReport, reportDocument, testCountSummary };
