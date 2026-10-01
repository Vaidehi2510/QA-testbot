const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const {
  validatePortalPolicy,
  validateJob,
  preflightPortal,
  runPortal,
  portalReport,
} = require("../src/autonomy/portal");
const { DEFAULT_AI_CONFIG } = require("../src/ai/settings");
const revision = "a".repeat(40);
const policy = {
  schemaVersion: 1,
  repository: "example/product",
  repoCheckout: "/example/product",
  base: "main",
  allowedPreviewOrigins: ["https://pr-{pr}.preview.test"],
  allowedBrowsers: ["chromium"],
  allowedBackends: ["openrouter"],
  maxPages: 8,
  maxGoals: 8,
  maxAssertions: 30,
  maxCostUsd: 2,
  maxCallsPerRun: 20,
  allowImages: false,
  timeoutMs: 300000,
};
function job() {
  return {
    schemaVersion: 1,
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    repository: policy.repository,
    pr: { number: 7 },
    revision,
    base: "main",
    settings: {
      backend: "openrouter",
      model: "vendor/example",
      roleModels: {},
      roles: ["planner"],
      maxCostUsd: 1,
      maxCallsPerRun: 10,
      allowImages: false,
    },
    testingProfile: {
      previewUrlTemplate: "https://pr-{pr}.preview.test",
      pages: ["/"],
      discoverPages: true,
      maxPages: 4,
      browsers: ["chromium"],
      goals: {
        schemaVersion: 1,
        goals: [
          {
            id: "home",
            name: "Home",
            start: "/",
            requirement: "A greeting is shown",
            assertions: [
              {
                id: "greeting",
                action: "expectText",
                selector: "h1",
                text: "Hello",
              },
            ],
          },
        ],
      },
    },
  };
}
test("portal jobs cannot escape enrolled repository, origins, browsers or model budgets", () => {
  const parsed = validatePortalPolicy(policy);
  assert.equal(validateJob(job(), parsed).revision, revision);
  const changes = [
    (j) => (j.repository = "other/product"),
    (j) => (j.revision = "HEAD"),
    (j) => (j.base = "--upload-pack=evil"),
    (j) => (j.testingProfile.previewUrlTemplate = "https://evil.test"),
    (j) =>
      (j.testingProfile.previewUrlTemplate =
        "https://secret@pr-7.preview.test"),
    (j) => (j.testingProfile.browsers = ["webkit"]),
    (j) => (j.settings.maxCostUsd = 3),
    (j) => (j.settings.allowImages = true),
    (j) => (j.testingProfile.allowMutations = true),
    (j) => (j.command = "arbitrary command"),
    (j) => (j.testingProfile.pages = ["/\\evil.test"]),
    (j) => (j.testingProfile.goals.goals = []),
  ];
  for (const change of changes) {
    const input = job();
    change(input);
    assert.throws(() => validateJob(input, parsed));
  }
  assert.throws(() => validatePortalPolicy({ ...policy, maxGoals: 100 }));
});
test("report serialization never turns empty/contradictory automated counts into a pass", () => {
  const run = {
    repository: policy.repository,
    revision,
    pr: { number: 7 },
    plan: { checks: [{ id: "ui", method: "automated", required: true }] },
    results: [
      { checkId: "ui", status: "passed", counts: { tests: 0, passed: 0 } },
    ],
  };
  assert.equal(portalReport(run, job()).checks[0].status, "blocked");
  run.results[0].revision = revision;
  run.results[0].counts = {
    tests: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  assert.equal(portalReport(run, job()).checks[0].status, "passed");
  assert.throws(() =>
    portalReport({ ...run, revision: "b".repeat(40) }, job()),
  );
});
test("bridge fixes local paths, preserves source, caps calls and emits only bounded report data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-portal-bridge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const product = path.join(root, "product");
  await fs.mkdir(product);
  await fs.writeFile(path.join(product, "README.md"), "Original product");
  const git = (args) =>
    execFileSync("git", ["-C", product, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "main"]);
  git(["add", "README.md"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Fixture",
  ]);
  const configPath = path.join(root, "qa-config.json"),
    policyPath = path.join(root, "policy.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      ai: {
        ...DEFAULT_AI_CONFIG,
        enabled: true,
        model: "vendor/example",
        roles: ["planner"],
        maxCostUsd: 0.5,
        maxCallsPerRun: 3,
      },
      runners: [],
    }),
  );
  const input = job();
  input.revision = git(["rev-parse", "HEAD"]);
  const enrolled = {
    ...policy,
    repoCheckout: product,
    configPath,
    regressionDir: path.join(root, "regressions"),
  };
  const report = await runPortal({
    job: input,
    policy: enrolled,
    policyPath,
    outputDir: path.join(root, "job"),
    runAutonomous: async ({ options }) => {
      assert.equal(options.head, input.revision);
      assert.equal(options.repo, product);
      assert.equal(options["rerun-token"], input.id);
      const config = JSON.parse(await fs.readFile(options.config, "utf8"));
      assert.equal(config.ai.maxCostUsd, 0.5);
      assert.equal(config.ai.maxCallsPerRun, 3);
      assert.equal(config.targetAccess, "read-only");
      assert.equal(config.enabled, false);
      return {
        repository: input.repository,
        revision: input.revision,
        pr: input.pr,
        plan: { checks: [{ id: "goal", method: "automated" }] },
        results: [
          {
            checkId: "goal",
            status: "failed",
            counts: { tests: 1, passed: 0, failed: 1, skipped: 0 },
            details: "Expected greeting missing",
          },
        ],
      };
    },
  });
  assert.equal(report.checks[0].status, "failed");
  assert.equal(
    await fs.readFile(path.join(product, "README.md"), "utf8"),
    "Original product",
  );
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(root, "job/portal-run.json"), "utf8"),
    ).recordId,
    report.recordId,
  );
  await fs.symlink(product, path.join(root, "escape"));
  await assert.rejects(
    runPortal({
      job: input,
      policy: enrolled,
      policyPath,
      outputDir: path.join(root, "escape/output"),
    }),
    /outside the product/,
  );
  const preflight = await preflightPortal({
    policy: enrolled,
    policyPath,
    env: {},
  });
  assert.ok(
    preflight.missing.some((value) => value.includes("OPENROUTER_API_KEY")),
  );
});

