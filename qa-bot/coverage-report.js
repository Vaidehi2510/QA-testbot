// Coverage report runner. Fetches GitHub data and delegates logic to coverage.js.
// Called from .github/workflows/qa-coverage.yml via actions/github-script.

const fs = require('fs');
const path = require('path');
const { buildCoverage, renderSlackReport } = require('./coverage.js');

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
  const roster = JSON.parse(fs.readFileSync(path.join(__dirname, 'roster.json'), 'utf8'));

  // Gather in-scope PRs: open PRs + any closed PRs still carrying a QA label.
  const allIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: 'all', per_page: 100,
  });
  const inScope = allIssues.filter(i =>
    i.pull_request && (
      i.state === 'open' ||
      (i.labels || []).some(l => ['needs-qa', 'qa-complete'].includes(l.name))
    )
  );

  core.info(`Found ${inScope.length} in-scope PR(s).`);

  // Enrich each PR with its reviews and issue comments.
  const enriched = await Promise.all(inScope.map(async pr => {
    const [reviews, comments] = await Promise.all([
      github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 }),
      github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 }),
    ]);
    return { ...pr, reviews, comments };
  }));

  const coverage = buildCoverage(enriched, roster);
  const text = renderSlackReport(coverage);

  core.info('Coverage report:\n' + text);
  await postToSlack(process.env.SLACK_WEBHOOK_URL, text);
};
