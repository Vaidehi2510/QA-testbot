// The model proposes evidence and checks. Only this trusted adapter can extend a
// plan; it cannot remove baseline tests or supply executable runner commands.
const crypto = require('node:crypto');
const { runTeam } = require('./team');
const { deriveOutcome } = require('../core');
const { validateAIConfig } = require('./settings');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();

function addReviewGate(plan, config, revision) {
  if (!config.ai?.enabled) return plan;
  if (!plan.checks.some(check => check.id === 'ai-team-review')) plan.checks.push({
    id: 'ai-team-review', method: 'analysis', required: config.ai.requireReview !== false,
    area: 'AI QA team', revision, analysisStatus: 'blocked',
    reason: 'Configured AI planning and final review must finish; AI findings are separate from test evidence.',
    expected: 'Configured reviewers finish at this revision, with cited findings and explicit coverage limitations.',
    support: ['qa-config.json:ai'],
  });
  return plan;
}

function addHumanCheck(run, check) {
  if (run.plan.checks.some(existing => existing.id === check.id)) return;
  run.plan.checks.push(check);
  run.requests.push({ checkId: check.id, revision: run.revision, status: 'open', createdAt: now(), source: 'ai' });
}

function applyAssessment(run, assessment, config, stage) {
  // Even injected adapters must not move a different revision's findings here.
  if (assessment.revision !== run.revision || assessment.stage !== stage) throw new Error('AI assessment identity mismatch');
  for (const id of assessment.selectedRunnerIds || []) {
    if (stage !== 'planning') continue; // The immutable request has already run.
    const runner = (config.runners || []).find(item => item.id === id);
    if (!runner) throw new Error('AI selected a runner outside trusted configuration');
    if (run.plan.checks.some(check => check.method === 'automated' && check.runner === id)) continue;
    run.plan.checks.push({ id: `ai-runner-${hash(id).slice(0, 12)}`, method: 'automated', required: true, runner: id,
      area: runner.area || 'AI-selected regression', reason: 'The AI planner selected this existing, trusted regression suite from code evidence.',
      expected: runner.expected || 'All configured assertions execute and pass.', support: ['qa-config.json:runners', ...run.plan.areas] });
  }
  for (const question of (assessment.questions || []).slice(0, 12)) {
    const id = `ai-question-${hash([question.question, question.area]).slice(0, 16)}`;
    addHumanCheck(run, { id, method: 'human', required: true, source: 'ai', kind: ['implementation', 'requirement', 'subjective', 'access'].includes(question.kind) ? question.kind : 'interpretation',
      area: question.area || 'AI QA team', reason: question.reason || 'The model identified an unresolved intended behavior.',
      question: question.question, expected: 'An authorized person resolves the question with revision-specific evidence.',
      support: question.evidence?.map(item => item.file || item.checkId).filter(Boolean) || ['AI review'] });
  }
  for (const finding of (assessment.findings || []).filter(item => ['critical', 'high'].includes(item.severity)).slice(0, 12)) {
    const id = `ai-finding-${hash([finding.file, finding.title, finding.description]).slice(0, 16)}`;
    addHumanCheck(run, { id, method: 'human', required: true, source: 'ai', kind: 'interpretation',
      area: finding.area || run.plan.areas[0] || 'AI QA team',
      reason: `AI ${finding.severity} finding needs verification: ${finding.title}`,
      question: `Validate or reject this finding against the code and requirements: ${finding.description} Suggested fix: ${finding.suggestedFix || 'See the report.'} Cite your evidence; an AI suggestion is not a confirmed defect.`,
      expected: 'An authorized reviewer determines whether the finding is addressed or a documented false positive.',
      support: [finding.file, ...(finding.evidence || []).map(item => item.file || item.checkId)].filter(Boolean) });
  }
  const remainingQuestions = (assessment.questions || []).slice(12);
  const remainingFindings = (assessment.findings || []).filter(item => ['critical', 'high'].includes(item.severity)).slice(12);
  if (remainingQuestions.length || remainingFindings.length) {
    const id = `ai-overflow-${hash([remainingQuestions, remainingFindings]).slice(0, 16)}`;
    const remaining = `${remainingQuestions.length} additional unresolved question(s) and ${remainingFindings.length} additional high/critical finding(s)`;
    addHumanCheck(run, { id, method: 'human', required: true, source: 'ai', kind: 'interpretation', area: 'AI QA team',
      reason: `The individual request limit was reached; ${remaining} still require review.`,
      question: `Review ${remaining} in the full ${stage} AI report, beyond the first 12 questions and first 12 high/critical findings. Resolve every remaining question and validate or reject every remaining finding. Cite the affected items and revision-specific evidence in your decision.`,
      expected: 'An authorized reviewer accounts for every overflow item; the request limit does not waive unresolved QA work.',
      support: [...new Set(remainingFindings.map(finding => finding.file).filter(Boolean)), 'Full AI review report'] });
  }
  const gate = run.plan.checks.find(check => check.id === 'ai-team-review');
  if (gate) {
    const planning = run.ai?.planning;
    const completion = run.ai?.completion;
    const failed = [planning, completion].some(value => value && !['completed', 'preview', 'running'].includes(value.status));
    gate.analysisStatus = failed ? 'execution_error' : planning?.status === 'completed' && completion?.status === 'completed' ? 'passed' : 'blocked';
  }
  run.outcome = deriveOutcome(run.plan, run.results, run.decisions, run.revision);
  run.report.status = 'pending';
  run.plan.baseMarkdown ||= run.plan.markdown;
  const additions = run.plan.checks.filter(check => check.source === 'ai' || check.id.startsWith('ai-runner-'));
  run.plan.markdown = `${run.plan.baseMarkdown}\n\n## AI-selected checks and decisions\n${additions.map(check =>
    `- ${check.id} (${check.method}): ${check.reason}\n  Expected: ${check.expected}${check.question ? `\n  Question: ${check.question}` : ''}`).join('\n')}\n\n${renderAIReview(run.ai)}`.slice(0, 55000);
}

