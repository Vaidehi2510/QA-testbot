// QA is derived exclusively from structured check outcomes and authorized decisions.
const STATUSES = ['passed', 'failed', 'skipped', 'blocked', 'execution_error', 'awaiting_human'];

function deriveOutcome(plan, results = [], decisions = [], revision) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const pending = [];
  const checkResults = [];
  const requiredStatuses = [];
  const automatedStatuses = [];
  for (const check of plan.checks || []) {
    let status;
    let source;
    if (check.method === 'human') {
      // The recording boundary enforces authorization. Only the exact revision applies.
      source = decisions.filter((decision) => !decision.invalidatedAt && decision.checkId === check.id && decision.revision === revision)
        .sort((left, right) => (Date.parse(left.timestamp) || 0) - (Date.parse(right.timestamp) || 0)).at(-1);
      status = source?.result === 'pass' ? 'passed' : source?.result === 'fail' ? 'failed' : 'awaiting_human';
    } else if (check.method === 'analysis') {
      // Set only by the trusted AI coordinator, never by a model's free-form
      // verdict. This records review completion separately from executed tests.
      status = check.revision === revision && ['passed', 'execution_error'].includes(check.analysisStatus) ? check.analysisStatus : 'blocked';
    } else if (check.method === 'automated') {
      const matches = results.filter((result) => result.checkId === check.id && (!result.revision || result.revision === revision));
      // Duplicate/conflicting reports are an ingestion error, never an opportunity to choose a pass.
      source = matches[0];
      status = matches.length > 1 ? 'execution_error' : source ?
        STATUSES.includes(source.status) && source.status !== 'awaiting_human' ? source.status : 'execution_error' : 'blocked';
      automatedStatuses.push(status);
    } else status = 'blocked';
    counts[status]++;
    checkResults.push({ checkId: check.id, status, ...(source ? { source } : {}) });
    if (check.required !== false) {
      requiredStatuses.push(status);
      if (status !== 'passed') pending.push({ ...check, status });
    }
  }
  // An empty plan cannot assert a successful test run.
  let status = 'blocked';
  if (requiredStatuses.length) {
    status = ['failed', 'execution_error', 'blocked', 'skipped', 'awaiting_human'].find((candidate) => requiredStatuses.includes(candidate)) || 'passed';
  }
  return { status, counts, automatedPassed: automatedStatuses.length > 0 && automatedStatuses.every((value) => value === 'passed'), pending, checkResults };
}

module.exports = { deriveOutcome, STATUSES };
