const fs = require('node:fs/promises');
const path = require('node:path');
const { validateTarget } = require('../assessment');
const { deriveOutcome } = require('../core');
const { validateAIConfig } = require('../ai/settings');
const { localSnapshot } = require('../ai/snapshot');
const { redact } = require('../ai/context');
const { hash } = require('../autonomy/schema');
const { AutonomyStore, outsideProduct, readJson, writeJson, ownedPath } = require('../autonomy/store');
const { validCounts } = require('../autonomy/run');
const { inspectArtifact, runnerPolicyHash, externalInputFingerprint } = require('./artifact');
const now = () => new Date().toISOString();
const clean = value => redact(String(value || '')).slice(0, 1200);
const one = { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 };

function gateDecision(run, { repository, revision, target, maxAgeMs = 3600000, nowMs = Date.now() }) {
  const reasons = [];
  if (!run || run.repository !== repository || run.revision !== revision || JSON.stringify(run.target) !== JSON.stringify(validateTarget(target))) reasons.push('Assessment does not match the exact repository, source revision, artifact and version.');
  if (run?.phase !== 'completed' || !Number.isFinite(Date.parse(run.completedAt)) || nowMs < Date.parse(run.completedAt) - 10000 || nowMs - Date.parse(run.completedAt) > maxAgeMs) reasons.push('Release evidence is incomplete, in the future or expired.');
  const checks = run?.plan?.checks;
  if (!Array.isArray(checks) || !checks.length || new Set(checks.map(c => c.id)).size !== checks.length) reasons.push('Missing or conflicting release check plan.');
  else {
    if (!checks.some(c => c.required !== false && c.method === 'automated' && !c.id.startsWith('release-'))) reasons.push('No required product tests establish release readiness.');
    for (const id of ['release-artifact', 'release-platform', 'release-artifact-stability', 'release-input-stability']) if (!checks.some(c => c.id === id && c.required !== false)) reasons.push(`Missing required gate: ${id}`);
    for (const check of checks.filter(c => c.required !== false && c.method === 'automated')) {
      const matches = (run.results || []).filter(r => r.checkId === check.id);
      if (matches.length !== 1 || matches[0].revision !== revision || matches[0].status !== 'passed' || !validCounts(matches[0])) reasons.push(`Required check lacks a complete passing execution: ${check.id}`);
    }
    if (deriveOutcome(run.plan, run.results, [], revision).status !== 'passed') reasons.push('One or more required checks failed, were skipped, are unsupported or require human review.');
  }
  if (run?.ai?.latest?.findings?.some(f => ['high', 'critical'].includes(f.severity))) reasons.push('High-severity findings require review.');
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], expiresAt: Number.isFinite(Date.parse(run?.completedAt)) ? new Date(Date.parse(run.completedAt) + maxAgeMs).toISOString() : null };
}