test("goal validation includes implicit start pages even with discovery disabled and refuses executable assertions", () => {
  const parsed = validatePortalPolicy(policy);
  for (const mutate of [
    (value) => {
      value.testingProfile.maxPages = 1;
      value.testingProfile.discoverPages = false;
      value.testingProfile.goals.goals[0].start = "/second";
    },
    (value) => {
      value.testingProfile.goals.goals[0].assertions[0].action = "evaluate";
    },
    (value) => {
      value.testingProfile.goals.goals[0].assertions[0].exact = "false";
    },
    (value) => {
      value.testingProfile.goals.goals[0].inputs = {
        credential: 'api_key="secret-value"',
      };
    },
  ]) {
    const value = job();
    mutate(value);
    assert.throws(() => validateJob(value, parsed));
  }
});

test("missing goal replays, stale per-check revisions, and conflicting duplicate execution results cannot pass portal coverage", () => {
  const run = {
    repository: policy.repository,
    revision,
    pr: { number: 7 },
    plan: { checks: [{ id: "goal-home", method: "automated" }] },
    results: [
      {
        checkId: "goal-home",
        revision,
        status: "passed",
        counts: { tests: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0 },
      },
    ],
    ai: { latest: { cost: 0.02, budget: { calls: 2 } } },
  };
  const report = portalReport(run, job());
  assert.equal(
    report.checks.find((check) => check.id === "replay-home").status,
    "blocked",
  );
  assert.equal(report.ai.calls, 2);
  assert.equal(report.ai.costUsd, 0.02);
  assert.equal(
    portalReport(
      { ...run, results: [{ ...run.results[0], revision: "b".repeat(40) }] },
      job(),
    ).checks[0].status,
    "blocked",
  );
  assert.throws(
    () =>
      portalReport(
        {
          ...run,
          results: [run.results[0], { ...run.results[0], status: "failed" }],
        },
        job(),
      ),
    /distinct/,
  );
  assert.ok(
    portalReport(
      { ...run, plan: { checks: [] }, results: [] },
      job(),
    ).checks.every((check) => check.status === "blocked"),
  );
});

