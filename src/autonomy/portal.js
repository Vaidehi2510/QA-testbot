#!/usr/bin/env node
// A website can request bounded QA work, never commands, credentials or source writes.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateAIConfig } = require("../ai/settings");
const { redact } = require("../ai/context");
const { validateGoals } = require("./schema");
const { ownedPath } = require("./store");
const exec = promisify(execFile);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const within = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
function fields(value, allowed, name) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(`Invalid ${name} fields`);
}
function bounded(value, min, max, name, integer = true) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < min ||
    value > max
  )
    throw new Error(`Invalid ${name}`);
  return value;
}
function origin(value, pr = 1) {
  if (typeof value !== "string" || value.length > 500)
    throw new Error("Invalid enrolled preview origin");
  const url = new URL(value.replaceAll("{pr}", String(pr)));
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /[{}]/.test(url.href)
  )
    throw new Error("Enroll exact HTTP(S) origins, optionally containing {pr}");
  return url.origin;
}
function validatePortalPolicy(
  input,
  {
    policyPath = path.join(process.cwd(), "portal-policy.json"),
    botDir = path.join(__dirname, "../.."),
  } = {},
) {
  fields(
    input,
    [
      "schemaVersion",
      "repository",
      "repoCheckout",
      "base",
      "allowedPreviewOrigins",
      "allowedBrowsers",
      "maxPages",
      "maxGoals",
      "maxAssertions",
      "maxCostUsd",
      "maxCallsPerRun",
      "allowedBackends",
      "allowImages",
      "allowMutations",
      "allowSemanticMaintenance",
      "executeBaseline",
      "visual",
      "timeoutMs",
      "configPath",
      "regressionDir",
    ],
    "runner policy",
  );
  if (
    input.schemaVersion !== 1 ||
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository || "") ||
    input.repository.length > 201
  )
    throw new Error("Runner policy needs a repository and schemaVersion 1");
  if (
    typeof input.repoCheckout !== "string" ||
    !path.isAbsolute(input.repoCheckout)
  )
    throw new Error("Enroll an absolute product checkout path");
  if (
    typeof input.base !== "string" ||
    !/^[\w./-]{1,200}$/.test(input.base) ||
    input.base.startsWith("-") ||
    input.base.includes("..")
  )
    throw new Error("Enroll an explicit base Git reference");
  if (
    !Array.isArray(input.allowedPreviewOrigins) ||
    !input.allowedPreviewOrigins.length ||
    input.allowedPreviewOrigins.length > 12
  )
    throw new Error("Enroll preview origins");
  input.allowedPreviewOrigins.forEach((value) => origin(value));
  const distinct = (values, allowed) =>
    Array.isArray(values) &&
    values.length &&
    values.length <= allowed.length &&
    new Set(values).size === values.length &&
    values.every((value) => allowed.includes(value));
  if (
    !distinct(input.allowedBrowsers, ["chromium", "firefox", "webkit"]) ||
    !distinct(input.allowedBackends, ["local", "openrouter"])
  )
    throw new Error("Enroll allowed browsers and model backends");
  bounded(input.maxPages, 1, 8, "page budget");
  bounded(input.maxGoals, 1, 8, "goal budget");
  bounded(input.maxAssertions, 1, 30, "assertion budget");
  bounded(input.maxCostUsd, 0, 25, "cost budget", false);
  bounded(input.maxCallsPerRun, 1, 40, "model call budget");
  bounded(input.timeoutMs, 1000, 1800000, "job deadline");
  if (typeof input.allowImages !== "boolean")
    throw new Error("Explicitly enroll the image-sharing policy");
  if (
    input.allowMutations !== undefined &&
    typeof input.allowMutations !== "boolean"
  )
    throw new Error("Invalid disposable-preview mutation policy");
  if (
    input.executeBaseline !== undefined &&
    typeof input.executeBaseline !== "boolean"
  )
    throw new Error("Invalid baseline execution enrollment");
  if (
    input.allowSemanticMaintenance !== undefined &&
    typeof input.allowSemanticMaintenance !== "boolean"
  )
    throw new Error("Invalid semantic maintenance enrollment");
  const visual = input.visual
    ? require("../web/visual").validateVisual(input.visual)
    : null;
  const parent = path.dirname(path.resolve(policyPath));
  const configPath = path.resolve(
    parent,
    input.configPath || path.join(botDir, "qa-config.json"),
  );
  const regressionDir = path.resolve(
    parent,
    input.regressionDir || ".qa-regressions",
  );
  return {
    ...input,
    ...(visual ? { visual } : {}),
    repoCheckout: path.resolve(input.repoCheckout),
    configPath,
    regressionDir,
  };
}
async function canonical(target) {
  let ancestor = path.resolve(target),
    tail = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(ancestor), ...tail);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      tail.unshift(path.basename(ancestor));
      const next = path.dirname(ancestor);
      if (next === ancestor) throw error;
      ancestor = next;
    }
  }
}
async function readJson(filename, maxBytes = 256 * 1024) {
  const file = await fs.open(
    filename,
    require("node:fs").constants.O_RDONLY |
      require("node:fs").constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new Error("Unsafe or oversized configuration file");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
async function protectedPaths(policy, outputs = []) {
  const product = await fs.realpath(policy.repoCheckout);
  for (const target of [
    policy.configPath,
    policy.regressionDir,
    ...(policy.visual ? [policy.visual.baselineDir] : []),
    ...outputs,
  ]) {
    if (within(product, await canonical(target)))
      throw new Error(
        "Bot configuration, regression store and output must be outside the product checkout",
      );
  }
  return product;
}
async function git(cwd, args) {
  return (
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    })
  ).stdout.trim();
}
async function preflightPortal({
  policy: input,
  policyPath,
  botDir,
  env = process.env,
} = {}) {
  const missing = [];
  let policy;
  try {
    policy = validatePortalPolicy(input, { policyPath, botDir });
  } catch (error) {
    return {
      ready: false,
      missing: [error.message],
      capabilities: { autonomy: true, browsers: [], backends: [] },
    };
  }
  try {
    await protectedPaths(policy);
    await git(policy.repoCheckout, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${policy.base}^{commit}`,
    ]);
  } catch {
    missing.push(
      "Product checkout/base or separate bot workspace is unavailable.",
    );
  }
  try {
    const config = await readJson(policy.configPath),
      ai = validateAIConfig(config.ai);
    if (!ai.enabled)
      missing.push("AI must be enabled in trusted runner configuration.");
    if (!policy.allowedBackends.includes(ai.backend))
      missing.push("Configured model backend is not enrolled.");
    if (ai.backend === "openrouter" && !env.OPENROUTER_API_KEY)
      missing.push("OPENROUTER_API_KEY is missing on the runner.");
  } catch {
    missing.push("Trusted model configuration is missing or invalid.");
  }
  for (const browser of policy.allowedBrowsers) {
    try {
      const executable =
        env[`QA_${browser.toUpperCase()}_EXECUTABLE`] ||
        (browser === "chromium" ? env.QA_BROWSER_EXECUTABLE : null) ||
        require("playwright-core")[browser].executablePath();
      await fs.access(executable, require("node:fs").constants.X_OK);
    } catch {
      missing.push(`Install the ${browser} browser on this runner.`);
    }
  }
  return {
    ready: !missing.length,
    missing,
    repository: policy.repository,
    capabilities: {
      autonomy: true,
      browsers: policy.allowedBrowsers,
      backends: policy.allowedBackends,
    },
  };
}
function validateJob(job, policy) {
  fields(
    job,
    [
      "schemaVersion",
      "id",
      "repository",
      "pr",
      "revision",
      "base",
      "settings",
      "testingProfile",
    ],
    "job",
  );
  if (
    job.schemaVersion !== 1 ||
    !/^[a-f0-9-]{36}$/.test(job.id || "") ||
    job.repository !== policy.repository ||
    !/^[a-f0-9]{40}$/.test(job.revision || "") ||
    job.base !== policy.base
  )
    throw new Error(
      "Job does not match the enrolled repository, base and exact revision",
    );
  fields(job.pr, ["number", "title"], "PR");
  bounded(job.pr.number, 1, 1e9, "PR number");
  const profile = job.testingProfile;
  fields(
    profile,
    [
      "previewUrlTemplate",
      "pages",
      "discoverPages",
      "maxPages",
      "browsers",
      "goals",
      "baseRef",
      "allowMutations",
      "visualRegression",
    ],
    "testing profile",
  );
  if (profile.baseRef !== undefined && profile.baseRef !== policy.base)
    throw new Error("Profile base differs from enrolled base");
  if (
    typeof profile.previewUrlTemplate !== "string" ||
    profile.previewUrlTemplate.length > 1000
  )
    throw new Error("Invalid preview URL");
  const target = new URL(
    profile.previewUrlTemplate
      .replaceAll("{pr}", String(job.pr.number))
      .replaceAll("{sha}", job.revision),
  );
  if (
    target.username ||
    target.password ||
    target.hash ||
    /[{}]/.test(target.href) ||
    !policy.allowedPreviewOrigins
      .map((value) => origin(value, job.pr.number))
      .includes(target.origin)
  )
    throw new Error("Job preview origin is not locally enrolled");
  if (
    !Array.isArray(profile.browsers) ||
    !profile.browsers.length ||
    new Set(profile.browsers).size !== profile.browsers.length ||
    profile.browsers.some((value) => !policy.allowedBrowsers.includes(value))
  )
    throw new Error("Requested browser is not enrolled");
  bounded(profile.maxPages, 1, policy.maxPages, "requested page budget");
  if (
    !Array.isArray(profile.pages) ||
    !profile.pages.length ||
    profile.pages.length > profile.maxPages ||
    profile.pages.some(
      (value) =>
        typeof value !== "string" ||
        !value.startsWith("/") ||
        value.startsWith("//") ||
        new URL(value, target).origin !== target.origin,
    )
  )
    throw new Error("Invalid requested preview paths");
  if (typeof profile.discoverPages !== "boolean")
    throw new Error("Invalid discovery policy");
  if (
    (profile.allowMutations !== undefined &&
      typeof profile.allowMutations !== "boolean") ||
    (profile.allowMutations === true && policy.allowMutations !== true)
  )
    throw new Error("Preview data mutations are not locally enrolled");
  if (
    (profile.visualRegression !== undefined &&
      typeof profile.visualRegression !== "boolean") ||
    (profile.visualRegression === true && !policy.visual)
  )
    throw new Error("Visual baselines are not locally enrolled");
  if (
    !object(profile.goals) ||
    profile.goals.schemaVersion !== 1 ||
    !Array.isArray(profile.goals.goals) ||
    !profile.goals.goals.length ||
    profile.goals.goals.length > policy.maxGoals ||
    profile.goals.goals.reduce(
      (sum, goal) =>
        sum +
        (Array.isArray(goal.assertions)
          ? goal.assertions.length
          : policy.maxAssertions + 1),
      0,
    ) > policy.maxAssertions
  )
    throw new Error(
      "Trusted goals/assertions are missing or exceed local limits",
    );
  const goals = validateGoals(profile.goals);
  if (
    new Set([...profile.pages, ...goals.goals.map((goal) => goal.start)]).size >
    profile.maxPages
  )
    throw new Error(
      "Requested pages and goal starts exceed the enrolled page budget",
    );
  if (
    profile.goals.allowSemanticMaintenance === true &&
    policy.allowSemanticMaintenance !== true
  )
    throw new Error("Persisting semantic repairs is not locally enrolled");
  fields(
    job.settings,
    [
      "backend",
      "model",
      "roleModels",
      "roles",
      "maxCostUsd",
      "maxCallsPerRun",
      "allowImages",
    ],
    "model settings",
  );
  if (!policy.allowedBackends.includes(job.settings.backend))
    throw new Error("Requested model backend is not enrolled");
  bounded(
    job.settings.maxCostUsd,
    0,
    policy.maxCostUsd,
    "requested model cost",
    false,
  );
  bounded(
    job.settings.maxCallsPerRun,
    1,
    policy.maxCallsPerRun,
    "requested model calls",
  );
  if (
    typeof job.settings.allowImages !== "boolean" ||
    (job.settings.allowImages && !policy.allowImages)
  )
    throw new Error("Image sharing is not locally enrolled");
  return job;
}
function portalReport(run, job) {
  if (
    run.repository !== job.repository ||
    run.revision !== job.revision ||
    Number(run.pr?.number || run.prNumber) !== job.pr.number
  )
    throw new Error("Engine report identity mismatch");
  const clean = (value, limit) => redact(String(value || "")).slice(0, limit);
  if (
    !Array.isArray(run.results) ||
    !Array.isArray(run.plan?.checks) ||
    new Set(run.results.map((result) => result.checkId)).size !==
      run.results.length
  )
    throw new Error("Engine results must be distinct execution records");
  const results = new Map(
    run.results.map((result) => [result.checkId, result]),
  );
  const validStatuses = new Set([
    "passed",
    "failed",
    "blocked",
    "skipped",
    "pending",
    "running",
    "execution_error",
    "awaiting_human",
    "unsupported",
  ]);
  const checks = (run.plan?.checks || []).slice(0, 200).map((check) => {
    const result = results.get(check.id),
      method = ["automated", "analysis", "human", "unsupported"].includes(
        check.method,
      )
        ? check.method
        : "unsupported";
    let status =
      result?.status ||
      check.status ||
      (method === "human" ? "awaiting_human" : "blocked");
    if (!validStatuses.has(status)) status = "blocked";
    if (
      status === "passed" &&
      method === "automated" &&
      (result?.revision !== job.revision ||
        !result?.counts ||
        ![
          result.counts.tests,
          result.counts.passed,
          result.counts.failed ?? 0,
          result.counts.skipped ?? 0,
          result.counts.cancelled ?? 0,
        ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        result.counts.tests < 1 ||
        result.counts.passed !== result.counts.tests ||
        result.counts.failed ||
        result.counts.skipped ||
        result.counts.cancelled)
    )
      status = "blocked";
    return {
      id: clean(check.id, 160),
      name: clean(check.name || check.expected || check.id, 240),
      method,
      required: check.required !== false,
      status,
      details: clean(result?.details || check.reason, 1200),
    };
  });
  if ((run.plan?.checks || []).length > 200)
    checks[199] = {
      id: "portal-check-limit",
      name: "Report size limit",
      method: "unsupported",
      required: true,
      status: "blocked",
      details:
        "Additional required checks exceed this report; review full evidence on the runner.",
    };
  for (const goal of job.testingProfile.goals.goals) {
    for (const id of [`goal-${goal.id}`, `replay-${goal.id}`]) {
      if (!checks.some((check) => check.id === id))
        checks.push({
          id,
          name: clean(
            `${goal.name}: required ${id.startsWith("replay-") ? "independent replay" : "business assertions"}`,
            240,
          ),
          method: "automated",
          required: true,
          status: "blocked",
          details:
            "Engine report omitted a required goal or its independent replay; coverage cannot be passed.",
        });
    }
  }
  if (new Set(checks.map((check) => check.id)).size !== checks.length)
    throw new Error("Report check IDs collide after redaction");
  if (checks.length > 200)
    checks.splice(199, checks.length - 199, {
      id: "portal-required-coverage-limit",
      name: "Required coverage exceeds report limit",
      method: "unsupported",
      required: true,
      status: "blocked",
      details: "Review complete goal and replay evidence on the runner.",
    });
  const ai = run.ai?.latest || run.ai || {};
  const cost = ai.costUsd ?? ai.cost,
    calls = ai.calls ?? ai.budget?.calls;
  const findings = (ai.findings || []).slice(0, 100).map((finding) => ({
    title: clean(finding.title || finding.message || "AI observation", 240),
    severity: ["critical", "high", "medium", "low", "info"].includes(
      finding.severity,
    )
      ? finding.severity
      : "info",
    category: clean(finding.category || finding.kind || "review", 80),
    description: clean(finding.description || finding.message, 1600),
    ...(finding.suggestedFix
      ? { suggestedFix: clean(finding.suggestedFix, 1600) }
      : {}),
    status: "unverified",
  }));
  return {
    schemaVersion: 1,
    recordId: sha(`portal:${job.id}:${job.repository}:${job.revision}`),
    repository: job.repository,
    pr: {
      number: job.pr.number,
      title: clean(
        run.pr?.title || job.pr.title || `PR #${job.pr.number}`,
        300,
      ),
    },
    revision: job.revision,
    createdAt: run.createdAt || new Date().toISOString(),
    completedAt: run.completedAt || new Date().toISOString(),
    phase: clean(run.phase || "completed", 80),
    checks,
    findings,
    ai: {
      backend: job.settings.backend,
      model: clean(job.settings.model, 160),
      costUsd:
        typeof cost === "number" && Number.isFinite(cost) && cost >= 0
          ? cost
          : null,
      costIsEstimate: ai.costIsEstimate !== false,
      calls: Number.isSafeInteger(calls) && calls >= 0 ? calls : 0,
    },
    limitations: [
      ...(run.limitations || []),
      "Local runner evidence; this report does not establish exhaustive product coverage.",
    ]
      .slice(0, 30)
      .map((value) => clean(value, 600)),
  };
}
async function runPortal({
  job: input,
  policy: raw,
  policyPath,
  outputDir,
  env = process.env,
  runAutonomous,
} = {}) {
  const policy = validatePortalPolicy(raw, { policyPath });
  const job = validateJob(input, policy),
    output = path.resolve(outputDir);
  await protectedPaths(policy, [output, policyPath]);
  const revision = await git(policy.repoCheckout, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${job.revision}^{commit}`,
  ]);
  if (revision !== job.revision)
    throw new Error(
      "Exact job commit is unavailable in the local checkout. Fetch it through your trusted runner setup.",
    );
  const baseRevision = await git(policy.repoCheckout, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${policy.base}^{commit}`,
  ]);
  const config = await readJson(policy.configPath);
  if (config.ai?.enabled !== true)
    throw new Error(
      "AI execution must be enabled locally before website jobs can run",
    );
  config.ai = validateAIConfig({
    ...config.ai,
    ...job.settings,
    enabled: true,
    maxCostUsd: Math.min(
      config.ai.maxCostUsd ?? 2,
      job.settings.maxCostUsd,
      policy.maxCostUsd,
    ),
    maxCallsPerRun: Math.min(
      config.ai.maxCallsPerRun ?? 20,
      job.settings.maxCallsPerRun,
      policy.maxCallsPerRun,
    ),
  });
  // The portal path never dispatches GitHub writes, even when normal bot mode does.
  config.enabled = false;
  config.targetAccess = "read-only";
  // Same job ID must retain its exact inputs and local policy across retries.
  // Otherwise changed config/base could create a fresh autonomy key and silently
  // reset an interrupted request's reserved inference budget.
  const receipt = {
    schemaVersion: 1,
    jobId: job.id,
    jobHash: sha(JSON.stringify(job)),
    policyHash: sha(JSON.stringify(policy)),
    configHash: sha(JSON.stringify(config)),
    baseRevision,
  };
  const receiptPath = await ownedPath(
    await canonical(policy.regressionDir),
    `portal-jobs/${job.id}.json`,
  );
  try {
    await fs.writeFile(receiptPath, JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (JSON.stringify(await readJson(receiptPath)) !== JSON.stringify(receipt))
      throw new Error(
        "Saved portal job inputs or local policy changed; request a new job instead of resetting its reserved budget",
      );
  }
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const inputDirectory = await fs.mkdtemp(path.join(output, "inputs-"));
  const files = {
    config: path.join(inputDirectory, "config.json"),
    suite: path.join(inputDirectory, "suite.json"),
    goals: path.join(inputDirectory, "goals.json"),
  };
  const suite = {
    targetEnvironment: "preview",
    url: job.testingProfile.previewUrlTemplate,
    pages: job.testingProfile.pages,
    browsers: job.testingProfile.browsers,
    allowMutations:
      job.testingProfile.allowMutations === true &&
      policy.allowMutations === true,
    discovery: {
      enabled: job.testingProfile.discoverPages,
      exploreControls: job.testingProfile.discoverPages,
      maxPages: job.testingProfile.maxPages,
    },
    ...(job.testingProfile.visualRegression ? { visual: policy.visual } : {}),
  };
  await fs.writeFile(files.config, JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(files.suite, JSON.stringify(suite), { mode: 0o600 });
  await fs.writeFile(files.goals, JSON.stringify(job.testingProfile.goals), {
    mode: 0o600,
  });
  const execute = runAutonomous || require("./run").runAutonomous;
  const run = await execute({
    options: {
      repo: policy.repoCheckout,
      base: baseRevision,
      head: job.revision,
      repository: job.repository,
      pr: String(job.pr.number),
      product: sha(job.repository).slice(0, 24),
      suite: files.suite,
      goals: files.goals,
      config: files.config,
      "output-dir": policy.regressionDir,
      "budget-usd": String(config.ai.maxCostUsd),
      "rerun-token": job.id,
      executeBaseline: policy.executeBaseline === true,
    },
    env,
    log: () => {},
  });
  const report = portalReport(run, job);
  const target = path.join(output, "portal-run.json");
  await fs.writeFile(target, JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return report;
}
async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--job", "--policy", "--output-dir"].includes(args[i]) ||
      !args[i + 1] ||
      options[args[i]]
    )
      throw new Error(
        "Usage: portal.js --job job.json --policy enrolled-policy.json --output-dir bot-output",
      );
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== 3)
    throw new Error("Missing portal job arguments");
  const report = await runPortal({
    job: await readJson(options["--job"]),
    policy: await readJson(options["--policy"]),
    policyPath: path.resolve(options["--policy"]),
    outputDir: options["--output-dir"],
  });
  console.log(
    JSON.stringify({
      recordId: report.recordId,
      revision: report.revision,
      report: "portal-run.json",
    }),
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(redact(error.message));
    process.exitCode = 1;
  });
module.exports = {
  validatePortalPolicy,
  validateJob,
  preflightPortal,
  protectedPaths,
  portalReport,
  runPortal,
  readJson,
  main,
};
