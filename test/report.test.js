const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReport, reportDocument } = require('../src/report.js');

function fixture() {
  return {
    repository: 'example/app', pr: { number: 12, title: 'Fix checkout', author: 'author', url: 'https://github.com/example/app/pull/12' },
    revision: 'a'.repeat(40), environment: 'isolated synthetic', runId: 'run-1', attempt: 2, actionsRunId: '123', actionsAttempt: 3,
    createdAt: '2026-01-01T00:00:00Z', evidenceUrl: 'https://github.com/example/bot/actions/runs/123',
    plan: { areas: ['Checkout'], journeys: ['Submit an order with a discount'], checks: [{ id: 'unit', method: 'automated', reason: 'Baseline', expected: 'Reject invalid total', support: ['spec/checkout.md'], required: true }, { id: 'visual', method: 'human', question: 'Is contrast sufficient?', required: true }], findings: [{ severity: 'warning', file: 'checkout.js', message: 'Authorization path changed' }], gaps: ['External payment provider not exercised'] },
    results: [{ checkId: 'unit', status: 'failed', details: 'Accepted a negative total', evidence: 'https://github.com/example/bot/actions/runs/123' }],
    decisions: [{ checkId: 'visual', revision: 'b'.repeat(40), responder: 'owner', result: 'pass', explanation: 'Older layout approved', timestamp: '2025-12-01T00:00:00Z' }],
    outcome: { status: 'passed' }, report: { status: 'pending' },
  };
}

test('report derives failure and includes exact identity, evidence, history, questions and limitations', () => {
  const run = fixture();
  const report = renderReport(run);
  assert.equal(reportDocument(run).outcome.status, 'failed');
  for (const text of ['example/app', 'Fix checkout', 'author', run.revision, 'isolated synthetic', 'run-1', '123 / 3', 'spec/checkout.md', 'Accepted a negative total', 'Authorization path changed', 'Is contrast sufficient?', 'Older layout approved', 'Historical; does not apply', 'External payment provider not exercised', '**Report upload:** pending', '**QA outcome:** failed']) assert.ok(report.includes(text), text);
});

test('uploaded report status cannot turn missing execution into successful QA', () => {
  const run = fixture(); run.results = []; run.report.status = 'uploaded';
  assert.equal(reportDocument(run).outcome.status, 'blocked');
  assert.match(renderReport(run), /no execution result recorded/);
});

test('reports keep rows readable and escape embedded HTML', () => {
  const run = fixture(); run.results[0].details = '<script>bad</script> | first\nsecond';
  const report = renderReport(run);
  assert.ok(report.includes('&lt;script&gt;bad&lt;/script&gt; \\| first second'));
  assert.ok(!report.includes('<script>'));
});

test('superseded reports label invalidated decisions even when revision matches the old run', () => {
  const run = fixture();
  run.results[0].status = 'passed';
  run.supersededAt = '2026-02-02T00:00:00Z';
  run.decisions[0].revision = run.revision;
  run.decisions[0].invalidatedAt = run.supersededAt;
  const report = renderReport(run);
  assert.match(report, /Historical run; superseded at 2026-02-02/);
  assert.match(report, /Invalidated 2026-02-02T00:00:00Z; does not apply/);
  assert.doesNotMatch(report, /Current revision/);
  assert.equal(reportDocument(run).outcome.status, 'awaiting_human');
});

test('previous attempts show their own execution identity, status and retained links', () => {
  const run = fixture();
  run.completionHistory = [{ event: '123:2', completedAt: '2026-01-01T00:00:00Z', outcome: { status: 'failed' }, report: { status: 'pending' }, snapshot: {
    actionsRunId: '123', actionsAttempt: 2, outcome: { status: 'failed' },
    evidenceUrl: 'https://github.com/example/bot/actions/runs/123/attempts/2',
    report: { status: 'uploaded', url: 'https://drive.google.com/file/d/previous/view' },
  } }];
  const report = renderReport(run);
  assert.match(report, /Previous execution attempts/);
  assert.match(report, /123 \/ 2/);
  assert.ok(report.includes('[Open historical report](https://drive.google.com/file/d/previous/view)'));
  assert.ok(report.includes('[Open previous run evidence](https://github.com/example/bot/actions/runs/123/attempts/2)'));
});

test('failure evidence uses bounded readable log excerpts and trusted Actions artifact links', () => {
  const run = fixture();
  run.results[0].evidence = [{ type: 'log', path: 'logs/unit.log', url: 'https://untrusted.example/claim-success', excerpt: `AssertionError: negative total\n${'detail\n'.repeat(2000)}` }, { type: 'log', path: '../../secret', excerpt: 'No active links: [claim](https://untrusted.example)' }];
  const report = renderReport(run);
  assert.match(report, /## Failure evidence/);
  assert.match(report, /Artifact path: `logs\/unit.log`/);
  assert.match(report, /    AssertionError: negative total/);
  assert.match(report, /Excerpt truncated/);
  assert.ok(!report.includes('https://untrusted.example/claim-success'));
  assert.ok(!report.includes('../../secret'));
  assert.ok(report.includes('    No active links: [claim](https://untrusted.example)'));
  assert.ok(report.length < 10000);
});

test('reports include affected journeys and actual test counts distinct from check counts', () => {
  const run = fixture();
  run.results[0].counts = { tests: 8, passed: 7, failed: 1, skipped: 0, cancelled: 0 };
  const report = renderReport(run);
  assert.match(report, /Submit an order with a discount/);
  assert.match(report, /Check counts:/);
  assert.match(report, /Tests: 8 total, 7 passed, 1 failed, 0 skipped, 0 cancelled/);
});