async function productFixture(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const product = path.join(root, "product");
  await fs.mkdir(product);
  await fs.writeFile(
    path.join(product, "app.js"),
    'export const greeting = "Original product";\n',
  );
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-C", product, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Synthetic fixture",
  );
  return { root, product, git, revision: git("rev-parse", "HEAD") };
}

test("interrupted portal jobs retain their local policy/config/base identity instead of silently gaining a new inference budget", async (t) => {
  const f = await productFixture(t, "qa-portal-interrupted-");
  const configPath = path.join(f.root, "config.json"),
    policyPath = path.join(f.root, "policy.json");
  const config = {
    ai: {
      ...DEFAULT_AI_CONFIG,
      enabled: true,
      model: "vendor/example",
      roles: ["planner"],
      maxOutputTokens: 512,
    },
    runners: [],
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  const enrolled = {
    ...policy,
    repoCheckout: f.product,
    configPath,
    regressionDir: path.join(f.root, "regressions"),
  };
  const input = job();
  input.revision = f.revision;
  let invocations = 0;
  const options = {
    job: input,
    policy: enrolled,
    policyPath,
    outputDir: path.join(f.root, "output"),
    runAutonomous: async ({ options }) => {
      invocations++;
      assert.equal(options.base, f.revision);
      throw new Error("Synthetic interrupted run");
    },
  };
  await assert.rejects(runPortal(options), /interrupted/);
  config.ai.maxOutputTokens = 768;
  await fs.writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runPortal(options), /reserved budget/);
  assert.equal(invocations, 1);
  config.ai.maxOutputTokens = 512;
  await fs.writeFile(configPath, JSON.stringify(config));
  const changed = structuredClone(input);
  changed.settings.maxCallsPerRun--;
  await assert.rejects(
    runPortal({ ...options, job: changed }),
    /reserved budget/,
  );
  assert.equal(invocations, 1);
  await assert.rejects(
    runPortal({ ...options, policy: { ...enrolled, allowImages: true } }),
    /reserved budget/,
  );
  assert.equal(invocations, 1);
  await fs.writeFile(
    path.join(f.product, "app.js"),
    'export const greeting = "New commit";\n',
  );
  f.git("add", ".");
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Move base",
  );
  await assert.rejects(runPortal(options), /reserved budget/);
  assert.equal(invocations, 1);
});

