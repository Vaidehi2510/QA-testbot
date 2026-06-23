// QA sign-off handler. Runs on pull_request_review and issue_comment events.
// Swaps needs-qa → qa-complete on a passing sign-off and posts a Slack notification.
// Called from .github/workflows/qa-signoff.yml via actions/github-script.

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
  const event = context.eventName;

  if (event === 'workflow_dispatch') {
    core.info('Manual trigger — no sign-off event to process. Workflow is healthy.');
    return;
  }

  let prNumber, reviewer, result, prTitle;

  if (event === 'pull_request_review') {
    const review = context.payload.review;
    const pr = context.payload.pull_request;
    const state = (review.state || '').toUpperCase();
    if (state === 'APPROVED') {
      result = 'pass';
    } else if (state === 'CHANGES_REQUESTED') {
      result = 'fail';
    } else {
      core.info(`Ignoring review state: ${review.state}`);
      return;
    }
    prNumber = pr.number;
    reviewer = review.user.login;
    prTitle = pr.title;

  } else if (event === 'issue_comment') {
    const issue = context.payload.issue;
    if (!issue.pull_request) {
      core.info('Comment is on a plain issue, not a PR — skipping.');
      return;
    }
    const body = context.payload.comment.body || '';
    const m = body.match(/\/qa-tested\s+result:(pass|fail)/i);
    if (!m) return;
    prNumber = issue.number;
    reviewer = context.payload.comment.user.login;
    result = m[1].toLowerCase();
    prTitle = issue.title;

  } else {
    core.info(`Unexpected event: ${event}`);
    return;
  }

  const isPass = result === 'pass';
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  // Idempotency: read current labels before making any changes.
  const { data: currentLabels } = await github.rest.issues.listLabelsOnIssue({
    owner, repo, issue_number: prNumber,
  });
  const labelNames = currentLabels.map(l => l.name);

  if (isPass && labelNames.includes('qa-complete')) {
    core.info(`PR #${prNumber} already has qa-complete — skipping duplicate sign-off.`);
    return;
  }

  if (isPass) {
    // Ensure qa-complete label exists in the repo.
    try {
      await github.rest.issues.getLabel({ owner, repo, name: 'qa-complete' });
    } catch {
      try {
        await github.rest.issues.createLabel({
          owner, repo, name: 'qa-complete', color: '0e8a16', description: 'QA signed off',
        });
      } catch {}
    }
    // Remove needs-qa and add qa-complete.
    if (labelNames.includes('needs-qa')) {
      try {
        await github.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name: 'needs-qa' });
      } catch {}
    }
    try {
      await github.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: ['qa-complete'] });
    } catch (e) {
      core.info(`Could not add qa-complete: ${e.message}`);
    }
  }

  const icon = isPass ? ':white_check_mark:' : ':x:';
  const verb = isPass ? 'passed' : 'failed';
  const slackText = [
    `${icon} *QA ${verb}* — <${prUrl}|#${prNumber} ${prTitle}>`,
    `Signed off by *@${reviewer}* with result: *${result}*`,
  ].join('\n');
  await postToSlack(process.env.SLACK_WEBHOOK_URL, slackText);
  core.info(`Sign-off recorded: PR #${prNumber}, reviewer: ${reviewer}, result: ${result}`);
};
