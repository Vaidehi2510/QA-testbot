const test = require('node:test');
const assert = require('node:assert/strict');
const { SlackAdapter, postMessage, completionMessage, requestMessage, mention } = require('../src/slack.js');

function fixture() {
  return { repository: 'org/app', pr: { number: 7, title: 'Checkout <!channel>', url: 'https://github.com/org/app/pull/7' }, revision: 'a'.repeat(40), environment: 'synthetic', runId: 'run1', attempt: 1, plan: { checks: [{ id: 'unit', method: 'automated', required: true }] }, results: [{ checkId: 'unit', status: 'passed' }], decisions: [], outcome: { status: 'failed' }, report: { status: 'pending' }, evidenceUrl: 'https://github.com/org/bot/actions/runs/10' };
}

test('completion recomputes result, escapes mention injection and shows upload pending', () => {
  const run = fixture();
  const text = completionMessage(run);
  assert.match(text, /Outcome: passed/);
  assert.match(text, /1 passed/);
  assert.match(text, /QA completed automatically/);
  assert.match(text, /report upload pending/);
  assert.ok(text.includes(run.revision));
  assert.ok(!text.includes('<!channel>'));
  assert.ok(text.includes('&lt;!channel&gt;'));
});

test('exact pending sentence only appears for required human input after automated pass', () => {
  const run = fixture();
  run.plan.checks.push({ id: 'visual', method: 'human', required: true });
  assert.match(completionMessage(run), /Automated checks passed; human QA review pending\./);
  assert.match(completionMessage(run), /questions for visual\./);
  run.plan.checks.push({ id: 'unsupported', method: 'unsupported', required: true });
  assert.match(completionMessage(run), /Outcome: blocked/);
  assert.doesNotMatch(completionMessage(run), /Automated checks passed; human QA review pending\./);
});

test('failed automation and human decisions give factual details instead of claimed success', () => {
  const run = fixture(); run.outcome.status = 'passed'; run.results[0] = { checkId: 'unit', status: 'failed', details: 'Total was negative' };
  assert.match(completionMessage(run), /Outcome: failed/);
  assert.match(completionMessage(run), /Total was negative/);
  assert.doesNotMatch(completionMessage(run), /targeted GitHub questions/);
  run.plan.checks.push({ id: 'visual', method: 'human', required: true });
  run.decisions.push({ checkId: 'visual', revision: run.revision, result: 'fail', explanation: 'Unreadable button label' });
  assert.match(completionMessage(run), /Unreadable button label/);
});

test('human request uses verified mentions and exact revision-bound GitHub command', () => {
  const run = fixture();
  const text = requestMessage({ id: 'visual', question: 'Which contrast is intended?', reason: 'No acceptance criteria' }, { ...run.pr, revision: run.revision }, { mentions: ['<@U123>', '<!subteam^S123>', '<!channel>'], reason: 'Feature owner' });
  assert.ok(text.includes('<@U123> <!subteam^S123>'));
  assert.ok(!text.includes('<!channel>'));
  assert.ok(text.includes(`/qa-tested check:visual revision:${run.revision} result:pass reason:`));
  assert.equal(mention({ slackId: 'U123' }), '');
  assert.equal(mention({ slackId: 'U123', verified: true }), '<@U123>');
  assert.equal(mention({ slackId: 'friendly-name', verified: true }), '');
});

test('dry-run previews both transports without any network calls', async () => {
  const fetchImpl = () => { throw new Error('Network forbidden'); };
  for (const options of [{ webhookUrl: 'https://hooks.slack.com/secret' }, { botToken: 'secret', channelId: 'C123' }]) {
    assert.equal((await new SlackAdapter({ ...options, dryRun: true, fetchImpl }).send('Preview')).status, 'preview');
  }
  assert.equal((await postMessage('https://hooks.slack.com/secret', 'Preview', { dryRun: true, fetchImpl })).status, 'preview');
});

test('Slack API failures and webhook HTTP failures are not delivered receipts', async () => {
  await assert.rejects(new SlackAdapter({ botToken: 'token', channelId: 'C1', dryRun: false, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, error: 'secret body' }) }) }).send('hello'), /Slack API rejected/);
  await assert.rejects(new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/secret', dryRun: false, fetchImpl: async () => ({ ok: false, status: 429 }) }).send('hello'), /HTTP 429/);
  assert.equal((await new SlackAdapter({ dryRun: false }).send('hello')).status, 'pending');
});

test('timeouts are bounded and redact secret webhook URLs', async () => {
  await assert.rejects(new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/secret', dryRun: false, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }).send('hello'), /timed out; delivery is uncertain/);
  await assert.rejects(new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/secret', dryRun: false, fetchImpl: async () => { throw new Error('failed https://hooks.slack.com/secret'); } }).send('hello'), (error) => !error.message.includes('secret'));
});

test('bot messages return timestamp and stable delivery key', async () => {
  const payloads = [];
  const slack = new SlackAdapter({ botToken: 'token', channelId: 'C1', dryRun: false, fetchImpl: async (url, options) => { payloads.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, ts: '123.456', channel: 'C1' }) }; } });
  assert.equal((await slack.send('hello', { key: 'run1:complete' })).ts, '123.456');
  await slack.send('hello', { key: 'run1:complete' });
  assert.equal(payloads[0].client_msg_id, payloads[1].client_msg_id);
  assert.equal(payloads[0].parse, 'none');
});

test('completion reports actual runner tests separately and discloses missing per-test counts', () => {
  const run = fixture();
  run.results[0].counts = { tests: 8, passed: 8, failed: 0, skipped: 0, cancelled: 0 };
  assert.match(completionMessage(run), /Checks: 1 passed/);
  assert.match(completionMessage(run), /Tests: 8 total, 8 passed/);
  run.results.push({ checkId: 'missing-counts', status: 'execution_error' });
  assert.match(completionMessage(run), /counts supplied by 1 of 2 executed checks/);
  run.results[0].counts.tests = -1;
  assert.match(completionMessage(run), /per-test counts are unavailable/);
});
