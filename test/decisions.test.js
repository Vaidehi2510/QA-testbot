const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDecision, recordDecision, routeRequest } = require('../src/decisions');

const revision = 'a'.repeat(40);
const check = { id: 'billing-policy', method: 'human', kind: 'requirement', area: 'Billing' };
const pr = { author: 'author', revision };
const config = { featureOwners: { Billing: ['owner'] }, decisionReviewers: ['qa'], qaGroupId: 'S12345' };
const people = [
  { github: 'owner', slackId: 'U11111', verified: true },
  { github: 'author', slackId: 'U22222', verified: true },
  { github: 'qa', slackId: 'U33333', verified: true },
];
const comment = { id: 19, user: 'owner', createdAt: '2026-09-30T10:00:00Z',
  body: `/qa-tested check:${check.id} revision:${revision} result:pass reason:Validated the decline policy against specification BILL-12.` };

test('strict commands require a check, full revision, actual decision, and explanation', () => {
  assert.equal(parseDecision(comment.body).explanation, 'Validated the decline policy against specification BILL-12.');
  for (const invalid of ['ack', '/qa-tested', `looks good ${comment.body}`, comment.body.replace('a'.repeat(40), 'a'.repeat(7)),
    comment.body.replace('result:pass', 'result:ack'), comment.body.replace(/reason:.*/, 'reason: '),
    comment.body.replace(/reason:.*/, 'reason: acknowledged'), `${comment.body}\nMore text`]) {
    assert.equal(parseDecision(invalid), null, invalid);
  }
});

test('authorized decisions retain the responder, explanation, timestamp, revision, and comment ID', () => {
  const result = recordDecision(comment, { checks: [check] }, pr, config);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.decision, { checkId: check.id, revision, result: 'pass', responder: 'owner',
    explanation: 'Validated the decline policy against specification BILL-12.', timestamp: comment.createdAt, commentId: comment.id });
});

test('reject unauthorized, stale, unknown, unauditable, and automated-check responses', () => {
  assert.equal(recordDecision({ ...comment, user: 'outsider' }, { checks: [check] }, pr, config).accepted, false);
  assert.equal(recordDecision(comment, { checks: [check] }, { ...pr, revision: 'b'.repeat(40) }, config).accepted, false);
  assert.equal(recordDecision(comment, { checks: [] }, pr, config).accepted, false);
  assert.equal(recordDecision({ ...comment, createdAt: undefined }, { checks: [check] }, pr, config).accepted, false);
  assert.equal(recordDecision(comment, { checks: [{ ...check, method: 'automated' }] }, pr, config).accepted, false);
});

test('author may answer implementation intent but not approve an owner requirement', () => {
  const response = { ...comment, user: 'author' };
  assert.equal(recordDecision(response, { checks: [check] }, pr, config).accepted, false);
  assert.equal(recordDecision(response, { checks: [{ ...check, kind: 'implementation' }] }, pr, config).accepted, true);
});

test('route to verified feature owner without notifying every configured reviewer', () => {
  const routed = routeRequest(check, pr, people, config);
  assert.deepEqual(routed.mentions, ['<@U11111>']);
  assert.deepEqual(routed.github, ['owner']);
});

test('route to configured reviewer, author for implementation, and QA group when mappings absent', () => {
  assert.deepEqual(routeRequest(check, pr, people.filter((person) => person.github !== 'owner'), config).mentions, ['<@U33333>']);
  assert.ok(routeRequest({ ...check, kind: 'implementation' }, pr, people, config).mentions.includes('<@U22222>'));
  const fallback = routeRequest(check, pr, [], config);
  assert.equal(fallback.recipientType, 'qa_group');
  assert.deepEqual(fallback.mentions, ['<!subteam^S12345>']);
});

test('unverified display names and malformed IDs never become mentions', () => {
  const routed = routeRequest(check, pr, [{ github: 'owner', slackId: 'U11111', verified: false },
    { github: 'qa', slackId: 'Friendly Person', verified: true }], config);
  assert.deepEqual(routed.mentions, ['<!subteam^S12345>']);
  assert.deepEqual(routeRequest(check, pr, [], { qaGroupId: '<!channel>' }).mentions, []);
});

test('author fallback includes QA group and does not grant approval authority', () => {
  const routed = routeRequest(check, pr, people.filter((person) => person.github === 'author'), config);
  assert.deepEqual(routed.mentions, ['<@U22222>', '<!subteam^S12345>']);
  assert.equal(recordDecision({ ...comment, user: 'author' }, { checks: [check] }, pr, config).accepted, false);
});
