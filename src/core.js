// Pure logic for the "everyone reviews every PR" model. No I/O, no deps.
// Given the release PRs and the intern roster, it works out who has reviewed
// what, and who is still missing which PRs.

function parseSignoff(body, command) {
  return body && body.includes(command) ? true : false;
}

// The set of intern GitHub logins who have QA'd this PR — either by leaving a
// formal review (approve / request changes) or a /qa-tested comment.
function reviewersOf(pr, config) {
  const set = new Set();
  for (const r of pr.reviews || []) {
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(r.state) && r.user) set.add(r.user);
  }
  for (const c of pr.comments || []) {
    if (parseSignoff(c.body, config.signoffCommand) && c.user) set.add(c.user);
  }
  return set;
}

function inRelease(pr, config) {
  const managed = [config.needsQaLabel, config.completeLabel];
  return pr.milestone === config.releaseMilestone || (pr.labels || []).some((l) => managed.includes(l));
}

// Build the full coverage picture: per-PR and per-intern.
function buildCoverage(prs, roster, config) {
  const releasePRs = prs.filter((p) => inRelease(p, config));
  const logins = roster.map((r) => r.github);

  const prRows = releasePRs.map((pr) => {
    const reviewed = reviewersOf(pr, config);
    const reviewedBy = logins.filter((g) => reviewed.has(g));
    const missing = logins.filter((g) => !reviewed.has(g));
    return { number: pr.number, title: pr.title, url: pr.url, state: pr.state, reviewedBy, missing, complete: missing.length === 0 };
  });

  const interns = roster.map((person) => {
    const done = prRows.filter((p) => p.reviewedBy.includes(person.github)).map((p) => p.number);
    const missing = prRows.filter((p) => p.missing.includes(person.github)).map((p) => p.number);
    return { ...person, done, missing, complete: missing.length === 0 };
  });

  return {
    release: config.releaseMilestone,
    totalPRs: prRows.length,
    fullyCovered: prRows.filter((p) => p.complete).length,
    complete: prRows.length > 0 && prRows.every((p) => p.complete),
    prRows,
    interns,
  };
}

// A PR is "done" only when every intern has reviewed it.
function prLabel(prRow, config) {
  return prRow.complete ? config.completeLabel : config.needsQaLabel;
}

module.exports = { parseSignoff, reviewersOf, inRelease, buildCoverage, prLabel };