async function reviewStage({ run, pr, config, client, stage, save = async () => {}, dryRun = false, team = runTeam }) {
  if (!config.ai?.enabled) return null;
  const ai = validateAIConfig(config.ai);
  run.ai ||= {};
  addReviewGate(run.plan, config, run.revision);
  const analysisKey = stage === 'planning' ? `planning:${run.plan.fingerprint}` : `completion:${hash([run.completionEvent, run.results])}`;
  const existing = run.ai[stage];
  if (existing?.analysisKey === analysisKey && existing.status !== 'running') {
    if (!existing.applied && !dryRun) { applyAssessment(run, existing, config, stage); existing.applied = true; await save(); }
    return existing;
  }
  if (dryRun) return { status: 'preview', stage, revision: run.revision, analysisKey };
  // Persist a pending reservation before handing context to any provider.
  // A crashed role is resumed from its checkpoint with previously reserved cost.
  const prior = existing?.analysisKey === analysisKey ? existing : run.ai.latest;
  const assessment = await team({ pr, plan: run.plan, config: ai, client, stage, analysisKey,
    results: run.results, prior, trustedRunners: config.runners || [],
    onCheckpoint: async checkpoint => {
      run.ai[stage] = { ...checkpoint, analysisKey }; run.ai.latest = run.ai[stage]; await save();
    } });
  run.ai[stage] = { ...assessment, analysisKey };
  run.ai.latest = run.ai[stage];
  applyAssessment(run, run.ai[stage], config, stage);
  run.ai[stage].applied = true;
  await save();
  return run.ai[stage];
}

function renderAIReview(ai = {}) {
  const escape = value => String(value ?? '').replace(/[<>]/g, ch => ch === '<' ? '&lt;' : '&gt;').replace(/\r/g, '');
  const lines = ['## AI QA team', '', 'Model findings are proposals requiring evidence; actual test results determine automated outcomes.', ''];
  for (const stage of ['planning', 'completion']) {
    const review = ai[stage];
    if (!review) continue;
    lines.push(`### ${stage === 'planning' ? 'Code inspection and test planning' : 'Final review and failure investigation'}`, '',
      `Status: ${escape(review.status)} · revision: ${escape(review.revision)}`, `${review.costIsEstimate ? 'Estimated cost' : 'Cost reported'}: ${review.cost == null ? 'unavailable' : escape(review.cost)} USD`, '');
    for (const role of review.roles || []) lines.push(`- ${escape(role.role)} · ${escape(role.model)} · ${escape(role.status)}: ${escape(role.summary || '')}`);
    lines.push('', '#### Findings and suggested fixes', '');
    for (const finding of review.findings || []) lines.push(`- **${escape(finding.severity)} — ${escape(finding.title)}** (${escape(finding.file || '')})`,
      `  ${escape(finding.description)}`, `  Suggested fix: ${escape(finding.suggestedFix || 'Not supplied')}`,
      `  Evidence: ${escape(JSON.stringify(finding.evidence || []))}`);
    if (!review.findings?.length) lines.push('- No validated model findings recorded. This does not prove absence of defects.');
    lines.push('', '#### Unresolved questions', '');
    for (const question of review.questions || []) lines.push(`- ${escape(question.area || 'AI QA team')}: ${escape(question.question)}`,
      `  Reason: ${escape(question.reason || 'The intended behavior requires clarification.')}`);
    if (!review.questions?.length) lines.push('- None proposed.');
    lines.push('', '#### Candidate tests — assertions require validation', '');
    for (const candidate of review.candidates || []) {
      const source = String(candidate.source ?? '');
      const fence = '`'.repeat(Math.max(3, ...(source.match(/`+/g) || []).map(value => value.length + 1)));
      lines.push(`- ${escape(candidate.title || candidate.id)} · ${escape(candidate.filename)}: ${escape(candidate.assertion)}`,
        `  Requirement: ${escape(typeof candidate.requirement === 'object' ? JSON.stringify(candidate.requirement) : candidate.requirement)}`,
        '  Candidate source (not executed or installed):', '', `${fence}text`, source, fence, '');
    }
    if (!review.candidates?.length) lines.push('- None proposed.');
    lines.push('', '#### Review limits', '', ...(review.limitations || []).map(item => `- ${escape(item)}`), '');
  }
  return lines.join('\n');
}

module.exports = { addReviewGate, applyAssessment, reviewStage, renderAIReview };
