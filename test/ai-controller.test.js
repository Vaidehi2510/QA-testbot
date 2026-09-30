const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../src/run');
const { emptyState } = require('../src/state');

function fixture({ planning = {}, completion = {}, failAI = false } = {}) {
  const state = emptyState(), calls = [], modelCalls = [], requests = [], statuses = [];
  const config = { environment: 'synthetic', dispatchTimeoutMinutes: 30, maxIntegrationAttempts: 2, decisionReviewers: ['owner'],
    runners: [{ id: 'baseline', type: 'node-test', baseline: true, files: ['test/app.test.js'] }, { id: 'boundary', type: 'node-test', files: ['test/boundary.test.js'] }],
    ai: { enabled: true, model: 'test/qa' } };
  const pr = { repository: 'acme/app', number: 1, title: 'Shipping boundary', body: 'Orders >=100 ship free.', author: 'author', revision: 'a'.repeat(40),
    files: [{ filename: 'src/app.js', patch: '+ return amount >= 100 ? 0 : 5;' }], existingTests: [{ path: 'test/app.test.js', content: 'assert.equal(shipping(100), 0);' }], comments: [] };
  let envelope;
  const options = { state, save: async () => {}, config, rules: [], people: [], prs: [pr], log: () => {} };
  const integrations = {
    putRequest: async (key, request) => { calls.push('request'); requests.push(structuredClone(request)); },
    dispatch: async () => { calls.push('dispatch'); return { status: 'sent' }; },
    plan: async () => { calls.push('plan'); return { status: 'sent' }; },
    status: async run => { calls.push(`status:${run.outcome.status}`); statuses.push({ revision: run.revision, status: run.outcome.status }); return { status: 'sent' }; },
    currentRevision: async () => options.prs[0].revision,
    readResults: async () => envelope,
    slack: { send: async text => { calls.push(text); return { status: 'sent' }; } },
    drive: { upsertReport: async () => { calls.push('drive'); return { status: 'uploaded', url: 'https://drive.google.com/file/d/report/view' }; } },
    aiTeam: async request => {
      modelCalls.push({ stage: request.stage, revision: request.pr.revision, prior: structuredClone(request.prior), results: structuredClone(request.results) });
      calls.push(`ai:${request.stage}`);
      if (failAI) throw new Error('Missing OpenRouter credentials');
      const result = { status: 'completed', stage: request.stage, revision: request.pr.revision, analysisKey: request.analysisKey,
        roles: [{ role: request.stage === 'planning' ? 'planner' : 'triage', model: 'test/qa', status: 'completed', summary: 'Review finished.' }],
        findings: [], questions: [], selectedRunnerIds: [], candidates: [], limitations: [], usage: { totalTokens: 100 }, cost: 0.01,
        budget: { calls: (request.prior?.budget?.calls || 0) + 1, reservedCostUsd: (request.prior?.budget?.reservedCostUsd || 0) + 0.02, reservedTokens: 1000 }, transcript: [],
        ...(request.stage === 'planning' ? planning : completion) };
      await request.onCheckpoint(result);
      return result;
    },
  };
  options.integrations = integrations;
  const currentRun = () => state.runs[state.prs['acme/app#1'].currentRunKey];
  function workflows({ attempt = 1, status = 'completed', checkStatus = 'passed', conclusion = 'success', omitCheck } = {}) {
    const run = currentRun();
    envelope = { schemaVersion: 1, repository: run.repository, prNumber: 1, revision: run.revision, environment: run.environment, runId: run.runId,
      attempt: run.attempt, actionsRunId: '7', actionsAttempt: attempt, results: run.plan.checks.filter(check => check.method === 'automated' && check.runner !== omitCheck)
        .map(check => ({ checkId: check.id, status: checkStatus })) };
    return [{ id: 7, run_attempt: attempt, event: 'workflow_dispatch', path: '.github/workflows/qa-execute.yml', display_title: `QA execution ${run.key}`,
      status, conclusion, html_url: 'https://github.com/acme/bot/actions/runs/7' }];
  }
  return { options, calls, modelCalls, requests, statuses, currentRun, workflows };
}

test('planning selects extra trusted tests before dispatch and completion waits for actual execution evidence', async () => {
  const f = fixture({ planning: { selectedRunnerIds: ['boundary'] } });
  await reconcile(f.options);
  assert.ok(f.calls.indexOf('ai:planning') < f.calls.indexOf('dispatch'));
  assert.deepEqual(f.requests[0].plan.checks.filter(check => check.method === 'automated').map(check => check.runner), ['baseline', 'boundary']);
  assert.equal(f.currentRun().results.length, 0);
  assert.equal(f.currentRun().outcome.status, 'blocked');
  await reconcile({ ...f.options, workflows: f.workflows() });
  assert.equal(f.currentRun().outcome.status, 'passed');
  assert.equal(f.currentRun().ai.completion.budget.calls, 2);
  assert.equal(f.currentRun().results.length, 2);
  assert.equal(f.modelCalls[1].results.length, 2);
});

