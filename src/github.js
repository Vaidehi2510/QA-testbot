// All GitHub I/O lives here. Authenticates as the GitHub App installation on
// the target repo and fetches the release's PRs with their reviews + comments.

const { createAppAuth } = require('@octokit/auth-app');
const { Octokit } = require('@octokit/rest');

async function getClient({ appId, privateKey, owner, repo }) {
  const app = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  const { data: install } = await app.rest.apps.getRepoInstallation({ owner, repo });
  return new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId: install.id } });
}

async function fetchReleasePRs(gh, owner, repo, config) {
  // Prefer the milestone (includes merged PRs); fall back to the needs-qa label.
  const milestones = await gh.paginate(gh.rest.issues.listMilestones, { owner, repo, state: 'all', per_page: 100 });
  const ms = milestones.find((m) => m.title === config.releaseMilestone);

  const issues = ms
    ? await gh.paginate(gh.rest.issues.listForRepo, { owner, repo, milestone: ms.number, state: 'all', per_page: 100 })
    : await gh.paginate(gh.rest.issues.listForRepo, { owner, repo, labels: config.needsQaLabel, state: 'all', per_page: 100 });

  const prs = [];
  for (const i of issues.filter((x) => x.pull_request)) {
    const [reviews, comments, files] = await Promise.all([
      gh.paginate(gh.rest.pulls.listReviews, { owner, repo, pull_number: i.number, per_page: 100 }),
      gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: i.number, per_page: 100 }),
      gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: i.number, per_page: 100 }),
    ]);
    prs.push({
      number: i.number,
      title: i.title,
      body: i.body || '',
      url: i.html_url,
      state: i.state,
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      milestone: i.milestone && i.milestone.title,
      files: files.map((f) => f.filename),
      reviews: reviews.map((r) => ({ user: r.user && r.user.login, state: r.state, submittedAt: r.submitted_at })),
      comments: comments.map((c) => ({ user: c.user && c.user.login, body: c.body, createdAt: c.created_at })),
    });
  }
  return prs;
}

// Create or update a single bot comment, identified by a hidden marker.
// This is how we post a QA plan once and edit it instead of duplicating.
async function upsertComment(gh, owner, repo, prNumber, marker, body) {
  const full = `${marker}\n${body}`;
  const comments = await gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 });
  const existing = comments.find((c) => (c.body || '').startsWith(marker));
  if (existing) {
    await gh.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: full });
    return existing.id;
  }
  const res = await gh.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: full });
  return res.data.id;
}

module.exports = { getClient, fetchReleasePRs, upsertComment };