async function runRelease({ options = {}, env = process.env, baselineRunner, autonomousRunner, team, client, log = console.log } = {}) {
  if (!options.repo || !options.manifest || !options.target || !options.repository) throw new Error('Release QA requires a repository checkout, repository name, target and trusted build manifest');
  if (options.pr !== undefined) throw new Error('Build/release QA must not invent a PR number');
  const target = validateTarget(typeof options.target === 'string' ? JSON.parse(options.target) : options.target);
  const repo = await fs.realpath(path.resolve(options.repo));
  const configPath = await outsideProduct(path.resolve(options.config || path.join(__dirname, '../../qa-config.json')), repo);
  const manifestPath = await outsideProduct(path.resolve(options.manifest), repo);
  const output = await outsideProduct(path.resolve(options['output-dir'] || path.join(__dirname, '../../.qa-local/releases')), repo);
  const config = await readJson(configPath); config.ai = validateAIConfig(config.ai || {});
  if (options['budget-usd'] !== undefined) { const value = Number(options['budget-usd']); if (!Number.isFinite(value) || value < 0 || value > config.ai.maxCostUsd) throw new Error('A release budget can only reduce the locally enrolled budget'); config.ai.maxCostUsd = value; }
  const snapshot = await localSnapshot({ repositoryPath: repo, base: options.base || 'main', head: options.head || 'HEAD', repository: options.repository, number: null, title: `${target.kind} ${target.name}`, config });
  delete snapshot.number; snapshot.target = target;
  const metadata = { repository: snapshot.repository, revision: snapshot.revision, target };
  const runners = (config.runners || []).filter(r => r.baseline);
  if (runners.length > 60 || new Set(runners.map(r => r.id)).size !== runners.length) throw new Error('Release baseline runners need distinct IDs and a bounded plan');
  const expected = runners.map(r => ({ id: `runner-${r.id}`, runner: r.id, name: r.expected || r.id, method: 'automated', required: true }));
  let artifact, artifactError;
  try { artifact = await inspectArtifact({ manifestPath, target, repo, ...metadata }); } catch (error) { artifactError = clean(error.message); }
  let inputHash;
  try { inputHash = await externalInputFingerprint(config, repo); } catch (error) { inputHash = `unavailable:${clean(error.message)}`; }
  const suiteInput = options.suite ? await readJson(await outsideProduct(options.suite, repo)) : null, goalsInput = options.goals ? await readJson(await outsideProduct(options.goals, repo)) : null;
  const key = hash({ metadata, base: snapshot.baseRevision, config, inputHash, manifestHash: artifact?.manifestHash || artifactError, suite: suiteInput, goals: goalsInput, rerunToken: options['rerun-token'] || '' });
  if (options.dryRun || env.DRY_RUN === 'true') return { key, status: 'preview', ...metadata, artifactVerified: Boolean(artifact), artifactError, baselineChecks: expected, limitations: ['No tests, model calls, device sessions or product writes were performed.'] };
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const store = new AutonomyStore(output);
  return store.withLock(async (state, persist) => {
    let run = state.runs[key];
    if (run?.phase === 'completed') return run;
    const directory = await ownedPath(output, `runs/${key}`, { directory: true });
    if (!run) run = state.runs[key] = { key, ...metadata, createdAt: now(), phase: 'running', plan: { fingerprint: key, checks: [] }, results: [], decisions: [], ai: { latest: {} }, release: { manifestHash: artifact?.manifestHash || null, configHash: hash(config), runnerPolicyHash: runnerPolicyHash(config), inputHash, suiteHash: suiteInput ? hash(suiteInput) : null, goalsHash: goalsInput ? hash(goalsInput) : null }, limitations: ['QA is limited to configured and executed checks. This is not exhaustive product certification.', 'Build manifests and imported CI attestations are trusted operator inputs, not independently verified remote builder identities.', ...snapshot.aiLimitations, ...snapshot.inspectionLimitations] };
    const save = () => persist(state);
    const record = (id, name, status, details, counts) => {
      if (!run.plan.checks.some(c => c.id === id)) run.plan.checks.push({ id, name, method: 'automated', required: true });
      run.results = run.results.filter(r => r.checkId !== id);
      run.results.push({ checkId: id, revision: metadata.revision, status, details: clean(details), ...(counts ? { counts } : {}) });
    };
    record('release-artifact', 'Exact build artifact and source provenance', artifact ? 'passed' : 'blocked', artifact ? 'Artifact bytes, source revision, requested version/build and platform match the enrolled builder manifest.' : artifactError, artifact ? one : undefined);
    await save();
    if (artifact) {
      if (!expected.length) record('release-baseline', 'Configured product tests', 'blocked', 'No baseline product test suites are enrolled for this release.');
      if (target.platform === 'web') {
        if (!options.suite || !options.goals) record('release-browser', 'Full-version browser journeys', 'blocked', 'Enroll a preview suite and explicit trusted user goals for this build/release.');
        else {
          try {
            const child = await (autonomousRunner || require('../autonomy/run').runAutonomous)({ options: { ...options, target, base: snapshot.baseRevision, head: metadata.revision, config: configPath, 'output-dir': path.join(directory, 'autonomy'), executeBaseline: true }, env, client, ...(team ? { team } : {}), ...(baselineRunner ? { baselineRunner } : {}), log });
            for (const check of child.plan.checks) { if (run.plan.checks.some(c => c.id === check.id)) throw new Error('Release check IDs collide'); run.plan.checks.push(check); }
            run.results.push(...child.results); run.ai = child.ai; run.limitations.push(...child.limitations);
            const discovery = child.results.find(r => r.checkId === 'autonomy-discovery');
            record('release-platform', 'Web platform execution coverage', discovery?.status === 'passed' ? 'passed' : 'blocked', 'Browser coverage is established by exact-version preview journeys, not by a platform label.', discovery?.status === 'passed' ? one : undefined);
          } catch (error) { record('release-browser', 'Full-version browser journeys', 'execution_error', error.message); }
        }
      } else {
        for (const check of expected) if (!run.plan.checks.some(c => c.id === check.id)) run.plan.checks.push(check);
        if (!expected.length) record('release-baseline', 'Configured product tests', 'blocked', 'No baseline test suites are enrolled for this product.');
        if (!run.release.baselineCompleted) {
          if (run.release.baselineStarted) for (const check of expected) record(check.id, check.name, 'execution_error', 'Execution was interrupted. Investigate and request a new run; no automatic retry can create a pass.');
          else {
            run.release.baselineStarted = true; await save();
            try {
              const evidence = await (baselineRunner || require('../autonomy/baseline').executeBaseline)({ repo, ...metadata, runId: key, config, outputDir: path.join(directory, 'baseline'), checks: expected, env });
              for (const check of expected) {
                const matches = (Array.isArray(evidence) ? evidence : evidence.results || []).filter(r => r.checkId === check.id);
                const result = matches[0];
                const valid = matches.length === 1 && (!result.revision || result.revision === metadata.revision) && ['passed', 'failed', 'blocked', 'skipped', 'execution_error'].includes(result.status) && (result.status !== 'passed' || validCounts(result));
                record(check.id, check.name, valid ? result.status : 'blocked', valid ? result.details : 'Missing, conflicting, stale or incomplete baseline evidence.', valid ? result.counts : undefined);
              }
              run.limitations.push(...(evidence.limitations || []));
            } catch (error) { for (const check of expected) record(check.id, check.name, 'execution_error', error.message); }
          }
          run.release.baselineCompleted = true; await save();
        }
        const nativePlatform = r => ({ Android: 'android', iOS: 'ios', mac: 'macos' })[r.suite?.capabilities?.platformName];
        const covered = runners.filter(r => r.type === 'native-app' ? nativePlatform(r) === target.platform : r.type === 'junit-report' ? r.platforms?.includes(target.platform) : target.platform === 'api' && r.coverage?.includes('api'));
        const passing = covered.some(r => run.results.some(result => result.checkId === `runner-${r.id}` && result.status === 'passed' && validCounts(result)));
        record('release-platform', `${target.platform} platform execution coverage`, passing ? 'passed' : 'blocked', passing ? 'The enrolled platform suite completed with positive passing test counts. Imported reports remain explicitly labeled.' : 'No passing enrolled native/platform suite or exact-artifact CI report establishes this platform. Generic unit tests alone cannot approve platform compatibility.', passing ? one : undefined);
        if (config.ai.enabled && !run.release.reviewCompleted) {
          const id = 'release-specialists';
          const check = { id, name: 'AI specialists review final source and test evidence', method: 'analysis', required: true, revision: metadata.revision };
          run.plan.checks = run.plan.checks.filter(c => c.id !== id); run.plan.checks.push(check);
          try {
            const review = team || require('../ai/team').runTeam;
            const aiClient = client || require('../ai/client').createAIClient({ ai: config.ai, env, maxRetries: 0 });
            const planningRoles = config.ai.roles.filter(r => r !== 'triage');
            const prior = planningRoles.length ? await review({ pr: snapshot, plan: run.plan, config: { ...config.ai, roles: planningRoles }, client: aiClient, stage: 'planning', results: run.results, prior: run.ai.latest, analysisKey: `release:${key}`, trustedRunners: config.runners || [], onCheckpoint: async value => { run.ai.latest = value; await save(); } }) : run.ai.latest;
            run.ai.latest = prior;
            if (config.ai.roles.includes('triage')) {
              const merge = value => ({ ...value, findings: [...(prior.findings || []), ...(value.findings || [])], candidates: [...(prior.candidates || []), ...(value.candidates || [])], questions: [...(prior.questions || []), ...(value.questions || [])], roles: [...(prior.roles || []), ...(value.roles || [])], status: value.status === 'completed' && (!planningRoles.length || prior.status === 'completed') ? 'completed' : 'partial' });
              const triage = await review({ pr: snapshot, plan: run.plan, config: { ...config.ai, roles: ['triage'] }, client: aiClient, stage: 'completion', results: run.results, prior, analysisKey: `release-triage:${key}`, trustedRunners: config.runners || [], onCheckpoint: async value => { run.ai.latest = merge(value); await save(); } });
              run.ai.latest = merge(triage);
            }
            check.analysisStatus = run.ai.latest.status === 'completed' ? 'passed' : 'execution_error';
          } catch (error) { check.analysisStatus = 'execution_error'; run.limitations.push(clean(error.message)); }
          run.release.reviewCompleted = true; await save();
        }
        for (const [i, finding] of (run.ai.latest.findings || []).entries()) if (['critical', 'high'].includes(finding.severity)) run.plan.checks.push({ id: `release-finding-${i}`, name: clean(finding.title), method: 'human', required: true });
        for (const [i, question] of (run.ai.latest.questions || []).entries()) run.plan.checks.push({ id: `release-question-${i}`, name: clean(question.question), method: 'human', required: true });
      }
      try { if (await externalInputFingerprint(config, repo) !== inputHash) throw new Error('Imported CI report or approved test input changed during QA'); record('release-input-stability', 'Test input identity remains unchanged', 'passed', 'Configured external test evidence remained identical during this assessment.', one); } catch (error) { record('release-input-stability', 'Test input identity remains unchanged', 'blocked', error.message); }
      try { const final = await inspectArtifact({ manifestPath, target, repo, ...metadata }); if (final.manifestHash !== artifact.manifestHash) throw new Error('Builder manifest changed during testing'); record('release-artifact-stability', 'Build artifact remains unchanged after QA', 'passed', 'The same artifact and manifest remain present after the checks.', one); }
      catch (error) { record('release-artifact-stability', 'Build artifact remains unchanged after QA', 'blocked', error.message); }
    }
    if (!run.plan.checks.some(c => c.id === 'release-platform')) record('release-platform', 'Required platform evidence', 'blocked', 'Platform execution coverage is unavailable.');
    if (!run.plan.checks.some(c => c.id === 'release-artifact-stability')) record('release-artifact-stability', 'Artifact stability after QA', 'blocked', 'Artifact identity was not established.');
    if (!run.plan.checks.some(c => c.id === 'release-input-stability')) record('release-input-stability', 'Test input identity remains unchanged', 'blocked', 'Assessment inputs were not fully established.');
    const ai = run.ai.latest; ai.backend = config.ai.backend; ai.model = config.ai.model; ai.costUsd = ai.cost ?? null; ai.calls = ai.budget?.calls || 0;
    run.limitations = [...new Set(run.limitations.map(clean))]; run.outcome = deriveOutcome(run.plan, run.results, [], metadata.revision);
    run.phase = 'completed'; run.completedAt = now(); run.release.gate = gateDecision(run, metadata);
    run.report = { path: path.join(directory, 'report.json') };
    await writeJson(directory, 'report.json', run); await save();
    return run;
  });
}
module.exports = { runRelease, gateDecision };
