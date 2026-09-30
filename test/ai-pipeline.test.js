const test = require('node:test');
const assert = require('node:assert/strict');
const { addReviewGate, applyAssessment, reviewStage, renderAIReview } = require('../src/ai/pipeline');
const { generatePlan } = require('../src/planner');
const { assessPR, ingestDecisions } = require('../src/lifecycle');
const { emptyState } = require('../src/state');
const { deriveOutcome } = require('../src/core');

const revision = 'a'.repeat(40);
function fixture() {
  const config = { environment: 'synthetic', decisionReviewers: ['owner'],
    runners: [{ id: 'baseline', type: 'node-test', baseline: true, files: ['test/app.test.js'] },
      { id: 'boundary', type: 'node-test', files: ['test/boundary.test.js'], expected: 'The zero and upper bounds are asserted.' }],
    ai: { enabled: true, model: 'test/qa' } };
  const pr = { repository: 'acme/app', number: 1, title: 'Change threshold', author: 'author', revision,
    body: 'Reject negative quantities.', files: [{ filename: 'src/app.js', patch: '+return amount;' }],
    existingTests: [{ path: 'test/app.test.js', content: 'assert.equal(calculate(0), 0);' }], comments: [] };
  const state = emptyState();
  const plan = addReviewGate(generatePlan(pr, [], config), config, revision);
  const run = assessPR(state, pr, plan, config).run;
  return { state, run, pr, config };
}
function assessment(stage, extra = {}) {
  return { status: 'completed', stage, revision, roles: [{ role: stage === 'planning' ? 'planner' : 'triage', model: 'test/qa', status: 'completed', summary: 'Reviewed evidence.' }],
    findings: [], selectedRunnerIds: [], questions: [], candidates: [], limitations: [], cost: 0.01, usage: { totalTokens: 100 },
    budget: { calls: 1, reservedCostUsd: 0.02, reservedTokens: 1000 }, transcript: [], ...extra };
}
function team(extra = {}) { return async options => {
  const result = assessment(options.stage, extra);
  await options.onCheckpoint({ ...result, analysisKey: options.analysisKey });
  return result;
}; }

test('AI extends the plan only with existing trusted runners and preserves the baseline', async () => {
  const { run, pr, config } = fixture();
  const baseline = structuredClone(run.plan.checks.find(check => check.runner === 'baseline'));
  await reviewStage({ run, pr, config, stage: 'planning', team: team({ selectedRunnerIds: ['boundary', 'baseline'] }) });
  assert.deepEqual(run.plan.checks.find(check => check.runner === 'baseline'), baseline);
  assert.equal(run.plan.checks.filter(check => check.runner === 'boundary').length, 1);
  assert.equal(run.plan.checks.find(check => check.runner === 'boundary').expected, config.runners[1].expected);
  assert.deepEqual(run.results, []);
  assert.equal(run.outcome.status, 'blocked');
  assert.throws(() => applyAssessment(run, assessment('planning', { selectedRunnerIds: ['arbitrary-shell-command'] }), config, 'planning'), /outside trusted/);
});

test('both model stages can finish without creating a test pass or overriding a real failure', async () => {
  const { run, pr, config } = fixture();
  await reviewStage({ run, pr, config, stage: 'planning', team: team() });
  assert.equal(run.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'blocked');
  await reviewStage({ run, pr, config, stage: 'completion', team: team() });
  assert.equal(run.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'passed');
  assert.deepEqual(run.results, []);
  assert.equal(run.outcome.status, 'blocked');
  run.results = [{ checkId: 'runner-baseline', status: 'failed' }];
  applyAssessment(run, run.ai.completion, config, 'completion');
  assert.equal(run.outcome.status, 'failed');
});

