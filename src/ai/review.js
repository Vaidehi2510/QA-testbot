// Local review reads committed Git objects and calls only the selected model.
// It does not dispatch workflows, run PR code, post messages, or apply patches.
const fs = require('node:fs/promises');
const path = require('node:path');
const { localSnapshot, readScreenshots } = require('./snapshot');
const { executeWebCheck } = require('../web/execute');
const { validateWebSuite } = require('../web/audit');
const { validateAIConfig } = require('./settings');
const { createAIClient } = require('./client');
const { addReviewGate, reviewStage } = require('./pipeline');
const { generatePlan } = require('../planner');
const { assessPR, digest } = require('../lifecycle');
const { deriveOutcome } = require('../core');
const { FileStore } = require('../state');
const { renderReport } = require('../report');

function parseArgs(argv) {
  const options = {};
  const allowed = new Set(['repo', 'base', 'head', 'repository', 'pr', 'title', 'description-file', 'config', 'rules', 'output-dir', 'screenshots', 'results', 'model', 'rerun-token', 'web-suite']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete review option: ${argv[i]}`);
    options[name] = argv[++i];
  }
  return options;
}

async function reviewLocal({ options, client, team, webRunner = executeWebCheck, log = console.log, env = process.env }) {
  const root = path.join(__dirname, '../..');
  const configPath = path.resolve(options.config || path.join(root, 'qa-config.json'));
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (options.model) config.ai = { ...config.ai, enabled: true, model: options.model, roleModels: {} };
  config.ai = validateAIConfig(config.ai || {});
  const dryRun = Boolean(options.dryRun || env.DRY_RUN === 'true');
  if (!config.ai.enabled && !dryRun) throw new Error('Enable AI and choose a model in npm run dashboard, or pass --model <model ID>.');
  const rules = JSON.parse(await fs.readFile(options.rules || path.join(root, 'qa-rules.json'), 'utf8'));
  const pr = await localSnapshot({ repositoryPath: options.repo || process.cwd(), base: options.base || 'main', head: options.head || 'HEAD', config,
    repository: options.repository, number: Number(options.pr || 1), title: options.title,
    body: options['description-file'] ? await fs.readFile(options['description-file'], 'utf8') : '' });
  pr.screenshots = await readScreenshots(options.screenshots, pr.revision);
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error('--pr must be a positive integer');
  const webSuite = options['web-suite'] ? JSON.parse(await fs.readFile(options['web-suite'], 'utf8')) : null;
  const webRunnerId = config.runners?.some(runner => runner.id === 'ui-tests') ? 'web-preview-cli' : 'ui-tests';
  if (webSuite) {
    validateWebSuite(webSuite, { repository: pr.repository, revision: pr.revision, prNumber: pr.number });
    if (config.runners?.some(runner => runner.id === webRunnerId)) throw new Error('The dedicated browser runner ID already exists; configure its suite in trusted configuration instead.');
    config.runners = [...(config.runners || []),
      { id: webRunnerId, type: 'web-preview', baseline: true, suite: webSuite,
        expected: 'The configured desktop/mobile preview checks and explicit journey assertions pass at this exact commit.' }];
  }
  const plan = addReviewGate(generatePlan(pr, rules, config), config, pr.revision);
  plan.fingerprint = digest([plan.fingerprint, pr.screenshots.map(image => image.sha256)]);
  if (dryRun) {
    log(`[DRY RUN] Review ${pr.repository} at ${pr.revision}; ${pr.sourceFiles.length} source files, ${pr.screenshots.length} screenshots. No model calls or saved state.`);
    log(plan.markdown);
    return { status: 'preview', pr, plan };
  }
  const directory = path.resolve(options['output-dir'] || path.join(root, '.qa-local'));
  // Reports and candidate files belong to the bot, never the product checkout.
  const productRoot = await fs.realpath(path.resolve(options.repo || process.cwd()));
  let ancestor = directory, suffix = '';
  while (true) {
    try { ancestor = path.join(await fs.realpath(ancestor), suffix); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; suffix = path.join(path.basename(ancestor), suffix); ancestor = path.dirname(ancestor); }
  }
  const relativeOutput = path.relative(productRoot, ancestor);
  if (relativeOutput === '' || !relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput)) throw new Error('Review output must be outside the product repository; choose --output-dir in the bot workspace or a temporary directory.');
  const store = new FileStore(directory);
  return store.withLock(async (state, save) => {
    const { run } = assessPR(state, pr, plan, config, { rerunToken: options['rerun-token'] || '' });
    run.limitations ||= [];
    run.limitations.push(webSuite ? 'Local review reads committed source and runs the explicitly configured bot-owned preview suite. It does not change product files or publish remote results.'
      : 'Local AI review reads committed source. It does not run the application or tests, change files, or publish remote results.');
    let results = [];
    if (options.results) {
      const envelope = JSON.parse(await fs.readFile(options.results, 'utf8'));
      if (envelope.schemaVersion !== 1 || envelope.revision !== pr.revision || envelope.repository !== pr.repository || Number(envelope.prNumber) !== pr.number || !Array.isArray(envelope.results)) throw new Error('Imported test results do not match this repository, PR, and exact revision');
      const ids = new Set();
      for (const result of envelope.results) {
        if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.checkId !== 'string' || !result.checkId || ids.has(result.checkId) ||
          !['passed', 'failed', 'skipped', 'blocked', 'execution_error'].includes(result.status) || result.revision && result.revision !== pr.revision) throw new Error('Invalid or unexpected imported test result');
        if (result.status === 'passed' && !result.counts) throw new Error('Imported passing results require positive structured test counts');
        if (result.counts !== undefined) {
          const counts = result.counts;
          if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid imported test counts');
          const { tests, passed, failed, skipped, cancelled = 0 } = counts;
          if (![tests, passed, failed, skipped, cancelled].every(value => Number.isSafeInteger(value) && value >= 0) ||
            tests !== passed + failed + skipped + cancelled || result.status === 'passed' && (tests < 1 || failed + skipped + cancelled > 0)) throw new Error('Imported result counts contradict a pass or test total');
        }
        ids.add(result.checkId);
      }
      results = envelope.results;
      run.limitations.push('Test results were imported from a local file; remote workflow provenance was not independently verified.');
    }
    const aiClient = client || createAIClient({ ai: config.ai, env, timeoutMs: config.ai.backend === 'local' ? 120000 : 30000, maxRetries: 0 });
    const review = stage => reviewStage({ run, pr, config, client: aiClient, stage, save: () => save(state), ...(team ? { team } : {}) });
    log(`Reviewing ${pr.repository} ${pr.revision.slice(0, 12)} with ${config.ai.backend === 'local' ? 'the configured local model server' : 'OpenRouter'}. Source context: ${pr.sourceFiles.length} files.`);
    await review('planning');
    if (webSuite) {
      const checkId = `runner-${webRunnerId}`;
      const webDir = path.join(directory, 'browser', run.key);
      if (!run.web) {
        run.web = await webRunner({ suite: webSuite, metadata: { repository: pr.repository, prNumber: pr.number, revision: pr.revision },
          outputDir: webDir, checkId, env });
        await save(state);
      }
      if (results.some(result => result.checkId === checkId)) throw new Error('Imported evidence cannot replace the requested browser execution');
      results.push(run.web.result);
      run.limitations.push(...(run.web.limitations || []));
      const manifestPath = path.join(webDir, 'screenshots.json');
      await fs.mkdir(webDir, { recursive: true });
      await fs.writeFile(manifestPath, JSON.stringify({ revision: pr.revision, environment: 'disposable-web-preview',
        images: (run.web.screenshots || []).map(item => ({ name: item.name, path: item.path })) }), { mode: 0o600 });
      pr.screenshots = [...pr.screenshots, ...await readScreenshots(manifestPath, pr.revision)].slice(0, 4);
    }
    // Planning may add existing trusted suites. Validate their check IDs only
    // after resuming/applying that plan, before importing evidence or triage.
    const trustedRunners = new Set((config.runners || []).map(runner => runner.id));
    const allowed = new Set(run.plan.checks.filter(check => check.method === 'automated' && trustedRunners.has(check.runner)).map(check => check.id));
    if (results.some(result => !allowed.has(result.checkId))) throw new Error('Invalid or unexpected imported test result');
    run.results = results;
    run.completionEvent = `local:${digest(results)}`;
    const completionKey = `completion:${digest([run.completionEvent, run.results])}`;
    if (run.ai?.completion?.analysisKey !== completionKey) {
      delete run.ai.completion;
      const gate = run.plan.checks.find(check => check.id === 'ai-team-review');
      if (gate) gate.analysisStatus = 'blocked';
      run.outcome = deriveOutcome(run.plan, run.results, run.decisions, run.revision);
      await save(state);
    }
    await review('completion');
    run.phase = 'reviewed';
    run.outcome = deriveOutcome(run.plan, run.results, run.decisions, run.revision);
    run.limitations = [...new Set(run.limitations)];
    const reportPath = path.join(directory, 'reports', `${run.key}.md`);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    run.report = { ...run.report, status: 'local', path: reportPath };
    await fs.writeFile(reportPath, renderReport(run), { mode: 0o600 });
    const candidateDirectory = path.join(directory, 'candidates', run.key);
    await fs.mkdir(candidateDirectory, { recursive: true });
    for (const candidate of [...(run.ai?.planning?.candidates || []), ...(run.ai?.completion?.candidates || [])]) {
      // Only inert review artifacts, never executable files installed into target.
      await fs.writeFile(path.join(candidateDirectory, `${digest(candidate.id).slice(0, 24)}.json`), JSON.stringify(candidate, null, 2), { mode: 0o600 });
    }
    await save(state);
    log(`AI review: ${run.ai.completion.status}. QA outcome: ${run.outcome.status}. Report: ${reportPath}`);
    if (!results.length) log('No test execution evidence was supplied. Automated coverage remains blocked/untested.');
    return run;
  });
}
async function main() { return reviewLocal({ options: parseArgs(process.argv.slice(2)) }); }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, reviewLocal };
