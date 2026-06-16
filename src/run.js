// The every-few-minutes sync. Updates each PR's label, alerts Slack about new
// PRs (once each), and writes the coverage dashboard.

const fs = require('fs');
const path = require('path');
const { buildCoverage, prLabel } = require('./core.js');
const { getClient, fetchReleasePRs, upsertComment } = require('./github.js');
const { newPrMessage, planMessage, postMessage } = require('./slack.js');
const { generatePlan } = require('./planner.js');

async function main() {
  const root = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'qa-config.json'), 'utf8'));
  const roster = JSON.parse(fs.readFileSync(path.join(root, 'roster.json'), 'utf8'));

  const owner = process.env.TARGET_OWNER;
  const repo = process.env.TARGET_REPO;
  const appId = process.env.APP_ID;
  const privateKey = (process.env.APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const dryRun = process.env.DRY_RUN === 'true';
  if (!owner || !repo || !appId || !privateKey) {
    throw new Error('Missing TARGET_OWNER, TARGET_REPO, APP_ID or APP_PRIVATE_KEY.');
  }

  const gh = await getClient({ appId, privateKey, owner, repo });
  const prs = await fetchReleasePRs(gh, owner, repo, config);
  const coverage = buildCoverage(prs, roster, config);

  // Update labels on open PRs: qa-complete once everyone has reviewed, else needs-qa.
  for (const pr of prs.filter((p) => p.state === 'open')) {
    const row = coverage.prRows.find((r) => r.number === pr.number);
    if (!row) continue;
    const want = prLabel(row, config);
    const other = want === config.completeLabel ? config.needsQaLabel : config.completeLabel;
    if (dryRun) continue;
    if (!pr.labels.includes(want)) await gh.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [want] });
    if (pr.labels.includes(other)) {
      try { await gh.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: other }); } catch { /* already gone */ }
    }
  }

  // Alert Slack about new PRs — once each.
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (webhook) {
    const statePath = path.join(process.cwd(), 'state', 'announced.json');
    let announced = [];
    try { announced = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { announced = []; }
    const seen = new Set(announced);
    for (const row of coverage.prRows) {
      const key = `pr:${row.number}`;
      if (seen.has(key)) continue;
      if (!dryRun) {
        try { await postMessage(webhook, newPrMessage(row, roster)); } catch (e) { console.error(`Slack failed for #${row.number}: ${e.message}`); }
      }
      seen.add(key);
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify([...seen].slice(-1000), null, 2) + '\n');
  }

  // Generate and post a QA plan per PR — once each, unless the PR changed.
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'qa-rules.json'), 'utf8'));
  const planStatePath = path.join(process.cwd(), 'state', 'plans.json');
  let planState = {};
  try { planState = JSON.parse(fs.readFileSync(planStatePath, 'utf8')); } catch { planState = {}; }

  for (const pr of prs) {
    const plan = generatePlan(pr, rules);
    if (planState[pr.number] === plan.fingerprint) continue; // unchanged → skip
    const changed = planState[pr.number] !== undefined;
    if (!dryRun) {
      await upsertComment(gh, owner, repo, pr.number, '<!-- qa-plan:auto -->', plan.markdown);
      if (webhook) {
        try { await postMessage(webhook, planMessage(pr, plan, changed)); } catch (e) { console.error(`Slack plan post failed for #${pr.number}: ${e.message}`); }
      }
      const plansDir = path.join(process.cwd(), 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      fs.writeFileSync(path.join(plansDir, `pr-${pr.number}.md`), plan.markdown);
      planState[pr.number] = plan.fingerprint;
    }
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(planStatePath), { recursive: true });
    fs.writeFileSync(planStatePath, JSON.stringify(planState, null, 2) + '\n');
  }

  fs.mkdirSync(path.join(process.cwd(), 'docs'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'docs', 'QA_DASHBOARD.md'), renderDashboard(coverage));
  console.log(`Coverage: ${coverage.fullyCovered}/${coverage.totalPRs} PRs reviewed by everyone.`);
}

function renderDashboard(c) {
  const L = [];
  L.push(`# QA coverage — ${c.release}`, '');
  L.push(`_Updated ${new Date().toISOString()} · ${c.fullyCovered}/${c.totalPRs} PRs reviewed by everyone_`, '');
  L.push(c.complete ? '**All PRs reviewed by everyone ✅**' : '**Reviews still outstanding ⏳**', '');
  L.push('## By PR', '', '| PR | Reviewed by | Still missing |', '| --- | --- | --- |');
  for (const p of c.prRows) {
    L.push(`| #${p.number} ${p.title} | ${p.reviewedBy.map((x) => '@' + x).join(', ') || '—'} | ${p.missing.map((x) => '@' + x).join(', ') || '✅ none'} |`);
  }
  L.push('', '## By intern', '', '| Intern | Done | Missing |', '| --- | --- | --- |');
  for (const i of c.interns) {
    L.push(`| @${i.github} | ${i.done.length}/${c.totalPRs} | ${i.missing.map((n) => '#' + n).join(', ') || '✅ none'} |`);
  }
  return L.join('\n') + '\n';
}

main().catch((err) => { console.error(err); process.exit(1); });