test("baseline archives never execute product-configured compression helpers and use immutable source in container mode", async (t) => {
  const f = await productFixture(t, "qa-baseline-archive-");
  await fs.mkdir(path.join(f.product, "test"));
  await fs.writeFile(
    path.join(f.product, "test/required.js"),
    "Required test must not disappear.\n",
  );
  await fs.writeFile(path.join(f.product, "format.txt"), "$Format:%H$\n");
  const attributes =
    "app.js export-ignore\ntest/** export-ignore\n*.txt export-subst\n";
  await fs.writeFile(path.join(f.product, ".gitattributes"), attributes);
  f.git("add", ".");
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Archive attributes must not alter snapshot",
  );
  f.revision = f.git("rev-parse", "HEAD");
  await fs.writeFile(
    path.join(f.product, "app.js"),
    "Replaced object must not be tested.\n",
  );
  f.git("add", ".");
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Replacement object",
  );
  f.git("replace", f.revision, f.git("rev-parse", "HEAD"));
  await fs.writeFile(path.join(f.product, ".git/info/attributes"), attributes);
  const marker = path.join(f.root, "host-command-executed");
  const quoted = "'" + marker.replaceAll("'", "'\\''") + "'";
  f.git("config", "tar.tar.gz.command", "touch " + quoted);
  await fs.writeFile(
    path.join(f.product, "app.js"),
    "Uncommitted user changes must remain untouched.",
  );
  const before = f.git("status", "--porcelain");
  let executed = false;
  const { executeBaseline } = require("../src/autonomy/baseline");
  const outputDir = path.join(f.root, "evidence");
  const result = await executeBaseline({
    repo: f.product,
    revision: f.revision,
    repository: policy.repository,
    prNumber: 7,
    runId: "synthetic-baseline",
    config: { runners: [], execution: { isolation: "process" } },
    outputDir,
    checks: [{ id: "unit", runnerId: "unit", method: "automated" }],
    execute: async (options) => {
      executed = true;
      assert.equal(options.isolation, "container");
      assert.equal(options.config.execution.isolation, "container");
      assert.notEqual(options.cwd, f.product);
      assert.equal(options.plan.checks[0].runner, "unit");
      assert.match(
        await fs.readFile(path.join(options.cwd, "app.js"), "utf8"),
        /Original product/,
      );
      assert.equal(
        await fs.readFile(path.join(options.cwd, "format.txt"), "utf8"),
        "$Format:%H$\n",
      );
      assert.equal(
        await fs.readFile(path.join(options.cwd, "test/required.js"), "utf8"),
        "Required test must not disappear.\n",
      );
      const attestation = JSON.parse(
        await fs.readFile(options.sourceAttestation, "utf8"),
      );
      assert.equal(attestation.revision, f.revision);
      assert.equal(attestation.repository, policy.repository);
      return {
        results: [
          {
            checkId: "unit",
            status: "passed",
            counts: {
              tests: 1,
              passed: 1,
              failed: 0,
              skipped: 0,
              cancelled: 0,
            },
          },
        ],
      };
    },
  });
  assert.equal(executed, true);
  assert.equal(result.results[0].status, "passed");
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(
    await fs.readFile(path.join(f.product, "app.js"), "utf8"),
    "Uncommitted user changes must remain untouched.",
  );
});

