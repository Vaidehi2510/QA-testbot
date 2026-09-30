const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchReleasePRs, targetAccessMode, assertRepositorySeparation, selectedPRNumbers, createTargetReporters, upsertComment, updateLabels } = require('../src/github');
const { reconcile } = require('../src/run');
const { emptyState } = require('../src/state');
const { queueEffect } = require('../src/lifecycle');

const revision = 'a'.repeat(40);
const baseline = { id: 'node-tests', type: 'node-test', baseline: true, files: ['test/app.test.js'] };
const pr = { repository: 'target/product', number: 42, title: 'Update configuration', body: 'Existing behavior stays covered by the baseline.', author: 'author', revision,
  files: [{ filename: 'src/app.js', patch: '+const enabled = true;' }], existingTests: [], comments: [] };

function controllerFixture(targetAccess = 'read-only') {
  const state = emptyState(), calls = [];
  const config = { targetAccess, environment: 'synthetic', decisionReviewers: ['owner'], runners: [baseline], maxIntegrationAttempts: 2 };
  let envelope;
  const integrations = {
    putRequest: async (key, request) => { calls.push('bot-request'); assert.equal(request.metadata.repository, pr.repository); return { key }; },
    dispatch: async () => { calls.push('bot-dispatch'); return { status: 'sent' }; },
    plan: async () => { calls.push('target-plan'); return { status: 'sent' }; },
    status: async () => { calls.push('target-status'); return { status: 'sent' }; },
    currentRevision: async () => revision,
    readResults: async () => envelope,
    slack: { send: async () => { calls.push('slack'); return { status: 'sent' }; } },
    drive: { upsertReport: async () => { calls.push('drive'); return { status: 'uploaded', url: 'https://drive.google.com/file/d/fixture/view' }; } },
  };
  const options = { state, save: async () => {}, config, rules: [], people: [], prs: [pr], integrations, log: () => {} };
  function completion() {
    const run = Object.values(state.runs)[0];
    envelope = { schemaVersion: 1, repository: run.repository, prNumber: run.pr.number, revision, environment: run.environment, runId: run.runId,
      attempt: run.attempt, actionsRunId: '17', actionsAttempt: 1, results: [{ checkId: 'runner-node-tests', status: 'passed' }] };
    return [{ id: 17, run_attempt: 1, event: 'workflow_dispatch', path: '.github/workflows/qa-execute.yml', display_title: `QA execution ${run.key}`,
      status: 'completed', conclusion: 'success', html_url: 'https://github.com/bot/qa/actions/runs/17' }];
  }
  return { options, calls, completion };
}

test('optional read-only target mode still executes in the bot repository and publishes separate QA reports', async () => {
  const { options, calls, completion } = controllerFixture();
  await reconcile(options);
  assert.deepEqual(calls, ['bot-request', 'bot-dispatch']);
  assert.equal(Object.values(options.state.effects).some(effect => ['plan', 'status'].includes(effect.type)), false);
  await reconcile({ ...options, workflows: completion() });
  assert.equal(Object.values(options.state.runs)[0].outcome.status, 'passed');
  assert.ok(calls.includes('drive'));
  assert.ok(calls.includes('slack'));
  assert.equal(calls.some(call => call.startsWith('target-')), false);
});

test('read-only target mode suppresses old pending target-write effects and still reads authorized human comments', async () => {
  const { options, calls } = controllerFixture();
  options.rules = [{ id: 'policy', match: ['src/'], checks: [{ id: 'decision', method: 'human', question: 'Is the documented behavior intentional?', expected: 'Owner supplies a requirement.' }] }];
  await reconcile(options);
  const run = Object.values(options.state.runs)[0];
  queueEffect(options.state, `${run.key}:plan`, 'plan', run.key);
  queueEffect(options.state, `${run.key}:status:old`, 'status', run.key);
  const check = run.plan.checks.find(item => item.id === 'policy-decision');
  assert.ok(check);
  const comments = [{ id: 8, user: 'owner', createdAt: new Date(Date.now() + 1000).toISOString(),
    body: `/qa-tested check:${check.id} revision:${revision} result:pass reason:Reviewed the governing requirement and verified expected behavior` }];
  await reconcile({ ...options, prs: [{ ...pr, comments }] });
  assert.equal(run.decisions.length, 1);
  assert.equal(calls.some(call => call.startsWith('target-')), false);
});

test('report-status is the default and preserves permitted target PR metadata publication', async () => {
  assert.equal(targetAccessMode(), 'report-status');
  const { options, calls } = controllerFixture('report-status');
  delete options.config.targetAccess;
  await reconcile(options);
  assert.ok(calls.includes('target-plan'));
  assert.ok(calls.includes('target-status'));
  assert.ok(calls.includes('bot-dispatch'));
  assert.throws(() => targetAccessMode({ targetAccess: 'push-code' }), /targetAccess/);
});

test('target metadata adapters independently honor read-only mode before any GitHub access', async () => {
  const gh = new Proxy({}, { get() { assert.fail('Read-only target adapter touched GitHub'); } });
  const config = { targetAccess: 'read-only' };
  const reporters = createTargetReporters(gh, 'target', 'product', config);
  assert.equal((await reporters.plan({})).status, 'skipped');
  assert.equal((await reporters.status({})).status, 'skipped');
  assert.equal((await upsertComment(gh, 'target', 'product', 42, '<!--qa-->', 'plan', { targetAccess: 'read-only' })).status, 'skipped');
  assert.equal((await updateLabels(gh, 'target', 'product', 42, {}, config)).status, 'skipped');
});

