const fs = require('node:fs/promises');
const path = require('node:path');
const { generatePlan } = require('./planner');
const { deriveOutcome } = require('./core');
const { routeRequest } = require('./decisions');
const { GitHubStore } = require('./state');
const { assessPR, isCurrent, completeRun, ingestDecisions, digest, queueEffect, deliverEffect, archiveCompletion } = require('./lifecycle');
const github = require('./github');
const { dispatchExecution } = require('./dispatch');
const { DriveAdapter } = require('./drive');
const { SlackAdapter, completionMessage, requestMessage } = require('./slack');
const { renderReport } = require('./report');
const { OpenRouterClient } = require('./ai/openrouter');
const { addReviewGate, reviewStage, applyAssessment } = require('./ai/pipeline');

function executionRequest(run, config) {
  return { plan: run.plan, config, metadata: { repository: run.repository, prNumber: run.pr.number,
    revision: run.revision, environment: run.environment, runId: run.runId, attempt: run.attempt } };
}

// Dependencies are injected so the same state machine runs in offline integration tests.
async function reconcile({ state, save, config, rules, people, prs, workflows = [], integrations, dryRun = false,
  rerunToken = '', prNumber, retryIntegrations = false, log = console.log, skipAICompletion = false }) {
  if (dryRun) { state = structuredClone(state); save = async () => {}; }
  if (retryIntegrations && !dryRun) for (const e of Object.values(state.effects)) {
    if (e.status === 'exhausted') { e.status = 'pending'; e.attempts = 0; delete e.nextAttemptAt; }
  }
  if (retryIntegrations && !dryRun) for (const run of Object.values(state.runs)) {
    if (run.collectionExhausted) { run.collectionAttempts = {}; run.collectionExhausted = false; run.resultCollectionPending = true; }
  }
  for (const pr of prs) {
    const plan = addReviewGate(generatePlan(pr, rules, config), config, pr.revision);
    // A one-time rerun must remain current when the next scheduled poll omits its token.
    const previous = state.runs[state.prs[`${pr.repository}#${pr.number}`]?.currentRunKey];
    const applicableToken = !prNumber || Number(prNumber) === pr.number ? rerunToken : '';
    const assessment = !applicableToken && previous?.revision === pr.revision && previous?.plan.fingerprint === plan.fingerprint
      ? { run: previous, created: false } : assessPR(state, pr, plan, config, { rerunToken: applicableToken });
    const { run, created } = assessment;
    // A historical token must not restore an older run; process the actual current run.
    const current = state.runs[state.prs[`${pr.repository}#${pr.number}`].currentRunKey];
    ingestDecisions(state, current, pr.comments || [], config);
    if (config.ai?.enabled && !current.request && current.phase === 'queued') {
      await invokeReview({ run: current, pr, config, integrations, stage: 'planning', save: () => save(state), dryRun });
    }
    if (created || (current.phase === 'queued' && !current.request)) {
      current.request = executionRequest(current, config);
      queueEffect(state, `${current.key}:dispatch`, 'dispatch', current.key);
      queueEffect(state, `${current.key}:plan`, 'plan', current.key);
      log(`QA assessment ${pr.repository}#${pr.number} @ ${pr.revision.slice(0, 12)}: ${plan.checks.length} checks`);
    }
  }
  await save(state);
  for (const workflow of workflows) {
    if (workflow.event !== 'workflow_dispatch' || !String(workflow.path || '').split('@')[0].endsWith('.github/workflows/qa-execute.yml')) continue;
    const key = String(workflow.display_title || '').match(/^QA execution ([a-f0-9]{64})$/)?.[1];
    const run = state.runs[key];
    if (!run || (run.actionsRunId && String(run.actionsRunId) !== String(workflow.id))) continue;
    run.actionsRunId = String(workflow.id);
    if (workflow.status !== 'completed') {
      if (!run.actionsAttempt || Number(workflow.run_attempt) > run.actionsAttempt) {
        archiveCompletion(run);
        run.phase = 'running'; run.results = []; run.actionsAttempt = Number(workflow.run_attempt);
        run.attemptStartedAt = workflow.run_started_at || new Date().toISOString();
        if (run.ai) {
          delete run.ai.completion;
          const gate = run.plan.checks.find(check => check.id === 'ai-team-review');
          if (gate) gate.analysisStatus = 'blocked';
        }
        run.outcome = deriveOutcome(run.plan, [], run.decisions, run.revision);
      }
      continue;
    }
    const completionEvent = `${workflow.id}:${workflow.run_attempt}`;
    if (run.completionEvent === completionEvent && !run.resultCollectionPending) continue;
    run.collectionAttempts ||= {};
    const attempts = run.collectionAttempts[completionEvent] || 0;
    if (attempts >= (config.maxIntegrationAttempts || 5)) { run.collectionExhausted = true; continue; }
    run.collectionAttempts[completionEvent] = attempts + 1;
    let envelope;
    try { envelope = await integrations.readResults(workflow, key); }
    catch (error) { run.collectionError = String(error.message).slice(0, 300); }
    completeRun(state, key, envelope, workflow);
    if (envelope) { delete run.collectionError; run.collectionExhausted = false; }
  }
  // A lost dispatch, expired artifact, or interrupted preparation becomes an error.
  // It must not leave an indefinite apparent success or silently redispatch PR code.
  for (const run of Object.values(state.runs)) {
    if (['queued', 'running'].includes(run.phase) && Date.now() - Date.parse(run.attemptStartedAt || run.createdAt) > (config.dispatchTimeoutMinutes || 45) * 60000) {
      completeRun(state, run.key, null, { id: run.actionsRunId || `missing-${run.key}`, run_attempt: run.actionsAttempt || 1,
        status: 'completed', conclusion: 'timed_out', html_url: run.evidenceUrl });
    }
  }
  await save(state);

  const deliver = (effect, fn) => {
    if (dryRun) log(`[DRY RUN] Preview ${effect.type} for ${effect.runKey.slice(0, 12)}`);
    return deliverEffect(state, effect, fn, save, { dryRun, maxAttempts: config.maxIntegrationAttempts || 5 });
  };
  const completedKeys = new Set(workflows.filter(w => w.status === 'completed').map(w => String(w.display_title).replace('QA execution ', '')));
  const orderedRuns = Object.values(state.runs).sort((a, b) => Number(completedKeys.has(b.key)) - Number(completedKeys.has(a.key)));
  for (const run of orderedRuns) {
    let current = isCurrent(state, run);
    // Check the live head immediately before publishing. Commit status is also SHA-bound.
    if (current && integrations.currentRevision) current = await integrations.currentRevision(run) === run.revision;
    const version = digest([run.results, run.decisions, run.phase, run.actionsAttempt, run.plan.checks, run.ai?.planning?.status, run.ai?.completion?.status]);
    const reportVersion = digest([version, run.supersededAt, (run.completionHistory || []).map(h =>
      [h.event, h.snapshot?.report.status, h.snapshot?.report.url])]);
    if (current) {
      for (const type of ['plan', 'dispatch']) {
        const effect = state.effects[`${run.key}:${type}`];
        if (!effect) continue;
        if (type === 'dispatch') {
          if (run.phase === 'completed') continue;
          await deliver(effect, async () => {
            if (run.actionsRunId) return { status: 'sent', recovered: true, id: run.actionsRunId };
            await integrations.putRequest(run.key, run.request);
            return integrations.dispatch(run.key);
          });
        } else await deliver(effect, () => integrations.plan(run));
      }
      for (const request of run.requests.filter(r => r.status === 'open')) {
        const check = run.plan.checks.find(c => c.id === request.checkId);
        const routing = routeRequest(check, { ...run.pr, revision: run.revision }, people, config);
        request.routing = routing;
        const e = queueEffect(state, `${run.key}:question:${check.id}`, 'question', run.key);
        await deliver(e, () => integrations.slack.send(requestMessage(check, { ...run.pr, revision: run.revision }, routing), { key: e.key }));
      }
      const status = queueEffect(state, `${run.key}:status:${version}`, 'status', run.key);
      await deliver(status, () => integrations.status(run));
    }
    if (run.phase !== 'completed') continue;
    run.report.markdown = renderReport(run); // Retain the exact report even when Drive is unavailable.
    if (dryRun) { log(run.report.markdown); if (current) log(completionMessage(run)); }
    // Publish completion before attempting Drive I/O, which may be unavailable.
    // A second, deduplicated message supplies the link after a successful upload.
    const notification = current ? queueEffect(state, `${run.key}:completion:${version}`, 'completion', run.key) : null;
    if (notification) await deliver(notification, async () => {
      const receipt = await integrations.slack.send(completionMessage(run), { key: notification.key });
      return { ...receipt, reportUrl: run.report.status === 'uploaded' ? run.report.url : undefined };
    });
    const report = queueEffect(state, `${run.key}:report:${reportVersion}`, 'report', run.key);
    await deliver(report, async () => {
      const result = await integrations.drive.upsertReport(run, { current });
      // Keep checkpointed file IDs and the retained markdown across partial failures.
      Object.assign(run.report, result);
      return result;
    });
    if (!current) continue;
    if (run.report.status === 'uploaded' && notification.status === 'done' && !notification.receipt?.reportUrl) {
      const link = queueEffect(state, `${run.key}:report-link:${version}`, 'report-link', run.key);
      await deliver(link, () => integrations.slack.send(`QA report available for ${run.repository}#${run.pr.number} at ${run.revision.slice(0, 12)}: ${run.report.url}`, { key: link.key }));
    }
  }
  // Retry archived uploads after current completion notifications.
  for (const run of orderedRuns) for (const historical of run.completionHistory || []) {
    const snapshot = historical.snapshot;
    if (!snapshot || snapshot.report.status === 'uploaded') continue;
    const effect = queueEffect(state, `${run.key}:archived-report:${historical.event}`, 'report', run.key);
    await deliver(effect, async () => {
      const result = await integrations.drive.upsertReport(snapshot, { current: false });
      Object.assign(snapshot.report, result);
      return result;
    });
  }
  // The initial completion has already been sent before potentially slow model
  // calls. A final review produces a separate factual update and revised report.
  let reviewed = false;
  if (config.ai?.enabled && !skipAICompletion && !dryRun) for (const run of orderedRuns) {
    if (!isCurrent(state, run) || run.phase !== 'completed') continue;
    const pr = prs.find(pr => pr.repository === run.repository && pr.number === run.pr.number && pr.revision === run.revision);
    if (!pr) continue;
    const analysisKey = `completion:${digest([run.completionEvent, run.results])}`;
    if (run.ai?.completion?.analysisKey === analysisKey && run.ai.completion.status !== 'running' && run.ai.completion.applied) continue;
    if (run.screenshots?.length && !run.reviewScreenshots && integrations.readImages) {
      try { Object.defineProperty(run, 'reviewScreenshots', { value: await integrations.readImages(run), enumerable: false, configurable: true, writable: true }); }
      catch { run.screenshotLimitations = [...(run.screenshotLimitations || []), 'Could not reload screenshot evidence after a controller restart.']; }
    }
    const evidencePr = { ...pr, screenshots: run.reviewScreenshots || pr.screenshots || [], aiLimitations: [...(pr.aiLimitations || []), ...(run.screenshotLimitations || [])] };
    await invokeReview({ run, pr: evidencePr, config, integrations, stage: 'completion', save: () => save(state), dryRun });
    reviewed = true;
  }
  await save(state);
  if (reviewed) return reconcile({ state, save, config, rules, people, prs, workflows: [], integrations, dryRun,
    rerunToken: '', log, skipAICompletion: true });
  return state;
}

