// Slack messages, posted via an incoming webhook (no Slack app needed).

async function postMessage(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
}

// NOTE: real @-pings need a Slack member ID. Plain handles below just show as
// text. Put the member ID in roster "slack" if you want it to actually ping.
function mention(person) {
  return /^U[A-Z0-9]+$/.test(person.slack) ? `<@${person.slack}>` : `@${person.slack}`;
}

function newPrMessage(prRow, roster) {
  const link = prRow.url ? `<${prRow.url}|#${prRow.number} ${prRow.title}>` : `#${prRow.number} ${prRow.title}`;
  return `:new: *New PR needs QA from everyone* — ${link}\nPlease review: ${roster.map(mention).join(' ')}`;
}

function weeklyReportMessage(coverage) {
  const L = [];
  L.push(`:calendar: *Weekly QA report — ${coverage.release}*`);
  L.push(`${coverage.fullyCovered} of ${coverage.totalPRs} PRs reviewed by everyone.`);
  const behind = coverage.interns.filter((i) => i.missing.length);
  if (!behind.length) {
    L.push('Everyone is fully caught up. :tada:');
  } else {
    L.push('', 'Still missing reviews:');
    for (const i of behind) L.push(`• @${i.slack}: ${i.missing.map((n) => '#' + n).join(', ')}`);
  }
  return L.join('\n');
}

function planMessage(pr, plan, changed) {
  const link = pr.url ? `<${pr.url}|#${pr.number} ${pr.title}>` : `#${pr.number} ${pr.title}`;
  const head = changed ? ':memo: *QA plan updated*' : ':memo: *QA plan ready*';
  const areas = plan.areas.length ? plan.areas.join(', ') : 'General';
  return `${head} — ${link}\nAreas to test: ${areas}\nFull plan is posted on the PR.`;
}

module.exports = { postMessage, newPrMessage, weeklyReportMessage, planMessage, mention };
