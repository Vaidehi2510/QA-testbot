// Fork demo runner — event-driven QA plan generator.
// Runs inside the forked apollo-desktop repo on pull_request events, using the
// built-in GITHUB_TOKEN (no App, no PAT, no secrets). It reads the PR's changed
// files, builds a QA plan from the rules, and posts/updates it as a PR comment.
//
// Called from .github/workflows/qa-plan.yml via actions/github-script, which
// passes in `github` (an authenticated Octokit), `context`, and `core`.

const fs = require('fs');
const path = require('path');
const { generatePlan } = require('./planner.js');

async function postToSlack(webhookUrl, text) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack returned ${res.status}`);
  } catch (e) {
    console.error(`Slack post failed: ${e.message}`);
  }
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info('No pull_request in payload — nothing to do.');
    return;
  }

  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa-rules.json'), 'utf8'));

  // Gather the PR's changed files.
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100,
  });

  const plan = generatePlan(
    { number: pr.number, title: pr.title, body: pr.body || '', files: files.map((f) => f.filename) },
    rules,
  );

  // Post or update a single marker comment so re-runs don't duplicate.
  const marker = '<!-- qa-plan:auto -->';
  const body = `${marker}\n${plan.markdown}`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: pr.number, per_page: 100,
  });
  const existing = comments.find((c) => (c.body || '').startsWith(marker));

  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    core.info(`Updated QA plan on PR #${pr.number}.`);
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
    core.info(`Posted QA plan on PR #${pr.number}.`);
  }

  // Label the PR as needing QA (create the label if missing).
  try {
    await github.rest.issues.getLabel({ owner, repo, name: 'needs-qa' });
  } catch {
    try { await github.rest.issues.createLabel({ owner, repo, name: 'needs-qa', color: 'e4e669', description: 'Needs QA review' }); } catch {}
  }
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ['needs-qa'] });
  } catch (e) {
    core.info(`Could not add label: ${e.message}`);
  }

  // Slack notification — new PR needs QA, with the plan's areas.
  const areas = plan.areas.length ? plan.areas.join(', ') : 'General';
  const slackText = [
    `:test_tube: *New PR needs QA* — <${pr.html_url}|#${pr.number} ${pr.title}>`,
    `Areas to test: ${areas}`,
    `A QA plan has been posted on the PR. Please review and sign off with an Approve review or \`/qa-tested result:pass\`.`,
  ].join('\n');
  await postToSlack(process.env.SLACK_WEBHOOK_URL, slackText);

  core.info(`QA plan areas: ${plan.areas.join(', ') || 'General'}`);
};
