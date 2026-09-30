// Deterministic planning. PR text and patches are evidence, never executable configuration.
const crypto = require('node:crypto');

const uniq = (values) => [...new Set(values.filter(Boolean))];
const asFile = (file) => typeof file === 'string' ? { filename: file } : file;
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(pr, rules = [], config = {}) {
  const content = { repository: pr.repository, number: pr.number, revision: pr.revision,
    title: pr.title, body: pr.body,
    files: (pr.files || []).map(asFile).sort((a, b) => a.filename.localeCompare(b.filename)),
    specifications: (pr.specifications || []).slice().sort((a, b) => a.path.localeCompare(b.path)),
    existingTests: (pr.existingTests || []).slice().sort((a, b) => a.path.localeCompare(b.path)),
    inspectionLimitations: pr.inspectionLimitations || [], rules, config };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

function matches(patterns, values) {
  return (patterns || []).some((pattern) => {
    let expression;
    try { expression = new RegExp(pattern, 'i'); } catch { throw new Error(`Invalid trusted QA match pattern: ${pattern}`); }
    return values.some((value) => expression.test(value));
  });
}

function matchedRules(files, rules = []) {
  const paths = (files || []).map((file) => asFile(file).filename);
  return rules.filter((rule) => matches(rule.match, paths));
}

function relevantTests(files, tests) {
  const tokens = uniq(files.flatMap((file) => file.filename.split(/[/.\-_]/)).filter((s) => s.length > 3));
  return tests.filter((test) => tokens.some((token) => `${test.path}\n${test.content || ''}`.toLowerCase().includes(token.toLowerCase())));
}

function inspectPatch(files) {
  const findings = [];
  for (const file of files) {
    // Heuristics are observations for review; they are not correctness or security proofs.
    const added = (file.patch || '').split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    const removed = (file.patch || '').split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).join('\n');
    const observations = [
      ['input-validation', /\b(validat\w*|saniti[sz]\w*|schema|parse|invalid|missing)\b/i, 'Input validation changed; include valid, missing, and invalid input regression cases.'],
      ['authentication', /\b(authenticat\w*|login|logout|session|token|password)\b/i, 'Authentication behavior changed; inspect authenticated, expired, and unauthenticated paths.'],
      ['authorization', /\b(authoriz\w*|permission|role|access|forbidden)\b/i, 'Authorization behavior changed; inspect allowed and denied roles.'],
      ['error-handling', /\b(catch|throw|reject|timeout|retry|error)\b/i, 'Error handling changed; include expected errors and dependency failure cases.'],
    ];
    for (const [kind, expression, message] of observations) {
      if (expression.test(`${added}\n${removed}`)) findings.push({ id: `${kind}-${slug(file.filename)}`, kind, severity: 'info', file: file.filename, message, source: 'diff-heuristic' });
    }
    if (/\b(eval\s*\(|new\s+Function\s*\(|exec\s*\()/i.test(added)) findings.push({
      id: `dynamic-execution-${slug(file.filename)}`, kind: 'interpretation', severity: 'review', file: file.filename,
      message: 'Added dynamic execution needs interpretation of input trust and intended behavior.', source: 'diff-heuristic',
    });
  }
  return findings;
}

function generatePlan(pr, rules = [], config = {}) {
  const files = (pr.files || []).map(asFile);
  const paths = files.map((file) => file.filename);
  const patch = files.map((file) => file.patch || '').join('\n');
  const requirementText = [pr.body || '', ...(pr.specifications || []).map((spec) => spec.content || '')].join('\n');
  const applies = (entry) => matches(entry.match, paths) || matches(entry.patchMatch, [patch]) || matches(entry.requirementMatch, [requirementText]);
  const selectedRules = rules.filter(applies);
  const areas = uniq(selectedRules.map((rule) => rule.label || rule.id));
  if (!areas.length) areas.push('General');
  const journeys = uniq(selectedRules.flatMap((rule) => rule.journeys || []));
  const checks = [];
  const findings = inspectPatch(files);
  const gaps = [];
  const tests = pr.existingTests || [];
  const relevant = relevantTests(files, tests);
  const specs = pr.specifications || [];
  const support = uniq([...paths, ...(pr.body ? ['PR description'] : []), ...specs.map((spec) => spec.path)]);
  const runners = config.runners || [];
  const selectedRunners = new Map();

  function addCheck(check) {
    if (checks.some((existing) => existing.id === check.id)) throw new Error(`Duplicate planned check ID: ${check.id}`);
    checks.push({ required: true, area: areas[0], ...check });
  }

  function addRunner(runner, reason, scenarioSupport = [], expected) {
    if (!runner || typeof runner.id !== 'string' || !runner.id) throw new Error('Each trusted runner must have an ID');
    const existing = selectedRunners.get(runner.id);
    if (existing) {
      existing.reason = uniq([existing.reason, reason]).join(' ');
      existing.support = uniq([...existing.support, ...scenarioSupport]);
      if (expected && !existing.expected.includes(expected)) existing.expected += ` ${expected}`;
      return;
    }
    const related = runner.baseline ? tests : relevant;
    const check = { id: `runner-${slug(runner.id)}`, method: 'automated', runner: runner.id,
      required: runner.required !== false, reason, expected: expected || runner.expected || 'The configured suite completes with every required assertion passing.',
      area: runner.area || areas[0], kind: runner.baseline ? 'baseline' : 'regression',
      support: uniq([...support, ...scenarioSupport, ...related.map((test) => test.path)]) };
    addCheck(check);
    selectedRunners.set(runner.id, checks[checks.length - 1]);
  }

  for (const runner of runners) {
    if (runner.baseline || applies(runner)) addRunner(runner,
      runner.baseline ? 'Essential baseline suite is required for every revision.' : 'Changed paths, diff content, or requirements select this configured regression suite.');
  }
  if (!runners.some((runner) => runner.baseline && runner.required !== false)) {
    const message = 'No required baseline runner is configured.';
    gaps.push(message);
    addCheck({ id: 'baseline-unconfigured', method: 'unsupported', kind: 'baseline', reason: message,
      expected: 'A trusted baseline suite runs successfully at the exact PR revision.', support: ['qa-config.json'] });
  }

  for (const rule of selectedRules) {
    for (const scenario of rule.checks || rule.scenarios || []) {
      if (scenario.match && !matches(scenario.match, paths)) continue;
      const id = `${slug(rule.id || rule.label)}-${slug(scenario.id)}`;
      const scenarioSupport = uniq([...paths.filter((path) => matches(rule.match, [path])),
        ...(scenario.requirement ? [scenario.requirement] : []), ...specs.map((spec) => spec.path), ...(pr.body ? ['PR description'] : [])]);
      const runner = scenario.runner && runners.find((candidate) => candidate.id === scenario.runner);
      const needsQuestion = scenario.method === 'human' || Boolean(scenario.question) ||
        (scenario.requiresRequirement && !scenario.expected && !scenario.requirement);
      if (needsQuestion) {
        addCheck({ id, method: 'human', kind: scenario.kind || 'requirement', area: rule.label || rule.id,
          reason: scenario.reason || 'The expected behavior needs a specific human decision.',
          expected: scenario.expected || 'An authorized responder states and validates the intended behavior.',
          question: scenario.question || `What is the intended result for ${scenario.id} in ${rule.label || rule.id}? State the acceptance criteria and evidence.`,
          support: scenarioSupport });
      } else if (runner) {
        addRunner(runner, scenario.reason || `Regression scenario: ${scenario.id}.`, scenarioSupport, scenario.expected);
      } else {
        const reason = scenario.reason || `Verify ${scenario.id} in ${rule.label || rule.id}.`;
        gaps.push(`No configured runner for ${id}.`);
        addCheck({ id, method: 'unsupported', kind: scenario.kind || 'regression', area: rule.label || rule.id,
          reason, expected: scenario.expected || 'Define the intended assertion and configure an executable check.', support: scenarioSupport });
      }
    }
  }

  const requirementSources = [{ path: 'PR description', content: pr.body || '' }, ...specs];
  // Opt-in declarations make conflicts machine-detectable without interpreting prose.
  // Example: QA-EXPECT guest.status: 403
  const declaredExpectations = new Map();
  for (const source of requirementSources) {
    for (const line of (source.content || '').split('\n')) {
      const declaration = line.match(/^\s*(?:[-*]\s*)?QA-EXPECT\s+([a-zA-Z0-9_.-]+)\s*:\s*(.+)\s*$/);
      if (!declaration) continue;
      const key = declaration[1].toLowerCase();
      const values = declaredExpectations.get(key) || [];
      values.push({ value: declaration[2].trim(), source: source.path });
      declaredExpectations.set(key, values);
    }
  }
  for (const [key, declarations] of declaredExpectations) {
    if (new Set(declarations.map((entry) => entry.value.toLowerCase().replace(/\s+/g, ' '))).size < 2) continue;
    addCheck({ id: `requirement-conflict-${slug(key)}`, method: 'human', kind: 'requirement',
      reason: `Requirement ${key} has conflicting declared expected results.`,
      expected: 'An authorized owner chooses the intended expectation and validates it against this revision.',
      question: `Which expected result governs ${key}: ${declarations.map((entry) => `${entry.value} (${entry.source})`).join(' versus ')}? Explain the governing requirement and verification evidence.`,
      support: uniq(declarations.map((entry) => entry.source)) });
  }
  const ambiguities = requirementSources.flatMap((source) => (source.content || '').split('\n')
    .filter((line) => /\b(TBD|TBC|unclear|not specified|to be decided|open question)\b/i.test(line))
    .map((line) => ({ source: source.path, text: line.trim().slice(0, 400) })));
  if (ambiguities.length) addCheck({ id: 'requirements-clarification', method: 'human', kind: 'requirement',
    reason: 'The supplied requirements explicitly leave behavior unresolved.',
    expected: 'An authorized owner supplies the intended result and validates it against the revision.',
    question: `Resolve these acceptance criteria: ${ambiguities.map((item) => `${item.source}: ${item.text}`).join('; ')}`,
    support: uniq(ambiguities.map((item) => item.source)) });

  const behaviorFiles = files.filter((file) => !/\.(md|txt|png|jpe?g|gif|svg|ico|lock)$/i.test(file.filename));
  const configuredExpectations = selectedRules.some((rule) => (rule.checks || rule.scenarios || []).some((check) => check.expected || check.requirement));
  if (behaviorFiles.length && !pr.body?.trim() && !specs.some((spec) => spec.content?.trim()) && !configuredExpectations) {
    gaps.push('No description, specification, or feature expectation states the intended behavior.');
    addCheck({ id: 'implementation-intent', method: 'human', kind: 'implementation', reason: gaps[gaps.length - 1],
      expected: 'The implementation intent and its acceptance criteria are provided and verified.',
      question: `What observable behavior should change in ${behaviorFiles.map((file) => file.filename).join(', ')}? Provide the intended result and evidence for this revision.`, support: paths });
  }

  for (const finding of findings.filter((item) => item.severity === 'review')) {
    addCheck({ id: finding.id, method: 'human', kind: 'interpretation', reason: finding.message,
      expected: 'An authorized reviewer validates how dynamic execution inputs are constrained.',
      question: `For ${finding.file}, which inputs reach the added dynamic execution, and what evidence establishes their allowed values?`, support: [finding.file] });
  }

  if (behaviorFiles.length && !relevant.length) gaps.push('No existing test was associated with changed code by path or content; the baseline alone does not establish feature coverage.');
  if (!selectedRules.length && behaviorFiles.length) gaps.push('No feature rule matched; only configured baseline and path-selected suites are planned.');
  const limitations = (pr.inspectionLimitations || []).map((item) => typeof item === 'string' ? item : JSON.stringify(item));
  if (limitations.length) {
    gaps.push(...limitations);
    addCheck({ id: 'inspection-incomplete', method: 'unsupported', kind: 'inspection',
      reason: 'PR inspection was incomplete; affected checks cannot be established reliably.',
      expected: 'All changed files, relevant diff content, test inventory, and configured requirements are available.', support: limitations });
  }

  const plan = { fingerprint: fingerprint(pr, rules, config), areas, journeys, checks, findings, gaps: uniq(gaps) };
  plan.markdown = renderMarkdown(pr, plan);
  return plan;
}

function renderMarkdown(pr, plan) {
  const bullets = (values) => values.length ? values.map((value) => `- ${value}`).join('\n') : '- None identified.';
  return [`# QA plan for PR #${pr.number}`, '', `Revision: \`${pr.revision || 'unavailable'}\``, '',
    '## Affected areas and journeys', bullets(plan.areas), bullets(plan.journeys), '',
    '## Checks', ...plan.checks.map((check) => [`### ${check.id} (${check.method}${check.required ? ', required' : ''})`,
      `Reason: ${check.reason}`, `Expected: ${check.expected}`, `Support: ${check.support.join(', ') || 'configuration'}`,
      check.runner ? `Runner: ${check.runner}` : '', check.question ? `Question: ${check.question}` : '', ''].filter(Boolean).join('\n')), '',
    '## Static observations', bullets(plan.findings.map((finding) => `${finding.file}: ${finding.message} (heuristic)`)), '',
    '## Gaps and limitations', bullets(plan.gaps), '',
    'Code changes guide selection; intended assertions must come from requirements or trusted test configuration.', ''].join('\n');
}

module.exports = { generatePlan, matchedRules, fingerprint };
