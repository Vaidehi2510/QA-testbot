const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveOutcome } = require('../src/core');
const revision = 'a'.repeat(40);
const automated = { id: 'runner-unit', method: 'automated', required: true };
const human = { id: 'billing-policy', method: 'human', required: true };
const plan = { checks: [automated] };

test('all required automated checks can complete without participants', () => {
  assert.equal(deriveOutcome(plan, [{ checkId: automated.id, status: 'passed' }], [], revision).status, 'passed');
});

test('every nonpassing machine result is distinguishable and never green', () => {
  for (const status of ['failed', 'skipped', 'blocked', 'execution_error']) {
    const result = deriveOutcome(plan, [{ checkId: automated.id, status }], [], revision);
    assert.equal(result.status, status);
    assert.equal(result.counts[status], 1);
    assert.equal(result.automatedPassed, false);
  }
});

test('missing reports, unsupported checks, unknown statuses, and empty plans do not pass', () => {
  assert.equal(deriveOutcome(plan, [], [], revision).status, 'blocked');
  assert.equal(deriveOutcome({ checks: [{ id: 'unknown', method: 'unsupported', required: true }] }, [{ checkId: 'unknown', status: 'passed' }], [], revision).status, 'blocked');
  assert.equal(deriveOutcome(plan, [{ checkId: automated.id, status: 'cancelled' }], [], revision).status, 'execution_error');
  assert.equal(deriveOutcome({ checks: [] }).status, 'blocked');
});

test('a mandatory question holds QA while independent automated work passes', () => {
  const result = deriveOutcome({ checks: [automated, human] }, [{ checkId: automated.id, status: 'passed' }], [], revision);
  assert.equal(result.status, 'awaiting_human');
  assert.equal(result.automatedPassed, true);
  assert.deepEqual(result.pending.map((check) => check.id), [human.id]);
});

test('decisions apply only to the exact tested revision and cannot override a failed test', () => {
  const currentPlan = { checks: [automated, human] };
  const passed = [{ checkId: automated.id, status: 'passed' }];
  const decision = { checkId: human.id, result: 'pass', revision };
  assert.equal(deriveOutcome(currentPlan, passed, [decision], revision).status, 'passed');
  assert.equal(deriveOutcome(currentPlan, passed, [decision], 'b'.repeat(40)).status, 'awaiting_human');
  assert.equal(deriveOutcome(currentPlan, [{ checkId: automated.id, status: 'failed' }], [decision], revision).status, 'failed');
  assert.equal(deriveOutcome(currentPlan, passed, [{ ...decision, result: 'fail' }], revision).status, 'failed');
});

test('stale results and conflicting duplicates never supply a pass', () => {
  assert.equal(deriveOutcome(plan, [{ checkId: automated.id, status: 'passed', revision: 'b'.repeat(40) }], [], revision).status, 'blocked');
  assert.equal(deriveOutcome(plan, [{ checkId: automated.id, status: 'failed' }, { checkId: automated.id, status: 'passed' }], [], revision).status, 'execution_error');
});

test('invalidated decisions remain historical and latest timestamps govern active decisions', () => {
  const currentPlan = { checks: [human] };
  const decision = { checkId: human.id, revision, result: 'pass', timestamp: '2026-09-30T10:00:00Z' };
  assert.equal(deriveOutcome(currentPlan, [], [{ ...decision, invalidatedAt: '2026-09-30T11:00:00Z' }], revision).status, 'awaiting_human');
  assert.equal(deriveOutcome(currentPlan, [], [{ ...decision, result: 'fail', timestamp: '2026-09-30T12:00:00Z' }, decision], revision).status, 'failed');
});

test('optional checks remain visible but do not impose a mandatory signoff', () => {
  const result = deriveOutcome({ checks: [automated, { ...human, required: false }] }, [{ checkId: automated.id, status: 'passed' }], [], revision);
  assert.equal(result.status, 'passed');
  assert.equal(result.counts.awaiting_human, 1);
});
