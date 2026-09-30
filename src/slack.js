const crypto = require('node:crypto');
const { deriveOutcome } = require('./core.js');
const { testCountSummary } = require('./report.js');
class SlackError extends Error {}

// Escape all untrusted PR/test text before inserting Slack's deliberate markup.
const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const brief = (value) => escape(typeof value === 'object' ? JSON.stringify(value) : value).replace(/[\r\n]+/g, ' ').slice(0, 600);
function link(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return `<${escape(parsed.href.replace(/\|/g, '%7C'))}|${escape(label).replace(/\|/g, '¦')}>`;
  } catch {}
  return escape(label);
}

function mention(person) {
  return person?.verified === true && /^[UW][A-Z0-9]+$/.test(person.slackId || person.slack || '') ? `<@${person.slackId || person.slack}>` : '';
}

function planMessage(pr, plan, changed = false) {
  return `*QA plan ${changed ? 'updated' : 'ready'}* — ${link(pr.url, `#${pr.number} ${pr.title}`)}\nAffected areas: ${(plan.areas || []).map(escape).join(', ') || 'General'}\nThe check plan is posted on the PR.`;
}

function completionMessage(run) {
  const outcome = deriveOutcome(run.plan || { checks: [] }, run.results || [], run.decisions || [], run.revision);
  const humanPending = (outcome.pending || []).filter((check) => check.method === 'human' && check.status === 'awaiting_human');
  const lines = [
    `*QA result* — ${link(run.pr.url, `#${run.pr.number} ${run.pr.title}`)}`,
    `Repository: ${escape(run.repository)} · revision: ${escape(run.revision)}`,
    `Environment: ${escape(run.environment)} · run ${escape(run.runId)} / attempt ${escape(run.attempt)}`,
    outcome.status === 'awaiting_human' && outcome.automatedPassed && humanPending.length ? 'Automated checks passed; human QA review pending.' : `Outcome: ${escape(outcome.status)}`,
    `Checks: ${Object.entries(outcome.counts || {}).map(([status, count]) => `${count} ${status.replace(/_/g, ' ')}`).join(', ')}`,
    testCountSummary(run.results || []),
  ];
  const issues = (outcome.checkResults || []).filter((r) => ['failed', 'execution_error', 'blocked', 'skipped'].includes(r.status));
  for (const issue of issues.slice(0, 4)) {
    const result = (run.results || []).find((r) => r.checkId === issue.checkId);
    const details = result?.details || issue.source?.explanation;
    lines.push(`${escape(issue.checkId)}: ${escape(issue.status)}${details ? ` — ${brief(details)}` : ''}`);
  }
  if (issues.length > 4) lines.push(`${issues.length - 4} additional issues are recorded in the report.`);
  lines.push(run.report?.status === 'uploaded' && run.report.url ? `Google Drive report: ${link(run.report.url, 'Open run report')}` : 'Google Drive: report upload pending');
  lines.push(run.evidenceUrl ? `Test evidence: ${link(run.evidenceUrl, 'Open evidence')}` : 'Test evidence: no evidence link available.');
  if (humanPending.length) lines.push(`Required action: respond to the targeted GitHub questions for ${humanPending.map((c) => escape(c.id || c.checkId)).join(', ')}. An acknowledgment is not a decision.`);
  if (issues.length) lines.push('Required action: investigate the recorded issues and rerun the affected checks after fixing or unblocking them.');
  if (!humanPending.length && !issues.length && outcome.status === 'passed') lines.push('Required action: none; QA completed automatically.');
  if (!humanPending.length && !issues.length && outcome.status !== 'passed') lines.push('Required action: configure and execute the required checks; no successful QA outcome is established.');
  return lines.join('\n');
}

function requestMessage(check, pr, routing = {}) {
  const mentions = (routing.mentions || []).filter((item) => /^<@[UW][A-Z0-9]+>$/.test(item) || /^<!subteam\^S[A-Z0-9]+>$/.test(item));
  const revision = pr.revision || pr.headSha || pr.head?.sha;
  return [
    `*Human QA input needed* — ${link(pr.url, `#${pr.number} ${pr.title}`)}`,
    mentions.join(' ') || 'QA channel: no verified individual mapping is configured.',
    `Check: ${escape(check.id)} · revision: ${escape(revision)}`,
    `Needed: ${escape(check.question || check.expected || check.reason)}`,
    `Why: ${escape(check.reason)}`,
    `Routing: ${escape(routing.reason || 'Feature ownership or verified reviewer mapping')}`,
    'An authorized responder must leave this single-line comment on the PR, choosing pass or fail and replacing the explanation:',
    `\`/qa-tested check:${escape(check.id)} revision:${escape(revision)} result:pass reason:Your decision and supporting explanation\``,
    'Use result:fail if the requirement or check is not satisfied. An acknowledgment does not resolve this check. Independent automated checks continue.',
  ].join('\n');
}

function reportAvailableMessage(run) {
  return `*QA report available* — ${link(run.pr.url, `#${run.pr.number} ${run.pr.title}`)}\nRevision: ${escape(run.revision)} · run ${escape(run.runId)} / attempt ${escape(run.attempt)}\n${link(run.report?.url, 'Open Google Drive run report')}`;
}

class SlackAdapter {
  constructor({ webhookUrl, botToken, channelId, dryRun = /^(true|1|yes)$/i.test(process.env.DRY_RUN || ''), fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    Object.assign(this, { webhookUrl, botToken, channelId, dryRun, fetchImpl, timeoutMs });
  }

  async send(text, { key } = {}) {
    if (this.dryRun) return { status: 'preview', text };
    if (!this.webhookUrl && !(this.botToken && this.channelId)) return { status: 'pending', reason: 'Slack is not configured' };
    const bot = Boolean(this.botToken && this.channelId);
    const url = bot ? 'https://slack.com/api/chat.postMessage' : this.webhookUrl;
    const payload = { text, unfurl_links: false, unfurl_media: false, ...(bot ? { channel: this.channelId, parse: 'none' } : {}) };
    if (bot && key) {
      const hex = crypto.createHash('sha256').update(key).digest('hex');
      payload.client_msg_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bot ? { Authorization: `Bearer ${this.botToken}` } : {}) }, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error' });
          if (!response.ok) throw new SlackError(`Slack request failed (HTTP ${response.status})`);
          if (!bot) return { status: 'sent', transport: 'webhook' };
          const data = await response.json();
          if (!data.ok) throw new SlackError('Slack API rejected the message');
          return { status: 'sent', transport: 'bot', ts: data.ts, channel: data.channel };
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SlackError('Slack request timed out; delivery is uncertain')); }, this.timeoutMs); }),
      ]);
    } catch (error) {
      // The webhook URL is itself a secret, so never forward raw fetch errors.
      if (error instanceof SlackError) throw error;
      throw new Error('Slack network request failed; delivery is uncertain');
    } finally { clearTimeout(timer); }
  }
}

async function postMessage(webhookUrl, text, options = {}) {
  return new SlackAdapter({ ...options, webhookUrl }).send(text, options);
}

module.exports = { SlackAdapter, postMessage, completionMessage, requestMessage, reportAvailableMessage, planMessage, mention, escape };
