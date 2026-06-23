// The QA-plan rule engine. Pure functions, no AI, no network, no dependencies.
// It looks at a PR's changed files, matches them against rules, and builds a
// markdown QA plan out of templates.

const crypto = require('crypto');

// Used when none of the configured rules match the changed files.
const GENERIC = {
  label: 'General',
  testSteps: [
    'Manually verify the change does what the PR description says',
    'Click through the most affected area of the app',
    'Watch the console / logs for new errors',
  ],
  regression: ['Closely related features still work'],
  expected: ['The change works as described', 'No obvious new errors appear'],
};

function matchedRules(files, rules) {
  return rules.filter((rule) => {
    const patterns = rule.match.map((p) => new RegExp(p, 'i'));
    return (files || []).some((f) => patterns.some((re) => re.test(f)));
  });
}

const uniq = (arr) => [...new Set(arr)];

// A short fingerprint of the PR's content, so we only regenerate when it changes.
function fingerprint(pr) {
  const h = crypto.createHash('sha1');
  h.update([pr.title || '', pr.body || '', ...(pr.files || []).slice().sort()].join('\u0001'));
  return h.digest('hex').slice(0, 12);
}

function generatePlan(pr, rules) {
  const cats = matchedRules(pr.files, rules);
  const used = cats.length ? cats : [GENERIC];
  const sections = {
    areas: used.map((c) => c.label),
    steps: uniq(used.flatMap((c) => c.testSteps || [])),
    regression: uniq(used.flatMap((c) => c.regression || [])),
    expected: uniq(used.flatMap((c) => c.expected || [])),
  };
  return { markdown: renderMarkdown(pr, sections), areas: sections.areas, fingerprint: fingerprint(pr) };
}

const bullets = (a) => (a.length ? a.map((x) => `- ${x}`).join('\n') : '- _none_');
const numbered = (a) => (a.length ? a.map((x, i) => `${i + 1}. ${x}`).join('\n') : '1. _none_');

function renderMarkdown(pr, s) {
  const summary = [pr.title, (pr.body || '').trim()].filter(Boolean).join('\n\n') || '_No description provided._';
  return [
    `# QA Plan for PR #${pr.number}`, '',
    '## Summary', summary, '',
    '## Areas Changed', bullets(s.areas), '',
    '## Test Steps', numbered(s.steps), '',
    '## Regression Checks', bullets(s.regression), '',
    '## Expected Results', bullets(s.expected), '',
    '## Notes', 'Auto-generated from the changed files. Manual verification still recommended.', '',
  ].join('\n');
}

module.exports = { generatePlan, matchedRules, fingerprint };