test('critical findings and unresolved requirements become authorized revision-specific questions', async () => {
  const { state, run, pr, config } = fixture();
  const findings = [{ title: 'Negative quantity accepted', severity: 'high', file: 'src/app.js', description: 'A negative quantity is returned without validation.', suggestedFix: 'Validate the lower bound.', evidence: [{ file: 'src/app.js', quote: 'return amount;' }] },
    { title: 'Naming concern', severity: 'low', file: 'src/app.js', description: 'Name is ambiguous.', evidence: [] }];
  const questions = [{ question: 'What is the maximum supported quantity?', reason: 'The requirement specifies only a lower bound.', area: 'General', kind: 'requirement' }];
  await reviewStage({ run, pr, config, stage: 'planning', team: team({ findings, questions }) });
  await reviewStage({ run, pr, config, stage: 'completion', team: team() });
  const checks = run.plan.checks.filter(check => check.source === 'ai' && check.method === 'human');
  assert.equal(checks.length, 2);
  assert.equal(run.requests.length, 2);
  run.results = [{ checkId: 'runner-baseline', status: 'passed' }];
  run.outcome = deriveOutcome(run.plan, run.results, [], revision);
  assert.equal(run.outcome.status, 'awaiting_human');
  const comment = (check, id, user, sha = revision) => ({ id, user, createdAt: new Date(Date.now() + 1000).toISOString(),
    body: `/qa-tested check:${check.id} revision:${sha} result:pass reason:Verified the governing requirement and current code evidence` });
  assert.equal(ingestDecisions(state, run, [comment(checks[0], 1, 'stranger')], config), false);
  assert.equal(ingestDecisions(state, run, [comment(checks[0], 2, 'owner', 'b'.repeat(40))], config), false);
  assert.equal(ingestDecisions(state, run, checks.map((check, index) => comment(check, index + 3, 'owner')), config), true);
  assert.equal(run.outcome.status, 'passed');
});

test('partial model review blocks a required analysis gate while leaving executor results intact', async () => {
  const { run, pr, config } = fixture();
  run.results = [{ checkId: 'runner-baseline', status: 'passed' }];
  await reviewStage({ run, pr, config, stage: 'planning', team: team({ status: 'partial', limitations: ['Budget exhausted.'] }) });
  await reviewStage({ run, pr, config, stage: 'completion', team: team() });
  assert.equal(run.outcome.status, 'execution_error');
  assert.deepEqual(run.results, [{ checkId: 'runner-baseline', status: 'passed' }]);
  assert.equal(run.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'execution_error');
});

test('a final checkpoint saved before plan application is recovered without a second model request', async () => {
  const { run, pr, config } = fixture();
  let crashSnapshot;
  await reviewStage({ run, pr, config, stage: 'planning', team: team({ selectedRunnerIds: ['boundary'] }), save: async () => {
    if (run.ai?.planning?.status === 'completed' && !run.ai.planning.applied) crashSnapshot = structuredClone(run);
  } });
  assert.ok(crashSnapshot);
  assert.equal(crashSnapshot.plan.checks.some(check => check.runner === 'boundary'), false);
  await reviewStage({ run: crashSnapshot, pr, config, stage: 'planning', team: async () => assert.fail('A paid review must not repeat') });
  assert.equal(crashSnapshot.plan.checks.filter(check => check.runner === 'boundary').length, 1);
  assert.equal(crashSnapshot.ai.planning.applied, true);
  await reviewStage({ run: crashSnapshot, pr, config, stage: 'planning', team: async () => assert.fail('A paid review must not repeat') });
  assert.equal(crashSnapshot.plan.checks.filter(check => check.runner === 'boundary').length, 1);
});

test('completion checkpoint recovery updates the gate and retains cumulative budget', async () => {
  const { run, pr, config } = fixture();
  await reviewStage({ run, pr, config, stage: 'planning', team: team() });
  run.results = [{ checkId: 'runner-baseline', status: 'passed' }];
  let crashSnapshot;
  await reviewStage({ run, pr, config, stage: 'completion', team: async options => {
    assert.equal(options.prior.budget.calls, 1);
    return team({ budget: { calls: 2, reservedCostUsd: 0.04, reservedTokens: 2000 } })(options);
  }, save: async () => {
    if (run.ai?.completion?.status === 'completed' && !run.ai.completion.applied) crashSnapshot = structuredClone(run);
  } });
  assert.equal(crashSnapshot.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'blocked');
  await reviewStage({ run: crashSnapshot, pr, config, stage: 'completion', team: async () => assert.fail('Review should reuse checkpoint') });
  assert.equal(crashSnapshot.plan.checks.find(check => check.method === 'analysis').analysisStatus, 'passed');
  assert.equal(crashSnapshot.outcome.status, 'passed');
  assert.equal(crashSnapshot.ai.completion.budget.calls, 2);
});