async function invokeReview({ run, pr, config, integrations, stage, save, dryRun }) {
  try {
    return await reviewStage({ run, pr, config, client: integrations.ai, stage, save, dryRun,
      ...(integrations.aiTeam ? { team: integrations.aiTeam } : {}) });
  } catch (error) {
    if (dryRun) return;
    run.ai ||= {};
    const previous = run.ai[stage] || run.ai.latest || {};
    const assessment = { ...previous, stage, revision: run.revision, status: 'error',
      analysisKey: stage === 'planning' ? `planning:${run.plan.fingerprint}` : `completion:${digest([run.completionEvent, run.results])}`,
      findings: [], questions: [], candidates: [], selectedRunnerIds: [], roles: [],
      limitations: ['AI review did not finish. Check model configuration, API access, and the review budget.'], errorCode: error.code || 'AI_REVIEW_ERROR' };
    run.ai[stage] = assessment; run.ai.latest = assessment;
    applyAssessment(run, assessment, config, stage);
    assessment.applied = true;
    await save();
    return assessment;
  }
}

async function main(env = process.env) {
  const root = path.join(__dirname, '..');
  const [config, rules, people] = await Promise.all(['qa-config.json', 'qa-rules.json', 'people.json'].map(async filename => JSON.parse(await fs.readFile(path.join(root, filename), 'utf8'))));
  const dryRun = env.DRY_RUN !== 'false';
  const enabled = config.enabled || env.QA_ENABLED === 'true';
  if (!enabled && !dryRun) throw new Error('Activation disabled. Set QA_ENABLED=true after configuring the isolated environment, or use DRY_RUN=true.');
  if (!env.TARGET_OWNER || !env.TARGET_REPO || !env.BOT_REPOSITORY || !env.GITHUB_TOKEN || !(env.APP_ID || env.QA_APP_ID) || !(env.APP_PRIVATE_KEY || env.QA_APP_PRIVATE_KEY)) {
    throw new Error('Sync needs TARGET_OWNER, TARGET_REPO, BOT_REPOSITORY, GITHUB_TOKEN and GitHub App credentials. Run npm run demo for the credential-free workflow.');
  }
  const [owner, repo] = env.BOT_REPOSITORY.split('/');
  const target = { owner: env.TARGET_OWNER, repo: env.TARGET_REPO };
  const [gh, bot] = await Promise.all([
    github.getClient({ ...target, appId: env.APP_ID || env.QA_APP_ID, privateKey: (env.APP_PRIVATE_KEY || env.QA_APP_PRIVATE_KEY).replace(/\\n/g, '\n') }),
    github.getClient({ token: env.GITHUB_TOKEN }),
  ]);
  const store = new GitHubStore({ gh: bot, owner, repo, branch: config.stateBranch, baseRef: config.executionRef, dryRun });
  return store.withLock(async (state, save) => {
    const tracked = Object.keys(state.prs).filter(k => k.startsWith(`${target.owner}/${target.repo}#`)).map(k => Number(k.split('#')[1]));
    let prs, workflows;
    // Completion events inspect only their associated PR before notifying; the
    // scheduled path performs the full scan and recovers lost completion events.
    if (env.COMPLETED_RUN_ID) {
      const { data } = await bot.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(env.COMPLETED_RUN_ID) });
      workflows = [data];
      const key = String(data.display_title || '').match(/^QA execution ([a-f0-9]{64})$/)?.[1];
      const run = state.runs[key];
      prs = run?.repository === `${target.owner}/${target.repo}` ? [await github.fetchPR(gh, target.owner, target.repo, run.pr.number, config)] : [];
    } else {
      [prs, workflows] = await Promise.all([
        github.fetchReleasePRs(gh, target.owner, target.repo, config, tracked),
        github.workflowRuns(bot, owner, repo),
      ]);
    }
    const drive = new DriveAdapter({ ...config.drive, folderId: env.DRIVE_FOLDER_ID || config.drive?.folderId,
      sharedDriveId: env.DRIVE_SHARED_DRIVE_ID || config.drive?.sharedDriveId,
      credentials: env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined,
      accessToken: env.GOOGLE_DRIVE_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN, dryRun, onCheckpoint: () => save(state) });
    const slack = new SlackAdapter({ webhookUrl: env.SLACK_WEBHOOK_URL, botToken: env.SLACK_BOT_TOKEN, channelId: env.SLACK_CHANNEL_ID, dryRun });
    const integrations = {
      drive, slack, ai: new OpenRouterClient({ apiKey: env.OPENROUTER_API_KEY, dryRun, timeoutMs: 20000, maxRetries: 0 }),
      putRequest: (key, request) => store.putRequest(key, request),
      dispatch: key => dispatchExecution({ gh: bot, owner, repo, requestKey: key, ref: config.executionRef, dryRun, enabled }),
      readResults: (workflow, key) => github.readResultsArtifact(bot, owner, repo, workflow, key),
      readImages: run => github.readRunScreenshots(bot, owner, repo, run),
      currentRevision: async run => run.repository === `${target.owner}/${target.repo}`
        ? (await gh.rest.pulls.get({ ...target, pull_number: run.pr.number })).data.head.sha : null,
      plan: run => github.upsertComment(gh, target.owner, target.repo, run.pr.number, '<!-- qa-plan:auto -->', `${run.plan.markdown}\n\nTested revision: \`${run.revision}\`.\nHuman responses: \`/qa-tested check:<id> revision:${run.revision} result:pass|fail reason:<explanation>\`.`, { dryRun }),
      status: async run => {
        if (!dryRun) {
          const outcome = run.outcome.status;
          await gh.rest.repos.createCommitStatus({ ...target, sha: run.revision, context: 'qa-bot',
            state: outcome === 'passed' ? 'success' : outcome === 'failed' ? 'failure' : outcome === 'execution_error' ? 'error' : 'pending',
            description: `QA ${outcome}; attempt ${run.attempt}`.slice(0, 140), target_url: run.evidenceUrl || run.pr.url });
        }
        return github.updateLabels(gh, target.owner, target.repo, run.pr.number, run.outcome, config, { dryRun });
      },
    };
    if (dryRun) {
      const send = slack.send.bind(slack);
      slack.send = async (...args) => { const preview = await send(...args); console.log('[DRY RUN Slack]', args[0]); return preview; };
      console.log('[DRY RUN] GitHub writes, workflow dispatch, Drive upload, Slack posting, and durable state changes are disabled.');
    }
    return reconcile({ state, save, config, rules, people, prs, workflows, integrations, dryRun,
      rerunToken: env.QA_RERUN_TOKEN || '', prNumber: env.PR_NUMBER, retryIntegrations: env.RETRY_INTEGRATIONS === 'true' });
  });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, reconcile, executionRequest };
