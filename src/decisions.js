// Human decisions are scoped to one planned question and one immutable revision.
const login = (value) => typeof value === 'string' ? value.toLowerCase() : value?.login?.toLowerCase();
const list = (value) => Array.isArray(value) ? value : value ? [value] : [];

function parseDecision(body) {
  if (typeof body !== 'string') return null;
  const match = body.trim().match(/^\/qa-tested check:([a-zA-Z0-9_-]+) revision:([a-fA-F0-9]{40}) result:(pass|fail) reason:([^\r\n]+)$/);
  if (!match || !match[4].trim()) return null;
  if (/^(ack|acknowledged|seen|received|thanks|ok|okay|lgtm|looks good)[.!\s]*$/i.test(match[4].trim())) return null;
  return { checkId: match[1], revision: match[2].toLowerCase(), result: match[3], explanation: match[4].trim() };
}

function authorizeDecision(decision, check, pr, config = {}) {
  if (!check || check.method !== 'human') return { authorized: false, reason: 'Only a planned human check accepts a human decision.' };
  if (decision.revision !== pr.revision) return { authorized: false, reason: 'Decision references a stale or different revision.' };
  if (decision.checkId !== check.id) return { authorized: false, reason: 'Decision does not match the planned check.' };
  const responder = login(decision.responder);
  const allowed = new Set([...list(config.decisionReviewers), ...list(config.featureOwners?.[check.area])].map(login).filter(Boolean));
  if (check.kind === 'implementation' && login(pr.author)) allowed.add(login(pr.author));
  return responder && allowed.has(responder) ? { authorized: true } : { authorized: false, reason: 'Responder is not authorized for this check.' };
}

function recordDecision(comment, plan, pr, config = {}) {
  const parsed = parseDecision(comment.body);
  if (!parsed) return { accepted: false, reason: 'Use /qa-tested check:<id> revision:<full SHA> result:pass|fail reason:<explanation>.' };
  const responder = login(comment.user);
  const decision = { ...parsed, responder, timestamp: comment.createdAt || comment.created_at, commentId: comment.id };
  if (!decision.timestamp || !Number.isFinite(Date.parse(decision.timestamp)) || decision.commentId === undefined) {
    return { accepted: false, reason: 'A timestamp and GitHub comment ID are required to audit a decision.' };
  }
  const authorization = authorizeDecision(decision, (plan.checks || []).find((check) => check.id === decision.checkId), pr, config);
  return authorization.authorized ? { accepted: true, decision } : { accepted: false, reason: authorization.reason };
}

function routeRequest(check, pr, people = [], config = {}) {
  const directory = Array.isArray(people) ? people : people.people || [];
  const mapping = new Map(directory.filter((person) => person.verified === true && /^[UW][A-Z0-9]+$/.test(person.slackId || '') && login(person.github))
    .map((person) => [login(person.github), person.slackId]));
  const owners = list(config.featureOwners?.[check.area]);
  const reviewers = list(config.decisionReviewers);
  const responsible = owners.some((person) => mapping.has(login(person))) ? owners : reviewers;
  const candidates = check.kind === 'implementation' ? [pr.author, ...responsible] : responsible;
  let github = [...new Set(candidates.map(login).filter((person) => mapping.has(person)))];
  let recipientType = check.kind === 'implementation' && github.includes(login(pr.author)) ? 'author' : 'owner_or_reviewer';
  if (!github.length && mapping.has(login(pr.author))) {
    github = [login(pr.author)];
    recipientType = 'author_fallback';
  }
  const mentions = github.map((person) => `<@${mapping.get(person)}>`);
  // An author fallback can coordinate without gaining authority to approve requirements.
  const group = /^S[A-Z0-9]+$/.test(config.qaGroupId || '') ? `<!subteam^${config.qaGroupId}>` : null;
  if (!mentions.length || recipientType === 'author_fallback' || config.alwaysNotifyQaGroup) {
    if (group) mentions.push(group);
  }
  if (!github.length) recipientType = group ? 'qa_group' : 'qa_channel';
  return { mentions, github, recipientType, reason: github.length ? 'Verified GitHub-to-Slack mappings select responsible people.' : group ? 'No verified individual mapping; notify the configured QA group.' : 'No verified mapping or QA group; post the question in the configured QA channel.' };
}

module.exports = { parseDecision, authorizeDecision, recordDecision, routeRequest };