test('permitted target publication uses comments, labels and commit statuses without any source-write API', async () => {
  const calls = [];
  const unexpected = name => () => assert.fail(`Forbidden target source mutation: ${name}`);
  const gh = { paginate: async () => [], rest: {
    issues: { listComments: () => {}, createComment: async args => { calls.push(['comment', args]); return { data: { id: 1 } }; },
      getLabel: async () => {}, addLabels: async args => { calls.push(['label-add', args]); }, removeLabel: async args => { calls.push(['label-remove', args]); } },
    repos: { createCommitStatus: async args => { calls.push(['status', args]); }, createOrUpdateFileContents: unexpected('contents'), deleteFile: unexpected('delete') },
    git: { createBlob: unexpected('blob'), createCommit: unexpected('commit'), updateRef: unexpected('push') },
    pulls: { merge: unexpected('merge') },
  } };
  const reporters = createTargetReporters(gh, 'target', 'product', { needsQaLabel: 'needs-qa', completeLabel: 'qa-complete' });
  const run = { pr: { number: 42, url: 'https://github.com/target/product/pull/42' }, revision, attempt: 1, plan: { markdown: 'QA plan' }, outcome: { status: 'passed' } };
  await reporters.plan(run);
  await reporters.status(run);
  assert.deepEqual(calls.map(([name]) => name), ['comment', 'status', 'label-add', 'label-remove']);
  assert.equal(calls.find(([name]) => name === 'status')[1].sha, revision);
  assert.equal(calls.find(([name]) => name === 'status')[1].state, 'success');
  assert.ok(calls.every(([, args]) => args.owner === 'target' && args.repo === 'product'));
});

test('all target access modes require a separate bot repository for state commits and workflows', () => {
  for (const config of [{}, { targetAccess: 'report-status' }, { targetAccess: 'read-only' }]) {
    assert.throws(() => assertRepositorySeparation(config, 'Owner/Product', 'owner/product'), /separate BOT_REPOSITORY/);
    assert.doesNotThrow(() => assertRepositorySeparation(config, 'owner/product', 'owner/qa-bot'));
  }
  for (const name of ['owner/product/', 'https://github.com/owner/product', 'owner/product.git', 'owner/..']) {
    assert.throws(() => assertRepositorySeparation({}, 'owner/product', name), /owner\/repository names/);
  }
});

function discoveryClient() {
  const calls = [];
  const listFiles = () => {}, listComments = () => {}, listForRepo = () => {}, listMilestones = () => {};
  const gh = { rest: {
    pulls: { listFiles, get: async args => {
      calls.push(['pr', args.pull_number]);
      return { data: { title: `PR ${args.pull_number}`, body: 'Validate documented behavior.', state: 'open', changed_files: 1,
        user: { login: 'author' }, head: { sha: revision }, base: { sha: 'b'.repeat(40) }, labels: [] } };
    } },
    issues: { listComments, listForRepo, listMilestones },
    git: { getTree: async () => ({ data: { tree: [] } }) },
  }, paginate: async (fn, args) => {
    if (fn === listFiles) return [{ filename: 'src/app.js', patch: '+const enabled = true;', changes: 1, status: 'modified' }];
    if (fn === listComments) { calls.push(['comments', args.issue_number]); return []; }
    assert.fail('Explicit PR discovery must not list issues, milestones, or labels');
  } };
  return { gh, calls };
}

test('explicit PR numbers bypass labels and milestones, deduplicate selections and queue only selected new PRs', async () => {
  const { gh, calls } = discoveryClient();
  const config = { targetAccess: 'read-only', scope: { prNumbers: [42, 7, 42], milestone: 'unavailable', label: 'does-not-exist' } };
  const prs = await fetchReleasePRs(gh, 'target', 'product', config, [999]);
  assert.deepEqual(prs.map(item => item.number), [42, 7]);
  assert.deepEqual(calls.filter(([type]) => type === 'pr').map(([, number]) => number), [42, 7]);
  const fixture = controllerFixture();
  await reconcile({ ...fixture.options, config: { ...fixture.options.config, ...config }, prs });
  assert.deepEqual(Object.values(fixture.options.state.runs).map(run => run.pr.number), [42, 7]);
  assert.equal(fixture.calls.filter(call => call === 'bot-dispatch').length, 2);
});

test('PR_NUMBER overrides configured PRs without requiring product labels or modification permissions', async () => {
  const { gh, calls } = discoveryClient();
  const prs = await fetchReleasePRs(gh, 'target', 'product', { scope: { prNumbers: [7], milestone: 'unused' } }, [999], { prNumber: '42' });
  assert.deepEqual(prs.map(item => item.number), [42]);
  assert.equal(calls.filter(([type]) => type === 'comments').length, 1);
  assert.deepEqual(selectedPRNumbers({ scope: { prNumbers: [] } }), null);
  for (const prNumber of ['0', '-1', 'abc', '1,2', '1.5', ' ', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => selectedPRNumbers({}, prNumber), /PR_NUMBER/);
  for (const prNumbers of ['42', [0], ['42'], [NaN], Array(101).fill(1)]) assert.throws(() => selectedPRNumbers({ scope: { prNumbers } }), /scope.prNumbers/);
});
