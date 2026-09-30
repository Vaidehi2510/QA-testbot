const test = require('node:test');
const assert = require('node:assert/strict');
const { generatePlan, fingerprint, matchedRules } = require('../src/planner');

const revision = 'a'.repeat(40);
const pr = { repository: 'example/app', number: 42, revision, title: 'Validate profile names',
  body: 'Reject an empty profile name with a validation error.',
  files: [{ filename: 'src/profile.js', patch: '@@ -1 +1 @@\n-return name;\n+if (!name) throw new Error("invalid name");' }],
  existingTests: [{ path: 'test/profile.test.js', content: 'assert.throws(() => saveProfile(""))' }],
  specifications: [{ path: 'docs/profile.md', content: 'Empty names must be rejected.' }] };
const config = { runners: [{ id: 'node-tests', baseline: true, expected: 'The baseline assertions pass.' },
  { id: 'profile-tests', match: ['profile'], expected: 'Empty names are rejected.' }] };

test('baseline and relevant suites execute without routine human signoff', () => {
  const plan = generatePlan(pr, [], config);
  assert.deepEqual(plan.checks.map((check) => check.id), ['runner-node-tests', 'runner-profile-tests']);
  assert.ok(plan.checks.every((check) => check.method === 'automated'));
  assert.ok(plan.checks[0].support.includes('test/profile.test.js'));
  assert.ok(plan.checks[1].support.includes('docs/profile.md'));
  assert.ok(plan.findings.some((finding) => finding.kind === 'input-validation'));
  assert.ok(plan.findings.some((finding) => finding.kind === 'error-handling'));
});

test('fingerprints include revision, patch, descriptions, specifications, tests, and trusted config', () => {
  const before = fingerprint(pr, [], config);
  const variants = [
    { ...pr, revision: 'b'.repeat(40) },
    { ...pr, body: 'Changed expectation.' },
    { ...pr, files: [{ ...pr.files[0], patch: '+return true;' }] },
    { ...pr, specifications: [{ path: 'docs/profile.md', content: 'Accept empty names.' }] },
    { ...pr, existingTests: [{ path: 'test/profile.test.js', content: 'new assertion' }] },
  ];
  for (const value of variants) assert.notEqual(fingerprint(value, [], config), before);
  assert.notEqual(fingerprint(pr, [], { ...config, environment: 'new-image' }), before);
  assert.equal(fingerprint({ ...pr, files: [...pr.files].reverse() }, [], config), before);
  assert.equal(generatePlan(pr, [], config).checks[0].id, generatePlan(variants[0], [], config).checks[0].id);
});

test('requirements and diff content select configured scenarios outside path matches', () => {
  const rules = [{ id: 'access', label: 'Access', patchMatch: ['permission'], requirementMatch: ['role'],
    journeys: ['Reject access by disallowed roles'], checks: [{ id: 'denied', runner: 'auth-tests', expected: 'A guest receives 403.', requirement: 'access-policy' }] }];
  const plan = generatePlan({ ...pr, body: 'Guest role must receive 403.' }, rules, {
    runners: [...config.runners, { id: 'auth-tests' }],
  });
  assert.ok(plan.areas.includes('Access'));
  assert.ok(plan.journeys.includes('Reject access by disallowed roles'));
  const check = plan.checks.find((item) => item.runner === 'auth-tests');
  assert.ok(check.support.includes('access-policy'));
  assert.equal(check.expected, 'A guest receives 403.');
});

test('specific ambiguity question references its source and independent tests remain planned', () => {
  const plan = generatePlan({ ...pr, specifications: [{ path: 'docs/profile.md', content: 'TBD: should empty names be accepted or rejected?' }] }, [], config);
  const question = plan.checks.find((check) => check.method === 'human');
  assert.equal(question.kind, 'requirement');
  assert.match(question.question, /empty names.*accepted or rejected/);
  assert.ok(question.support.includes('docs/profile.md'));
  assert.ok(plan.checks.some((check) => check.method === 'automated'));
});

test('code alone cannot supply an expected requirement', () => {
  const plan = generatePlan({ ...pr, body: '', specifications: [] }, [], config);
  assert.equal(plan.checks.find((check) => check.id === 'implementation-intent').kind, 'implementation');
});

test('conflicting structured requirements require an owner decision rather than inventing an assertion', () => {
  const plan = generatePlan({ ...pr, body: 'QA-EXPECT profile.empty-name: accept',
    specifications: [{ path: 'docs/profile.md', content: 'QA-EXPECT profile.empty-name: reject' }] }, [], config);
  const conflict = plan.checks.find((check) => check.id === 'requirement-conflict-profile-empty-name');
  assert.equal(conflict.method, 'human');
  assert.match(conflict.question, /accept.*PR description.*reject.*docs\/profile.md/);
  assert.deepEqual(conflict.support, ['PR description', 'docs/profile.md']);
});

test('no baseline, unsupported scenario, and incomplete inspection stay explicit', () => {
  const rules = [{ id: 'profile', match: ['profile'], label: 'Profile', checks: [{ id: 'external', runner: 'missing', expected: 'A valid profile is saved.' }] }];
  const plan = generatePlan({ ...pr, inspectionLimitations: ['GitHub diff was truncated.'] }, rules, { runners: [] });
  assert.deepEqual(plan.checks.filter((check) => check.method === 'unsupported').map((check) => check.id),
    ['baseline-unconfigured', 'profile-external', 'inspection-incomplete']);
  assert.match(plan.markdown, /diff was truncated/);
});

test('path matching accepts original string files and invalid trusted patterns fail closed', () => {
  assert.equal(matchedRules(['src/profile.js'], [{ match: ['profile'] }]).length, 1);
  assert.throws(() => generatePlan(pr, [{ id: 'bad', match: ['['] }], config), /Invalid trusted QA match/);
});

test('multiple feature scenarios on one runner do not duplicate execution', () => {
  const rules = [{ id: 'profile', label: 'Profile', match: ['profile'], checks: [
    { id: 'empty', runner: 'profile-tests', expected: 'Reject empty values.' },
    { id: 'length', runner: 'profile-tests', expected: 'Reject overly long values.' },
  ] }];
  const plan = generatePlan(pr, rules, config);
  const selected = plan.checks.filter((check) => check.runner === 'profile-tests');
  assert.equal(selected.length, 1);
  assert.match(selected[0].expected, /Reject empty values.*Reject overly long values/);
});
