// Pure coverage logic — no I/O, no network, no dependencies.
// Ported from src/core.js, adapted for GitHub REST API data shapes.

const SIGNOFF_COMMAND = '/qa-tested result:pass';

function reviewersOf(reviews, comments, rosterSet) {
  const found = new Set();
  for (const r of reviews || []) {
    const state = (r.state || '').toUpperCase();
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(state) && r.user && rosterSet.has(r.user.login)) {
      found.add(r.user.login);
    }
  }
  for (const c of comments || []) {
    if ((c.body || '').includes(SIGNOFF_COMMAND) && c.user && rosterSet.has(c.user.login)) {
      found.add(c.user.login);
    }
  }
  return found;
}

function buildCoverage(prs, roster) {
  const logins = roster.map(r => r.github);
  const rosterSet = new Set(logins);

  const prRows = prs.map(pr => {
    const reviewed = reviewersOf(pr.reviews, pr.comments, rosterSet);
    const reviewedBy = logins.filter(g => reviewed.has(g));
    const missing = logins.filter(g => !reviewed.has(g));
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      reviewedBy,
      missing,
      complete: missing.length === 0,
    };
  });

  return {
    totalPRs: prRows.length,
    fullyCovered: prRows.filter(p => p.complete).length,
    prRows,
    roster,
  };
}

function renderSlackReport(coverage) {
  const { totalPRs, fullyCovered, prRows, roster } = coverage;
  const lines = [
    `:bar_chart: *Weekly QA Coverage Report*`,
    `*${fullyCovered}/${totalPRs}* PRs fully covered by the roster`,
    '',
  ];

  if (prRows.length === 0) {
    lines.push('_No open or labeled PRs found._');
    return lines.join('\n');
  }

  const slackName = (github) => {
    const m = roster.find(r => r.github === github);
    return m ? m.slack : github;
  };

  for (const pr of prRows) {
    const icon = pr.complete ? ':white_check_mark:' : ':hourglass_flowing_sand:';
    const reviewed = pr.reviewedBy.map(slackName).join(', ') || '_none yet_';
    lines.push(`${icon} *PR #${pr.number}* ${pr.title}`);
    lines.push(`  Reviewed: ${reviewed}`);
    if (pr.missing.length) {
      lines.push(`  Missing: ${pr.missing.map(slackName).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { buildCoverage, renderSlackReport };
