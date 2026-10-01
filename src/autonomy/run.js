// Autonomous browser tests are data, grounded in operator-owned assertions.
// Target code is read from immutable Git objects and is never rewritten here.
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateAIConfig } = require('../ai/settings');
const { createAIClient } = require('../ai/client');
const { localSnapshot, readScreenshots } = require('../ai/snapshot');
const { redact } = require('../ai/context');
const { runTeam } = require('../ai/team');
const { validateWebSuite } = require('../web/audit');
const { executeWebCheck } = require('../web/execute');
const { approveRepairs } = require('../web/maintenance');
const { deriveOutcome } = require('../core');
const { hash, validateGoals, inventoryTargets, validateRetainedJourney } = require('./schema');
const { AutonomyStore, outsideProduct, readJson, ownedPath, writeJson } = require('./store');
const { proposeJourneys } = require('./model');
const now = () => new Date().toISOString();
const clean = value => redact(String(value || '')).slice(0, 2000);
const sanitize = value => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(sanitize)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)])) : value;

function validCounts(result) {
  const { tests, passed, failed, skipped, cancelled = 0 } = result?.counts || {};
  return [tests, passed, failed, skipped, cancelled].every(value => Number.isSafeInteger(value) && value >= 0)
    && tests > 0 && tests === passed + failed + skipped + cancelled
    && (result.status !== 'passed' || tests === passed && failed + skipped + cancelled === 0);
}
function verifiedEvidence(evidence, metadata, checkId, suite) {
  if (!evidence || evidence.repository !== metadata.repository || evidence.revision !== metadata.revision || evidence.prNumber !== metadata.prNumber
    || evidence.checkId !== checkId || evidence.result?.checkId !== checkId) throw new Error('Browser evidence identity mismatch');
  if (!['passed', 'failed', 'blocked', 'execution_error', 'skipped'].includes(evidence.result.status)) throw new Error('Invalid browser evidence status');
  if (evidence.result.status === 'passed' && (evidence.revisionVerified !== true || typeof evidence.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(evidence.runId) || !evidence.suiteDigest || !validCounts(evidence.result))) throw new Error('A browser pass requires positive complete counts, verified deployment identity, and a unique execution record');
  if (evidence.result.status === 'passed' && suite && evidence.suiteDigest !== hash(validateWebSuite(suite, metadata))) throw new Error('Browser evidence does not attest the requested suite');
  return evidence;
}
function assessment(revision, ai) {
  return { backend: ai.backend, model: ai.model, stage: 'autonomy-generation', revision, status: 'pending', roles: [], findings: [], candidates: [], questions: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, costIsEstimate: false,
    budget: { calls: 0, reservedCostUsd: 0, reservedTokens: 0 }, limitations: [], transcript: [] };
}
function importedResults(envelope, metadata, checks) {
  if (envelope.schemaVersion !== 1 || envelope.repository !== metadata.repository || envelope.revision !== metadata.revision || envelope.prNumber !== metadata.prNumber || !Array.isArray(envelope.results)) throw new Error('Imported baseline results do not match this exact repository, PR, and revision');
  const seen = new Set();
  for (const result of envelope.results) {
    if (!checks.some(check => check.id === result?.checkId) || seen.has(result.checkId) || !['passed', 'failed', 'blocked', 'execution_error', 'skipped'].includes(result.status)
      || result.revision && result.revision !== metadata.revision || result.status === 'passed' && !validCounts(result)) throw new Error('Invalid or conflicting imported baseline result');
    seen.add(result.checkId);
  }
  return envelope.results;
}

