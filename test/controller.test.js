const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../src/run');
const { emptyState } = require('../src/state');
const config = { environment: 'synthetic', dispatchTimeoutMinutes: 30, maxIntegrationAttempts: 2,
  runners: [{ id: 'node-tests', type: 'node-test', baseline: true, files: ['calculator.test.js'] }], decisionReviewers: ['owner'] };
const pr = { repository: 'acme/app', number: 1, title: 'Shipping boundary', body: 'Orders >=100 ship free.', author: 'author', revision: 'a'.repeat(40),
  files: [{ filename: 'calculator.js', patch: '+ return amount >= 100 ? 0 : 5;' }], existingTests: [{ path: 'calculator.test.js' }], comments: [] };
function fixture() {
  const state = emptyState(), calls = [];
  let envelope;
  const integrations = { putRequest: async () => calls.push('request'), dispatch: async () => { calls.push('dispatch'); return { status: 'sent' }; },
    plan: async () => { calls.push('plan'); return { status: 'sent' }; }, status: async run => { calls.push(`status:${run.outcome.status}`); return { status: 'sent' }; },
    readResults: async () => envelope, currentRevision: async () => pr.revision,
    slack: { send: async text => { calls.push(text); return { status: 'sent' }; } },
    drive: { upsertReport: async () => { calls.push('drive'); return { status: 'uploaded', url: 'https://drive.google.com/file/d/report/view' }; } } };
  const options = { state, save: async () => {}, config, rules: [], people: [], prs: [pr], integrations, log: () => {} };
  const completion = () => {
    const run = Object.values(state.runs)[0];
    envelope = { schemaVersion: 1, repository: run.repository, prNumber: run.pr.number, revision: run.revision, environment: run.environment,
      runId: run.runId, attempt: run.attempt, actionsRunId: '7', actionsAttempt: 1, results: [{ checkId: 'runner-node-tests', status: 'passed' }] };
    return [{ id: 7, run_attempt: 1, event: 'workflow_dispatch', path: '.github/workflows/qa-execute.yml', display_title: `QA execution ${run.key}`,
      status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/bot/actions/runs/7' }];
  };
  return { options, calls, completion };
}
test('full controller queues once, notifies immediately before upload, and recovers the Drive link', async () => {
  const { options, calls, completion } = fixture();
  await reconcile(options);
  assert.equal(calls.filter(c => c === 'dispatch').length, 1);
  const workflows = completion();
  await reconcile({ ...options, workflows });
  const notification = calls.findIndex(c => c.includes('*QA result*'));
  assert.ok(notification >= 0 && notification < calls.indexOf('drive'));
  assert.match(calls[notification], /report upload pending/);
  assert.ok(calls.some(c => c.includes('QA report available')));
  const count = calls.length;
  await reconcile({ ...options, workflows });
  assert.equal(calls.length, count);
});
test('Drive outage retains markdown and retries without changing passing tests', async () => {
  const { options, calls, completion } = fixture();
  await reconcile(options);
  options.integrations.drive.upsertReport = async () => { throw new Error('Drive unavailable'); };
  await reconcile({ ...options, workflows: completion() });
  const run = Object.values(options.state.runs)[0];
  assert.equal(run.outcome.status, 'passed');
  assert.equal(run.report.status, 'pending');
  assert.match(run.report.markdown, /Shipping boundary/);
  assert.ok(calls.some(c => c.includes('*QA result*')));
});
test('dry-run does not dispatch, post, upload or mutate GitHub', async () => {
  const { options, calls } = fixture();
  const before = structuredClone(options.state);
  options.save = async () => { throw new Error('dry-run attempted persistence'); };
  await reconcile({ ...options, dryRun: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(options.state, before);
});
test('unrelated workflow/artifact cannot complete a run', async () => {
  const { options, completion } = fixture();
  await reconcile(options);
  const workflows = completion().map(w => ({ ...w, path: '.github/workflows/untrusted.yml' }));
  await reconcile({ ...options, workflows });
  assert.equal(Object.values(options.state.runs)[0].phase, 'queued');
});
test('a manual rerun remains current on later scheduled polls', async () => {
  const { options } = fixture();
  await reconcile(options);
  await reconcile({ ...options, rerunToken: 'intentional-1' });
  const current = options.state.prs['acme/app#1'].currentRunKey;
  await reconcile(options);
  assert.equal(options.state.prs['acme/app#1'].currentRunKey, current);
  assert.equal(Object.keys(options.state.runs).length, 2);
});
test('live-head mismatch suppresses stale GitHub and Slack publications', async () => {
  const { options, completion, calls } = fixture();
  await reconcile(options);
  calls.length = 0;
  options.integrations.currentRevision = async () => 'b'.repeat(40);
  await reconcile({ ...options, workflows: completion() });
  assert.deepEqual(calls, ['drive']);
});
test('transient result collection failure recovers on reconciliation of the same completed event', async () => {
  const { options, completion } = fixture();
  await reconcile(options);
  const workflows = completion();
  const success = options.integrations.readResults;
  options.integrations.readResults = async () => { throw new Error('Temporary artifact outage'); };
  await reconcile({ ...options, workflows });
  const run = Object.values(options.state.runs)[0];
  assert.equal(run.outcome.status, 'execution_error');
  options.integrations.readResults = success;
  await reconcile({ ...options, workflows });
  assert.equal(run.outcome.status, 'passed');
  assert.equal(run.resultCollectionPending, false);
});
test('observing an in-progress Actions rerun retains the prior completed outcome', async () => {
  const { options, completion } = fixture();
  await reconcile(options);
  const workflows = completion();
  await reconcile({ ...options, workflows });
  await reconcile({ ...options, workflows: workflows.map(w => ({ ...w, run_attempt: 2, status: 'in_progress', conclusion: null })) });
  const run = Object.values(options.state.runs)[0];
  assert.equal(run.phase, 'running');
  assert.equal(run.outcome.status, 'blocked');
  assert.equal(run.completionHistory[0].snapshot.outcome.status, 'passed');
  assert.equal(run.completionHistory[0].snapshot.actionsAttempt, 1);
});
test('native Actions rerun receives a new timeout window even long after the initial run', async () => {
  const { options, completion } = fixture();
  await reconcile(options);
  const workflows = completion();
  await reconcile({ ...options, workflows });
  const run = Object.values(options.state.runs)[0];
  run.createdAt = new Date(Date.now() - 86400000).toISOString();
  await reconcile({ ...options, workflows: workflows.map(w => ({ ...w, run_attempt: 2, status: 'in_progress', conclusion: null })) });
  assert.equal(run.phase, 'running');
  assert.equal(run.outcome.status, 'blocked');
});