test(
  "real portal bridge uses the local model HTTP adapter, executes Chromium goal/replay, and reuses completed evidence without new calls",
  { skip: process.env.QA_PORTAL_BROWSER_TEST !== "1", timeout: 120000 },
  async (t) => {
    const http = require("node:http");
    const f = await productFixture(t, "qa-portal-real-");
    let modelCalls = 0,
      previewRequests = 0;
    const model = http.createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      assert.equal(
        request.headers.authorization,
        "Bearer synthetic-local-token",
      );
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "fixture-local" }] }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      assert.equal(payload.model, "fixture-local");
      assert.equal(payload.provider, undefined);
      modelCalls++;
      const context = JSON.parse(
        payload.messages.find((message) => message.role === "user").content,
      );
      const button = context.observedPages
        .flatMap((page) => page.elements)
        .find((element) => element.selector === "#continue");
      const proposal = {
        candidates: [
          {
            goalId: "continue",
            steps: [
              { action: "click", targetId: button.targetId },
              { action: "assert", assertionId: "complete" },
            ],
          },
        ],
        limitations: [],
      };
      response.end(
        JSON.stringify({
          model: "fixture-local",
          choices: [
            {
              message: { role: "assistant", content: JSON.stringify(proposal) },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 30,
            total_tokens: 110,
          },
        }),
      );
    });
    const preview = http.createServer((_request, response) => {
      previewRequests++;
      response.writeHead(200, {
        "content-type": "text/html",
        "x-qa-revision": f.revision,
      });
      response.end(
        '<!doctype html><html lang="en"><head><title>Bridge fixture</title><link rel="icon" href="data:,"><style>body{font:18px Arial;color:#111;background:white;margin:24px}button{font:inherit;padding:12px}</style></head><body><main><h1>QA bridge fixture</h1><button id="continue" type="button">Continue</button><p id="result" role="status">Ready</p><script>document.getElementById("continue").onclick=()=>document.getElementById("result").textContent="Complete";</script></main></body></html>',
      );
    });
    for (const server of [model, preview]) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      t.after(
        () =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      );
    }
    const configPath = path.join(f.root, "config.json"),
      policyPath = path.join(f.root, "policy.json");
    const config = {
      ai: {
        ...DEFAULT_AI_CONFIG,
        enabled: true,
        backend: "local",
        model: "fixture-local",
        roles: ["planner"],
        roleModels: {},
        maxToolRounds: 0,
        maxOutputTokens: 512,
        maxCallsPerRun: 2,
        maxCostUsd: 0,
        allowImages: false,
        local: {
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          models: [
            {
              id: "fixture-local",
              contextLength: 100000,
              tools: true,
              vision: false,
            },
          ],
        },
      },
      runners: [],
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const previewUrl = `http://127.0.0.1:${preview.address().port}`;
    const enrolled = {
      ...policy,
      repoCheckout: f.product,
      configPath,
      regressionDir: path.join(f.root, "regressions"),
      allowedPreviewOrigins: [previewUrl],
      allowedBackends: ["local"],
      maxCostUsd: 0,
      maxCallsPerRun: 2,
    };
    const input = job();
    input.revision = f.revision;
    input.settings = {
      backend: "local",
      model: "fixture-local",
      roles: ["planner"],
      roleModels: {},
      maxCostUsd: 0,
      maxCallsPerRun: 2,
      allowImages: false,
    };
    input.testingProfile = {
      previewUrlTemplate: previewUrl,
      pages: ["/"],
      discoverPages: true,
      maxPages: 1,
      browsers: ["chromium"],
      goals: {
        schemaVersion: 1,
        goals: [
          {
            id: "continue",
            name: "Continue",
            start: "/",
            requirement: "Continue reports completion",
            assertions: [
              {
                id: "complete",
                action: "expectText",
                selector: "#result",
                text: "Complete",
                exact: true,
              },
            ],
          },
        ],
      },
    };
    const env = {
      ...process.env,
      LOCAL_MODEL_API_KEY: "synthetic-local-token",
      OPENROUTER_API_KEY: "must-not-reach-local-server",
    };
    if (process.platform === "darwin" && !env.QA_BROWSER_EXECUTABLE) {
      try {
        await fs.access(require("playwright-core").chromium.executablePath());
      } catch {
        env.QA_BROWSER_EXECUTABLE =
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      }
    }
    const options = {
      job: input,
      policy: enrolled,
      policyPath,
      outputDir: path.join(f.root, "output"),
      env,
    };
    const report = await runPortal(options);
    assert.ok(report.checks.length >= 4);
    assert.ok(
      report.checks.every((check) => check.status === "passed"),
      JSON.stringify(report.checks),
    );
    assert.equal(report.ai.calls, 1);
    assert.equal(report.ai.costUsd, 0);
    assert.equal(modelCalls, 1);
    const requestsAfterFirst = previewRequests;
    const reused = await runPortal({
      ...options,
      outputDir: path.join(f.root, "reused-output"),
    });
    assert.equal(reused.recordId, report.recordId);
    assert.equal(modelCalls, 1);
    assert.equal(previewRequests, requestsAfterFirst);
    assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(f.git("rev-parse", "HEAD"), f.revision);
    assert.equal(
      await fs.readFile(path.join(f.product, "app.js"), "utf8"),
      'export const greeting = "Original product";\n',
    );
  },
);