test('dry-run previews neither call a model nor save an assessment', async () => {
  const { run, pr, config } = fixture();
  const review = await reviewStage({ run, pr, config, stage: 'planning', dryRun: true,
    team: async () => assert.fail('No model calls in dry-run'), save: async () => assert.fail('No persistence in dry-run') });
  assert.equal(review.status, 'preview');
  assert.equal(run.ai.planning, undefined);
});

test('completion cannot schedule new suites after the immutable execution has finished', async () => {
  const { run, pr, config } = fixture();
  await reviewStage({ run, pr, config, stage: 'completion', team: team({ selectedRunnerIds: ['boundary'] }) });
  assert.equal(run.plan.checks.some(check => check.runner === 'boundary'), false);
  assert.equal(run.results.length, 0);
});

test('assessment revision mismatch is rejected and estimate labels remain accurate', () => {
  const { run, config } = fixture();
  assert.throws(() => applyAssessment(run, assessment('planning', { revision: 'b'.repeat(40) }), config, 'planning'), /identity mismatch/);
  const markdown = renderAIReview({ planning: assessment('planning', { costIsEstimate: true }) });
  assert.match(markdown, /Estimated cost: 0.01 USD/);
  assert.match(markdown, /does not prove absence of defects/);
});

test('question and high-severity overflow stays required and every skipped item appears in the full report', async () => {
  const { state, run, pr, config } = fixture();
  const questions = Array.from({ length: 14 }, (_, index) => ({ question: `What is the intended limit for case ${index}?`, area: 'General', reason: 'Missing acceptance criterion.', kind: 'requirement' }));
  const findings = Array.from({ length: 14 }, (_, index) => ({ title: `Unhandled case ${index}`, file: 'src/app.js', severity: index % 2 ? 'high' : 'critical',
    description: `Case ${index} bypasses validation.`, evidence: [{ file: 'src/app.js', quote: 'return amount;' }], suggestedFix: `Validate case ${index}.` }));
  await reviewStage({ run, pr, config, stage: 'planning', team: team({ questions, findings }) });
  await reviewStage({ run, pr, config, stage: 'completion', team: team() });
  const overflow = run.plan.checks.find(check => check.id.startsWith('ai-overflow-'));
  assert.ok(overflow);
  assert.equal(overflow.required, true);
  assert.match(overflow.question, /2 additional unresolved question\(s\) and 2 additional high\/critical finding\(s\)/);
  assert.equal(run.plan.checks.filter(check => check.source === 'ai' && check.method === 'human').length, 25);
  const rendered = renderAIReview(run.ai);
  assert.ok(rendered.includes(questions[13].question));
  assert.ok(rendered.includes(findings[13].title));
  run.results = [{ checkId: 'runner-baseline', status: 'passed' }];
  const comments = run.plan.checks.filter(check => check.method === 'human' && check.id !== overflow.id).map((check, index) => ({ id: index + 100, user: 'owner',
    createdAt: new Date(Date.now() + 1000).toISOString(), body: `/qa-tested check:${check.id} revision:${revision} result:pass reason:Verified current source and governing requirements` }));
  ingestDecisions(state, run, comments, config);
  assert.equal(run.outcome.status, 'awaiting_human');
  assert.deepEqual(run.outcome.pending.map(check => check.id), [overflow.id]);
  applyAssessment(run, run.ai.planning, config, 'planning');
  assert.equal(run.plan.checks.filter(check => check.id === overflow.id).length, 1);
  const changed = assessment('planning', { questions: [...questions.slice(0, 13), { ...questions[13], question: 'A different unresolved case?' }], findings });
  applyAssessment(run, changed, config, 'planning');
  assert.equal(run.plan.checks.filter(check => check.id.startsWith('ai-overflow-')).length, 2);
});

test('candidate code remains copyable and embedded backticks cannot terminate its code fence', () => {
  const source = 'const format = value => `value: ${value}`;\n// ````\nconst markup = "<div/>";';
  const markdown = renderAIReview({ planning: assessment('planning', { candidates: [{ id: 'candidate', title: 'Render value', filename: 'test/render.test.js', assertion: 'The value renders.', requirement: 'PR description', source }] }) });
  assert.ok(markdown.includes(source));
  assert.ok(markdown.includes(`\n\n\`\`\`\`\`text\n${source}\n\`\`\`\`\`\n`));
  assert.ok(!markdown.includes('=&gt;'));
  assert.ok(!markdown.includes('&lt;div'));
});