async function runAutonomous({ options = {}, client, browserRunner = executeWebCheck, team = runTeam, baselineRunner, env = process.env, log = console.log } = {}) {
  if (!options.repo || !options.suite || !options.goals) throw new Error('Supply --repo, --suite, and --goals; the suite and goals must be in the bot workspace');
  const productRoot = await fs.realpath(path.resolve(options.repo));
  const root = path.resolve(__dirname, '../..');
  const configPath = await outsideProduct(options.config || path.join(root, 'qa-config.json'), productRoot);
  const suitePath = await outsideProduct(options.suite, productRoot);
  const goalsPath = await outsideProduct(options.goals, productRoot);
  const directory = await outsideProduct(options['output-dir'] || path.join(root, '.qa-local/autonomy'), productRoot);
  const config = await readJson(configPath), goals = validateGoals(await readJson(goalsPath));
  config.ai = validateAIConfig(config.ai || {});
  if (options['budget-usd'] !== undefined) {
    const budget = Number(options['budget-usd']);
    if (!Number.isFinite(budget) || budget < 0 || budget > config.ai.maxCostUsd) throw new Error('--budget-usd can only reduce the trusted model spending budget');
    config.ai.maxCostUsd = budget;
  }
  const dryRun = options.dryRun === true || env.DRY_RUN === 'true';
  if (!config.ai.enabled && !dryRun) throw new Error('Enable AI and choose its backend/model in trusted bot configuration before autonomous execution');
  const number = Number(options.pr || 1);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1e9) throw new Error('--pr must be a positive integer');
  if (options.repository && !/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new Error('--repository must be owner/name');
  if (options.product && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(options.product)) throw new Error('--product must be a short local identifier');
  if (options['rerun-token'] !== undefined && (typeof options['rerun-token'] !== 'string' || options['rerun-token'].length > 200)) throw new Error('Invalid rerun token');
  const pr = await localSnapshot({ repositoryPath: productRoot, base: options.base || 'main', head: options.head || 'HEAD', config,
    repository: options.repository, number, title: options.title });
  const metadata = { repository: pr.repository, revision: pr.revision, prNumber: number };
  const rawSuite = await readJson(suitePath);
  if (rawSuite.visual?.baselineDir) rawSuite.visual.baselineDir = await outsideProduct(rawSuite.visual.baselineDir, productRoot);
  // Only goal starts explicitly enrolled by the operator are added to discovery.
  rawSuite.pages = [...new Set([...(rawSuite.pages || ['/']), ...goals.goals.map(goal => goal.start)])];
  rawSuite.discovery = { enabled: true, maxPages: 8, ...(rawSuite.discovery || {}) };
  const suite = validateWebSuite(rawSuite, metadata);
  if (suite.discovery.enabled && suite.pages.length > suite.discovery.maxPages) throw new Error('Trusted page/goal starts exceed the discovery page budget');
  const baselineChecks = (config.runners || []).filter(runner => runner.baseline).map(runner => ({ id: `runner-${runner.id}`, name: runner.expected || runner.id,
    runner: runner.id, runnerId: runner.id, method: 'automated', required: true, expected: runner.expected || 'Trusted configured baseline tests pass.' }));
  if (new Set(baselineChecks.map(check => check.id)).size !== baselineChecks.length) throw new Error('Duplicate configured baseline runner IDs');
  const imported = options.results ? importedResults(await readJson(await outsideProduct(options.results, productRoot)), metadata, baselineChecks) : [];
  if (options.executeBaseline && options.results) throw new Error('Choose baseline execution or imported baseline evidence, not both');
  // Suite policy changes cannot silently reuse previously approved regressions.
  const policyKey = hash({ product: options.product || pr.repository, repository: pr.repository, suite: rawSuite });
  const key = hash({ policyKey, revision: pr.revision, base: pr.baseRevision, pr: number, goals, configHash: hash(config), baselineChecks,
    executeBaseline: Boolean(options.executeBaseline), imported, rerunToken: options['rerun-token'] || '' });
  if (dryRun) {
    const preview = { status: 'preview', key, repository: pr.repository, revision: pr.revision, pr: { number, title: pr.title },
      goals: goals.goals.map(goal => ({ id: goal.id, name: goal.name, assertions: goal.assertions.length })), baselineChecks,
      backend: config.ai.backend, model: config.ai.model, maxCostUsd: config.ai.maxCostUsd, outputDir: directory,
      limitations: ['Dry run only: no browser, model requests, baseline tests, saved state, or product writes.'] };
    log(JSON.stringify(preview)); return preview;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const store = new AutonomyStore(directory);
  return store.withLock(async (state, persist) => {
    state.autonomy ||= { regressions: {} };
    let run = state.runs[key];
    if (run?.phase === 'completed') { log(`Reusing completed autonomous run ${key.slice(0, 12)}.`); return run; }
    if (!run) {
      run = { key, repository: pr.repository, revision: pr.revision, pr: { number, title: clean(pr.title) }, createdAt: now(), phase: 'running',
        plan: { fingerprint: key, checks: [...baselineChecks] }, results: [], decisions: [], ai: { latest: assessment(pr.revision, config.ai) },
        autonomy: { policyKey, goalsHash: hash(goals), goals: [], browser: {}, candidates: null }, limitations: [
          'Coverage is limited to explicit trusted goals, bounded discovered states, configured browsers/viewports, and executed baseline tests; this is not exhaustive product verification.',
          'Generated steps never change product files. Preview mutations require explicit disposable-environment authorization. Expected assertions come from trusted operator requirements.',
          ...(config.ai.backend === 'local' ? ['Local inference has no tracked provider charge; hardware, hosting, and electricity costs are not measured.'] : []),
          ...pr.aiLimitations, ...pr.inspectionLimitations,
        ] };
      state.runs[key] = run;
    }
    const save = () => persist(state);
    const addCheck = (id, name, method = 'automated') => {
      let check = run.plan.checks.find(item => item.id === id);
      if (!check) { check = { id, name: clean(name), expected: clean(name), method, required: true, revision: pr.revision }; run.plan.checks.push(check); }
      return check;
    };
    const result = (checkId, status, details, extra = {}) => {
      const item = { ...sanitize(extra), checkId, status, details: clean(details), revision: pr.revision };
      const previous = run.results.findIndex(value => value.checkId === checkId);
      if (previous >= 0) run.results[previous] = item; else run.results.push(item);
      return item;
    };
    await save();
    const aiClient = client || createAIClient({ ai: config.ai, env, timeoutMs: config.ai.backend === 'local' ? 120000 : 30000, maxRetries: 0 });
    const runDirectory = await ownedPath(directory, `runs/${key}`, { directory: true });
    async function browser(checkId, currentSuite) {
      if (run.autonomy.browser[checkId]) return run.autonomy.browser[checkId];
      const outputDir = await ownedPath(runDirectory, `browser/${hash(checkId)}`, { directory: true });
      // A durable pending marker prevents an interrupted action from being retried
      // as a fresh apparent pass. Use a new rerun token after investigating it.
      const started = run.results.find(item => item.checkId === checkId);
      if (started) return null;
      result(checkId, 'execution_error', 'Browser execution started but has not produced complete evidence.', { interrupted: true }); await save();
      try {
        const evidence = sanitize(verifiedEvidence(await browserRunner({ suite: currentSuite, metadata, outputDir, checkId, env }), metadata, checkId, currentSuite));
        run.autonomy.browser[checkId] = evidence;
        result(checkId, evidence.result.status, evidence.result.details, { ...evidence.result, revision: pr.revision });
        run.limitations.push(...(evidence.limitations || []).map(clean));
        await save(); return evidence;
      } catch (error) {
        result(checkId, 'execution_error', error.message); await save(); return null;
      }
    }
    if (!run.autonomy.baselineCompleted) {
      if (run.autonomy.baselineStarted) {
        for (const check of baselineChecks) result(check.id, 'execution_error', 'Baseline execution was interrupted; it cannot be retried into a pass in the same attempt. Use a new rerun token.');
      } else if (options.executeBaseline && baselineChecks.length) {
        run.autonomy.baselineStarted = true; await save();
        try {
          const execute = baselineRunner || require('./baseline').executeBaseline;
          const executed = await execute({ repo: productRoot, ...metadata, runId: key, config, outputDir: await ownedPath(runDirectory, 'baseline', { directory: true }), checks: baselineChecks, env });
          const entries = Array.isArray(executed) ? executed : executed.results;
          const checked = importedResults({ schemaVersion: 1, ...metadata, results: entries }, metadata, baselineChecks);
          for (const check of baselineChecks) {
            const evidence = checked.find(value => value.checkId === check.id);
            if (evidence) result(check.id, evidence.status, evidence.details, evidence);
            else result(check.id, 'blocked', 'The configured baseline runner returned no result.');
          }
          run.limitations.push(...(executed.limitations || []));
        } catch (error) { for (const check of baselineChecks) result(check.id, 'execution_error', error.message); }
      } else {
        for (const check of baselineChecks) {
          const evidence = imported.find(value => value.checkId === check.id);
          if (evidence) result(check.id, evidence.status, evidence.details, evidence);
          else result(check.id, 'blocked', 'Configured baseline tests have not executed. Enable the enrolled isolated baseline runner or import exact-revision evidence.');
        }
        if (imported.length) run.limitations.push('Baseline evidence was imported from a trusted local file; remote workflow provenance was not independently verified.');
      }
      run.autonomy.baselineCompleted = true; await save();
    }
    addCheck('autonomy-discovery', 'Configured preview pages, discovered routes, layout, accessibility, and deployment identity');
    log(`Discovering verified preview states for ${pr.repository} at ${pr.revision.slice(0, 12)}.`);
    const discovered = await browser('autonomy-discovery', rawSuite);
    const inventory = inventoryTargets(discovered?.inventory, pr.revision, suite.origin);
    const retained = state.autonomy.regressions[policyKey] || {};
    const missing = goals.goals.filter(goal => retained[goal.id]?.goalHash !== hash(goal));
    if (!run.autonomy.candidates) {
      const generation = addCheck('autonomy-generation', 'Generate declarative tests grounded in trusted business assertions', 'analysis');
      if (!missing.length) {
        run.autonomy.candidates = []; generation.analysisStatus = 'passed';
        result(generation.id, 'passed', 'All goals already have retained regression journeys; no model generation was needed.');
      } else if (discovered?.revisionVerified !== true || !inventory.pages.length) {
        run.autonomy.candidates = []; generation.analysisStatus = 'execution_error';
        result(generation.id, 'blocked', 'No SHA-verified page inventory is available to ground generated interactions.');
      } else if (run.ai.latest.transcript.some(entry => entry.status === 'reserved')) {
        run.autonomy.candidates = []; generation.analysisStatus = 'execution_error'; run.ai.latest.status = 'error';
        result(generation.id, 'execution_error', 'A previous inference request was interrupted; its reserved budget is retained. Use a new rerun token after reviewing the interruption.');
      } else {
        try {
          run.autonomy.candidates = await proposeJourneys({ pr, ai: config.ai, goals: missing, inventory, client: aiClient, run, save });
          generation.analysisStatus = 'passed'; result(generation.id, 'passed', `${run.autonomy.candidates.length} goal-bound candidate journeys generated.`);
        } catch (error) {
          run.autonomy.candidates = []; generation.analysisStatus = 'execution_error'; result(generation.id, 'execution_error', error.message);
          run.limitations.push(clean(error.message));
        }
      }
      await save();
    }
    for (const goal of goals.goals) {
      if (run.autonomy.goals.some(value => value.goalId === goal.id && value.status === 'retained')) continue;
      const old = retained[goal.id]?.goalHash === hash(goal) ? retained[goal.id] : null;
      const candidate = old || run.autonomy.candidates.find(value => value.goalId === goal.id);
      const firstId = `goal-${goal.id}`, replayId = `replay-${goal.id}`;
      addCheck(firstId, `${goal.name}: trusted assertions`); addCheck(replayId, `${goal.name}: independent clean replay`);
      if (!candidate) {
        result(firstId, 'blocked', 'The model did not produce a valid journey for this trusted goal.');
        result(replayId, 'blocked', 'No validated candidate exists to replay.'); await save(); continue;
      }
      try { validateRetainedJourney(goal, candidate.journey); }
      catch (error) {
        result(firstId, 'blocked', error.message); result(replayId, 'blocked', 'A retained/generated journey no longer preserves the trusted goal contract.'); await save(); continue;
      }
      const currentSuite = { ...rawSuite, pages: [goal.start], journeys: [candidate.journey], discovery: { enabled: false } };
      validateWebSuite(currentSuite, metadata);
      const first = await browser(firstId, currentSuite);
      if (first?.result.status !== 'passed') {
        result(replayId, 'blocked', 'The original candidate failed or lacked complete evidence; it was not accepted or retried into a pass.');
        await save(); continue;
      }
      const replay = await browser(replayId, currentSuite);
      if (replay?.result.status !== 'passed') continue;
      if (first.runId === replay.runId || first.suiteDigest !== replay.suiteDigest) {
        result(replayId, 'execution_error', 'Regression acceptance requires independent executions of the same suite.'); await save(); continue;
      }
      let journey = candidate.journey;
      const repairs = [...new Map((first.repairs || []).map(repair => [repair.id, repair])).values()];
      if (repairs.length && goals.allowSemanticMaintenance) {
        try {
          const healed = await approveRepairs({ originalSuite: currentSuite, proposals: repairs, firstEvidence: first, replayEvidence: replay,
            approvedBy: `trusted-goals:${hash(goals).slice(0, 32)}`, outputPath: await ownedPath(runDirectory, `maintenance/${goal.id}.json`) });
          journey = healed.journeys[0];
          run.limitations.push(`${goal.name}: a semantic locator repair was retained under explicit trusted policy after two verified replays. Assertions were unchanged.`);
        } catch (error) { run.limitations.push(`Semantic maintenance was not persisted: ${clean(error.message)}`); }
      } else if (repairs.length) run.limitations.push(`${goal.name}: semantic repairs remain proposals; persistent maintenance is not authorized in trusted goals.`);
      const record = { goalId: goal.id, goalHash: hash(goal), journey, firstRevision: old?.firstRevision || pr.revision, validatedRevision: pr.revision,
        validatedAt: now(), runIds: [first.runId, replay.runId], runKey: key, history: [...(old?.history || []), { revision: pr.revision, runKey: key, runIds: [first.runId, replay.runId] }].slice(-100) };
      state.autonomy.regressions[policyKey] ||= {};
      state.autonomy.regressions[policyKey][goal.id] = record;
      await writeJson(directory, `regressions/${policyKey}/${goal.id}.json`, { schemaVersion: 1, repository: pr.repository, ...record });
      const status = { goalId: goal.id, status: 'retained', reused: Boolean(old), runIds: record.runIds };
      run.autonomy.goals = run.autonomy.goals.filter(value => value.goalId !== goal.id); run.autonomy.goals.push(status);
      await save();
    }
    // Reuse the existing bounded read-only specialist team for code review,
    // security review, result triage and image-based UI improvement proposals.
    const reviewRoles = config.ai.roles.filter(role => role !== 'planner');
    if (reviewRoles.length && !run.autonomy.reviewCompleted) {
      const check = addCheck('autonomy-specialists', 'Configured AI specialists inspect source and final browser/test evidence', 'analysis');
      if (config.ai.allowImages) {
        pr.screenshots = [];
        // Prefer final journey states. Every image still comes from the trusted
        // browser worker and must attest the reviewed deployment revision.
        for (const [id, evidence] of Object.entries(run.autonomy.browser).reverse()) {
          if (pr.screenshots.length >= 4) break;
          if (!evidence.revisionVerified || !evidence.screenshots?.length) continue;
          try {
            const imageDir = await ownedPath(runDirectory, `browser/${hash(id)}`, { directory: true });
            const manifest = await writeJson(imageDir, 'autonomy-images.json', { revision: pr.revision, images: evidence.screenshots.slice(-(4 - pr.screenshots.length)) });
            pr.screenshots.push(...await readScreenshots(manifest, pr.revision));
          } catch (error) { run.limitations.push(`Image review was unavailable: ${clean(error.message)}`); }
        }
      }
      try {
        // Security is a planning specialist in the shared coordinator. Final
        // results are provided to its read-only tools in this stage as well.
        const reviewConfig = { ...config.ai, roles: reviewRoles.filter(role => role !== 'triage') };
        if (reviewConfig.roles.length) run.ai.latest = await team({ pr, plan: run.plan, config: reviewConfig, client: aiClient, stage: 'planning',
          results: run.results, prior: run.ai.latest, analysisKey: `autonomy-final:${key}`, trustedRunners: config.runners || [],
          onCheckpoint: async value => { run.ai.latest = value; await save(); } });
        if (reviewRoles.includes('triage')) {
          const previous = run.ai.latest;
          const merge = value => ({ ...value,
            status: value.status === 'completed' && (!reviewConfig.roles.length || previous.status === 'completed') ? 'completed' : 'partial',
            roles: [...(previous.roles || []), ...value.roles], findings: [...(previous.findings || []), ...value.findings],
            questions: [...(previous.questions || []), ...value.questions], candidates: [...(previous.candidates || []), ...value.candidates],
            limitations: [...new Set([...(previous.limitations || []), ...value.limitations])] });
          const triage = await team({ pr, plan: run.plan, config: { ...config.ai, roles: ['triage'] }, client: aiClient,
            stage: 'completion', results: run.results, prior: previous, analysisKey: `autonomy-triage:${key}`, trustedRunners: config.runners || [],
            onCheckpoint: async value => { run.ai.latest = merge(value); await save(); } });
          run.ai.latest = merge(triage);
        }
        check.analysisStatus = run.ai.latest.status === 'completed' ? 'passed' : 'execution_error';
        result(check.id, check.analysisStatus, 'AI review completion is recorded separately from executed test passes.');
      } catch (error) { check.analysisStatus = 'execution_error'; result(check.id, 'execution_error', error.message); }
      run.autonomy.reviewCompleted = true; await save();
    }
    const ai = run.ai.latest;
    // Adapter aliases used by the website report; no inference verdict can set
    // an automated browser result or erase a failed candidate.
    ai.costUsd = ai.cost; ai.calls = ai.budget.calls; ai.backend = config.ai.backend; ai.model = config.ai.model;
    for (const [index, finding] of (ai.findings || []).entries()) if (['critical', 'high'].includes(finding.severity)) addCheck(`ai-finding-${index}`, clean(finding.title || finding.description), 'human');
    for (const [index, question] of (ai.questions || []).entries()) addCheck(`ai-question-${index}`, clean(question.question || question.prompt || question), 'human');
    run.limitations = [...new Set([...run.limitations, ...(ai.limitations || [])].map(clean))];
    run.outcome = deriveOutcome(run.plan, run.results, run.decisions, run.revision);
    run.phase = 'completed'; run.completedAt = now();
    run.report = { path: path.join(runDirectory, 'report.json') };
    await writeJson(runDirectory, 'report.json', run); await save();
    log(`Autonomous QA ${run.outcome.status}: ${run.autonomy.goals.length}/${goals.goals.length} trusted goals retained. Report: ${run.report.path}`);
    return run;
  });
}

module.exports = { runAutonomous, validCounts, verifiedEvidence, importedResults };
