// The Friday report. Posts to Slack who still hasn't reviewed which PRs.

const fs = require('fs');
const path = require('path');
const { buildCoverage } = require('./core.js');
const { getClient, fetchReleasePRs } = require('./github.js');
const { weeklyReportMessage, postMessage } = require('./slack.js');

async function main() {
  const root = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'qa-config.json'), 'utf8'));
  const roster = JSON.parse(fs.readFileSync(path.join(root, 'roster.json'), 'utf8'));

  const owner = process.env.TARGET_OWNER;
  const repo = process.env.TARGET_REPO;
  const appId = process.env.APP_ID;
  const privateKey = (process.env.APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!owner || !repo || !appId || !privateKey) throw new Error('Missing required env vars.');

  const gh = await getClient({ appId, privateKey, owner, repo });
  const prs = await fetchReleasePRs(gh, owner, repo, config);
  const coverage = buildCoverage(prs, roster, config);

  if (webhook) await postMessage(webhook, weeklyReportMessage(coverage));
  console.log('Weekly report posted.');
}

main().catch((err) => { console.error(err); process.exit(1); });