test('a completed AI review never fills missing tests or turns failed tests into passes', async () => {
  for (const completion of [{ omitCheck: 'boundary' }, { checkStatus: 'failed' }]) {
    const f = fixture({ planning: { selectedRunnerIds: ['boundary'] } });
    await reconcile(f.options);
    await reconcile({ ...f.options, workflows: f.workflows(completion) });
    assert.equal(f.currentRun().ai.completion.status, 'completed');
    assert.equal(f.currentRun().outcome.status, completion.checkStatus === 'failed' ? 'failed' : 'blocked');
  }
});

test('completion notification is sent before final AI review and a separate final update follows it', async () => {
  const f = fixture();
  await reconcile(f.options);
  f.calls.length = 0;
  await reconcile({ ...f.options, workflows: f.workflows() });
  const notifications = f.calls.map((call, index) => ({ call, index })).filter(entry => entry.call.includes('*QA result*'));
  assert.equal(notifications.length, 2);
  assert.match(notifications[0].call, /blocked/);
  assert.match(notifications[1].call, /passed/);
  const review = f.calls.indexOf('ai:completion');
  assert.ok(notifications[0].index < review && review < notifications[1].index);
  assert.ok(notifications[0].index < f.calls.indexOf('drive'));
});

test('repeat synchronization consumes no model calls, dispatches, or completion notifications', async () => {
  const f = fixture();
  await reconcile(f.options);
  const workflows = f.workflows();
  await reconcile({ ...f.options, workflows });
  const before = f.calls.length;
  await reconcile({ ...f.options, workflows });
  await reconcile(f.options);
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.calls.length, before);
});

test('missing model credentials do not skip trusted tests and cannot produce a green overall result', async () => {
  const f = fixture({ failAI: true });
  await reconcile(f.options);
  assert.equal(f.calls.filter(call => call === 'dispatch').length, 1);
  assert.equal(f.requests[0].plan.checks.filter(check => check.method === 'automated').length, 1);
  await reconcile({ ...f.options, workflows: f.workflows() });
  assert.deepEqual(f.currentRun().results, [{ checkId: 'runner-baseline', status: 'passed' }]);
  assert.equal(f.currentRun().ai.planning.status, 'error');
  assert.equal(f.currentRun().ai.completion.status, 'error');
  assert.equal(f.currentRun().outcome.status, 'execution_error');
  assert.ok(f.calls.some(call => call.includes('*QA result*')));
});

test('AI dry-run does not call models, publish side effects, or mutate persisted state', async () => {
  const f = fixture();
  const before = structuredClone(f.options.state);
  f.options.save = async () => assert.fail('Persistence is forbidden in dry-run');
  await reconcile({ ...f.options, dryRun: true });
  assert.deepEqual(f.options.state, before);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.modelCalls, []);
});

test('new commits invalidate prior AI gates and human decisions and require fresh planning', async () => {
  const f = fixture();
  await reconcile(f.options);
  await reconcile({ ...f.options, workflows: f.workflows() });
  const previous = f.currentRun();
  previous.decisions.push({ checkId: 'old-question', revision: previous.revision, result: 'pass' });
  f.options.prs = [{ ...f.options.prs[0], revision: 'b'.repeat(40) }];
  await reconcile(f.options);
  const current = f.currentRun();
  assert.notEqual(current.key, previous.key);
  assert.equal(current.ai.planning.revision, 'b'.repeat(40));
  assert.equal(current.ai.completion, undefined);
  assert.equal(current.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'blocked');
  assert.equal(current.results.length, 0);
  assert.equal(current.decisions.length, 0);
  assert.ok(previous.decisions[0].invalidatedAt);
  assert.equal(f.modelCalls.length, 3);
});

test('native Actions reruns reset final AI review while preserving history and cumulative budget', async () => {
  const f = fixture();
  await reconcile(f.options);
  await reconcile({ ...f.options, workflows: f.workflows() });
  await reconcile({ ...f.options, workflows: f.workflows({ attempt: 2, status: 'in_progress', conclusion: null }) });
  const run = f.currentRun();
  assert.equal(run.phase, 'running');
  assert.equal(run.outcome.status, 'blocked');
  assert.equal(run.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'blocked');
  assert.equal(run.ai.completion, undefined);
  assert.equal(run.completionHistory[0].snapshot.ai.completion.status, 'completed');
  assert.equal(f.modelCalls.length, 2);
  await reconcile({ ...f.options, workflows: f.workflows({ attempt: 2 }) });
  assert.equal(f.modelCalls.length, 3);
  assert.equal(run.ai.completion.budget.calls, 3);
  assert.equal(run.outcome.status, 'passed');
});

test('high severity completion findings request human verification and remain separate from test status', async () => {
  const finding = { title: 'Threshold bypass', severity: 'high', file: 'src/app.js', description: 'Negative amounts produce an unsupported result.', suggestedFix: 'Validate amounts.', evidence: [{ file: 'src/app.js', quote: 'return amount' }] };
  const f = fixture({ completion: { findings: [finding] } });
  await reconcile(f.options);
  await reconcile({ ...f.options, workflows: f.workflows() });
  assert.equal(f.currentRun().results[0].status, 'passed');
  assert.equal(f.currentRun().outcome.status, 'awaiting_human');
  const check = f.currentRun().plan.checks.find(item => item.source === 'ai' && item.method === 'human');
  assert.ok(check);
  assert.match(check.question, /Validate or reject/);
  assert.ok(f.calls.some(call => call.includes(check.id)));
});
