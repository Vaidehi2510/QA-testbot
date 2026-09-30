const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { emptyState, FileStore, GitHubStore } = require('../src/state');
const { assessPR, completeRun, ingestDecisions, deliverEffect, queueEffect, isCurrent } = require('../src/lifecycle');
const revision = 'a'.repeat(40);
const pr = { repository: 'acme/app', number: 1, title: 'Boundary', author: 'author', url: 'https://github.com/acme/app/pull/1', revision };
const plan = { fingerprint: 'p1', checks: [{ id: 'baseline', method: 'automated', required: true }] };
const config = { environment: 'synthetic', decisionReviewers: ['owner'] };
function fixture(extra = {}) { const state = emptyState(); const { run } = assessPR(state, pr, { ...plan, ...extra }, config); return { state, run }; }
function report(run, overrides = {}) { return { schemaVersion: 1, repository: run.repository, prNumber: 1, revision,
  environment: 'synthetic', runId: run.runId, attempt: 1, actionsRunId: '100', actionsAttempt: 1,
  results: [{ checkId: 'baseline', status: 'passed' }], ...overrides }; }
const workflow = { id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/bot/actions/runs/100' };

test('same event deduplicates; intentional rerun tokens create one new attempt', () => {
  const { state, run } = fixture();
  assert.equal(assessPR(state, pr, plan, config).created, false);
  const rerun = assessPR(state, pr, plan, config, { rerunToken: 'retry-1' });
  assert.equal(rerun.run.attempt, 2);
  assert.equal(assessPR(state, pr, plan, config, { rerunToken: 'retry-1' }).created, false);
  assert.equal(isCurrent(state, run), false);
});
test('new SHA with same filenames invalidates decisions and retains historical results', () => {
  const { state, run } = fixture();
  run.decisions.push({ checkId: 'human', revision, result: 'pass' });
  completeRun(state, run.key, report(run), workflow);
  const next = assessPR(state, { ...pr, revision: 'b'.repeat(40) }, plan, config).run;
  assert.notEqual(next.key, run.key);
  assert.equal(next.outcome.status, 'blocked');
  assert.equal(next.decisions.length, 0);
  assert.ok(run.decisions[0].invalidatedAt);
  assert.equal(run.results[0].status, 'passed');
  assert.equal(isCurrent(state, run), false);
});
test('force-push back to an old SHA creates a fresh assessment', () => {
  const { state, run } = fixture();
  assessPR(state, { ...pr, revision: 'b'.repeat(40) }, plan, config);
  const restored = assessPR(state, pr, plan, config);
  assert.equal(restored.created, true);
  assert.notEqual(restored.run.key, run.key);
  assert.equal(assessPR(state, pr, plan, config).created, false);
});
test('late completion is historical and never changes current run pointer', () => {
  const { state, run } = fixture();
  const next = assessPR(state, { ...pr, revision: 'b'.repeat(40) }, plan, config).run;
  completeRun(state, run.key, report(run), workflow);
  assert.equal(isCurrent(state, next), true);
  assert.equal(next.outcome.status, 'blocked');
});
test('report SHA, environment, run and attempt are checked', () => {
  for (const change of [{ revision: 'c'.repeat(40) }, { environment: 'production' }, { attempt: 2 }, { actionsRunId: '101' }, { actionsAttempt: 2 }, { runId: 'other' }]) {
    const { state, run } = fixture();
    completeRun(state, run.key, report(run, change), workflow);
    assert.equal(run.outcome.status, 'execution_error');
  }
});
test('missing, canceled, failed and duplicate reports never pass', () => {
  for (const conclusion of ['cancelled', 'timed_out', 'failure']) {
    const { state, run } = fixture();
    completeRun(state, run.key, report(run), { ...workflow, conclusion });
    assert.equal(run.outcome.status, 'execution_error');
  }
  const { state, run } = fixture();
  completeRun(state, run.key, null, workflow);
  assert.equal(run.outcome.status, 'execution_error');
  const other = fixture();
  completeRun(other.state, other.run.key, report(other.run, { results: [{ checkId: 'baseline', status: 'passed' }, { checkId: 'baseline', status: 'failed' }] }), workflow);
  assert.equal(other.run.outcome.status, 'execution_error');
});
test('same completion is idempotent and a later Actions attempt retains history', () => {
  const { state, run } = fixture();
  completeRun(state, run.key, report(run), workflow);
  assert.equal(completeRun(state, run.key, report(run), workflow).duplicate, true);
  completeRun(state, run.key, report(run, { actionsAttempt: 2, results: [{ checkId: 'baseline', status: 'failed' }] }), { ...workflow, run_attempt: 2 });
  assert.equal(run.outcome.status, 'failed');
  assert.equal(run.completionHistory[0].outcome.status, 'passed');
  completeRun(state, run.key, report(run), workflow);
  assert.equal(run.outcome.status, 'failed');
});
test('malformed result records become execution errors instead of crashing collection', () => {
  for (const result of [null, false, 'passed', []]) {
    const { state, run } = fixture();
    completeRun(state, run.key, report(run, { results: [result] }), workflow);
    assert.equal(run.outcome.status, 'execution_error');
    assert.match(run.results[0].details, /Invalid result schema/);
  }
});
test('unauthorized, stale and reused decisions are not applied', () => {
  const { state, run } = fixture({ checks: [...plan.checks, { id: 'question', method: 'human', kind: 'requirement' }] });
  const body = `/qa-tested check:question revision:${revision} result:pass reason:Documented expected threshold`;
  const comment = { id: 1, user: 'stranger', body, createdAt: new Date(Date.now() + 1000).toISOString() };
  assert.equal(ingestDecisions(state, run, [comment], config), false);
  assert.equal(ingestDecisions(state, run, [{ ...comment, id: 2, user: 'owner', body: body.replace(revision, 'b'.repeat(40)) }], config), false);
  const accepted = { ...comment, id: 3, user: 'owner' };
  assert.equal(ingestDecisions(state, run, [accepted], config), true);
  assert.equal(ingestDecisions(state, run, [accepted], config), false);
  assert.equal(run.decisions.length, 1);
  assert.equal(run.decisions[0].responder, 'owner');
});
test('outbox records bounded failures and dry-run never calls external actions', async () => {
  const state = emptyState(); let calls = 0; let checkpoints = 0;
  const effect = queueEffect(state, 'slack-1', 'slack', 'run');
  const save = async () => checkpoints++;
  const fail = async () => { calls++; throw new Error('offline'); };
  await deliverEffect(state, effect, fail, save, { dryRun: true });
  assert.equal(calls, 0); assert.equal(effect.attempts, 0);
  await deliverEffect(state, effect, fail, save, { maxAttempts: 2 });
  assert.equal(effect.status, 'pending');
  delete effect.nextAttemptAt;
  await deliverEffect(state, effect, fail, save, { maxAttempts: 2 });
  assert.equal(effect.status, 'exhausted');
  await deliverEffect(state, effect, fail, save);
  assert.equal(calls, 2); assert.equal(checkpoints, 4);
});
test('atomic persistent store serializes overlapping processes and survives restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-store-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const a = new FileStore(directory), b = new FileStore(directory);
  await Promise.all([a, b].map((store, i) => store.withLock(async (state, save) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    state.effects[`item-${i}`] = { status: 'pending' };
    await save(state);
  })));
  assert.equal(Object.keys((await new FileStore(directory).load()).effects).length, 2);
  await a.withLock(async state => assert.equal(state.version, 1));
  await fs.writeFile(path.join(directory, 'state.json'), '{broken');
  await assert.rejects(a.load());
});
test('GitHub state CAS conflict aborts before external effects', async () => {
  let actions = 0;
  const gh = { rest: { git: { getRef: async () => ({ data: {} }) }, repos: {
    getContent: async () => ({ data: { sha: 'old', content: Buffer.from(JSON.stringify(emptyState())).toString('base64') } }),
    createOrUpdateFileContents: async () => { throw Object.assign(new Error('Conflict'), { status: 409 }); },
  } } };
  const store = new GitHubStore({ gh, owner: 'acme', repo: 'bot' });
  await assert.rejects(store.withLock(async () => actions++), /Conflict/);
  assert.equal(actions, 0);
});
test('a real completion recovers after dispatch observation timed out', () => {
  const { state, run } = fixture();
  completeRun(state, run.key, null, { ...workflow, id: `missing-${run.key}`, conclusion: 'timed_out' });
  assert.equal(run.actionsRunId, undefined);
  completeRun(state, run.key, report(run), workflow);
  assert.equal(run.outcome.status, 'passed');
});
test('a passed summary cannot override contradictory structured failure counts', () => {
  const { state, run } = fixture();
  completeRun(state, run.key, report(run, { results: [{ checkId: 'baseline', status: 'passed', counts: { tests: 2, passed: 1, failed: 1, skipped: 0 } }] }), workflow);
  assert.equal(run.outcome.status, 'execution_error');
});
