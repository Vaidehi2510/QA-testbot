// Real browser verification against disposable synthetic pages. No models or product checkout.
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { runWebAudit } = require("./audit");
const { acceptBaseline } = require("./visual");
const { approveRepairs } = require("./maintenance");
async function main() {
  const revision = "a".repeat(40),
    metadata = { repository: "fixture/browser-matrix", prNumber: 1, revision };
  let changed = false,
    logoutRequests = 0,
    outsideRequests = 0;
  const outside = http.createServer((_req, res) => {
    outsideRequests++;
    res.end("Outside origin");
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/logout") logoutRequests++;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/redirect-hop" });
      res.end();
      return;
    }
    if (req.url === "/redirect-hop") {
      res.writeHead(302, {
        location: `http://127.0.0.1:${outside.address().port}/`,
      });
      res.end();
      return;
    }
    if (req.url === "/allowed-redirect") {
      res.writeHead(302, {
        location: "/details?cookies=1",
        "set-cookie": [
          "first=one; Path=/; SameSite=Lax",
          "second=two; Path=/; SameSite=Lax",
        ],
      });
      res.end();
      return;
    }
    if (
      req.url === "/details?cookies=1" &&
      (!req.headers.cookie?.includes("first=one") ||
        !req.headers.cookie?.includes("second=two"))
    ) {
      res.writeHead(400);
      res.end("Missing cookie");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "x-qa-revision": revision,
    });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Browser fixture</title><link rel="icon" href="data:,"><style>*{box-sizing:border-box}body{margin:24px;font:16px Arial;color:#111;background:#fff}h1{font-size:24px}button{padding:12px;font:inherit;color:white;background:#333;border:0}a{color:#34347a}.tile{height:40px;width:100px;background:${changed ? "#ed345e" : "#ddd"}}</style></head><body><main><h1>${req.url === "/details" ? "Details" : "Store"}</h1><p>Disposable QA browser fixture.</p><a href="/details">View details</a> <a href="/logout">Sign out</a> <a href="https://outside.invalid/">External</a><div class="tile"></div><button id="new-continue" type="button">Continue</button><p id="result" role="status" aria-label="Progress">Ready</p><button id="open-login" type="button" aria-haspopup="dialog">Open sign in</button><dialog id="login-dialog" aria-label="Sign in"><h2>Sign in</h2><label for="email">Email</label><input id="email" type="email"><label for="password">Password</label><input id="password" type="password" value="never-record-this-password"><button id="close-login" type="button">Close</button></dialog><script>document.getElementById('open-login').onclick=()=>document.getElementById('login-dialog').showModal();document.getElementById('close-login').onclick=()=>document.getElementById('login-dialog').close();document.getElementById('new-continue').onclick=()=>document.getElementById('result').textContent='${req.url === "/incorrect" ? "Complete incorrectly" : "Complete"}';</script></main></body></html>`,
    );
  });
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "qa-web-advanced-"),
  );
  let failed = false;
  try {
    await new Promise((resolve, reject) => {
      outside.once("error", reject);
      outside.listen(0, "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const suite = {
      targetEnvironment: "preview",
      url: `http://127.0.0.1:${server.address().port}`,
      pages: ["/"],
      browsers: ["chromium", "firefox", "webkit"],
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      timeoutMs: 10000,
      discovery: { enabled: true, maxPages: 3, maxDepth: 1 },
      visual: {
        baselineDir: path.join(directory, "baselines"),
        maxSnapshots: 12,
      },
    };
    const run = async (label, settings = suite) => {
      const outputDir = path.join(directory, label);
      const evidence = await runWebAudit({
        suite: settings,
        metadata,
        outputDir,
        checkId: "matrix-fixture",
      });
      await fs.writeFile(
        path.join(directory, label + ".json"),
        JSON.stringify(evidence, null, 2),
      );
      return { evidence, outputDir };
    };
    const first = await run("baseline-candidates");
    assert.equal(
      first.evidence.result.status,
      "blocked",
      JSON.stringify(
        first.evidence.observations.filter((o) => o.status !== "passed"),
      ),
    );
    assert.deepEqual(
      [...new Set(first.evidence.inventory.map((i) => i.browser))].sort(),
      suite.browsers.slice().sort(),
      "All requested engines must actually run",
    );
    assert.ok(first.evidence.inventory.some((i) => i.path === "/details"));
    assert.equal(logoutRequests, 0);
    assert.equal(first.evidence.visualResults.length, 6);
    for (const candidate of first.evidence.visualResults)
      await acceptBaseline({
        candidatePath: path.join(first.outputDir, candidate.candidatePath),
        baselineDir: suite.visual.baselineDir,
        expectedRevision: revision,
        approvedBy: "Synthetic fixture QA",
      });
    console.log(
      "[REAL matrix] Chromium, Firefox, and WebKit discovered /details, excluded logout/external links, and blocked six missing baselines. Explicit fixture approval accepted them.",
    );
    const repeated = await run("baseline-replay");
    assert.equal(
      repeated.evidence.result.status,
      "passed",
      JSON.stringify(
        repeated.evidence.observations.filter((o) => o.status !== "passed"),
      ),
    );
    changed = true;
    const regression = await run("visual-regression");
    assert.equal(regression.evidence.result.status, "failed");
    assert.equal(
      regression.evidence.visualResults.filter((r) => r.status === "failed")
        .length,
      6,
    );
    console.log(
      "[REAL matrix] Independent screenshots match accepted baselines; a changed tile fails all six comparisons and produces PNG diffs.",
    );
    changed = false;
    const journeySuite = {
      ...suite,
      discovery: { enabled: false },
      visual: false,
      browsers: ["chromium"],
      journeys: [
        {
          name: "continue",
          start: "/",
          steps: [
            {
              action: "click",
              selector: "#removed-continue",
              fallback: {
                role: "button",
                name: "Continue",
                tag: "button",
                type: "button",
              },
            },
            {
              action: "expectText",
              role: "status",
              name: "Progress",
              text: "Complete",
              exact: true,
            },
          ],
        },
      ],
    };
    const a = await run("repair-first", journeySuite),
      b = await run("repair-replay", journeySuite);
    assert.equal(a.evidence.result.status, "passed");
    assert.equal(b.evidence.result.status, "passed");
    assert.equal(a.evidence.repairs.length, 1);
    const repaired = await approveRepairs({
      originalSuite: journeySuite,
      proposals: a.evidence.repairs,
      firstEvidence: a.evidence,
      replayEvidence: b.evidence,
      approvedBy: "Synthetic fixture QA",
      outputPath: path.join(directory, "approved-suite.json"),
    });
    assert.equal(repaired.journeys[0].steps[1].text, "Complete");
    console.log(
      "[REAL Chromium] Missing CSS selector used its exact unique semantic contract; two independent runs passed before an explicitly approved copy was persisted. Assertions unchanged.",
    );
    const expanded = await run("expanded-controls", {
      ...suite,
      visual: false,
      discovery: {
        enabled: true,
        exploreControls: true,
        maxPages: 1,
        maxDepth: 0,
        maxStates: 12,
      },
    });
    assert.equal(
      expanded.evidence.result.status,
      "passed",
      JSON.stringify(
        expanded.evidence.observations.filter((o) => o.status !== "passed"),
      ),
    );
    for (const browser of suite.browsers) {
      const state = expanded.evidence.inventory.find(
        (i) => i.browser === browser && i.navigationSteps.length,
      );
      assert.ok(state, "Every engine must discover the modal state");
      assert.equal(state.navigationSteps[0].selector, "#open-login");
      assert.ok(
        state.elements.some(
          (el) => el.selector === "#password" && el.type === "password",
        ),
      );
      assert.equal(state.startPath, "/");
    }
    assert.doesNotMatch(
      JSON.stringify(expanded.evidence.inventory),
      /never-record-this-password/,
    );
    console.log(
      "[REAL matrix] Bounded dialog expansion records the navigation hint and newly visible email/password controls without recording input values.",
    );
    const incorrectSuite = {
      ...journeySuite,
      pages: ["/incorrect"],
      timeoutMs: 1000,
      journeys: [{ ...journeySuite.journeys[0], start: "/incorrect" }],
    };
    const incorrect = await run("exact-assertion", incorrectSuite);
    assert.equal(incorrect.evidence.result.status, "failed");
    assert.ok(
      incorrect.evidence.observations.some(
        (o) =>
          o.status === "failed" && o.details.includes("Exact expected text"),
      ),
    );
    console.log(
      "[REAL Chromium] Exact assertions reject a misleading success-prefix message.",
    );
    for (const browser of suite.browsers) {
      const allowed = await run("allowed-redirect-" + browser, {
        ...suite,
        browsers: [browser],
        pages: ["/allowed-redirect"],
        discovery: { enabled: false },
        visual: false,
      });
      assert.equal(
        allowed.evidence.result.status,
        "passed",
        JSON.stringify(
          allowed.evidence.observations.filter((o) => o.status !== "passed"),
        ),
      );
      const redirected = await run("redirect-" + browser, {
        ...suite,
        browsers: [browser],
        pages: ["/redirect"],
        discovery: { enabled: false },
        visual: false,
      });
      assert.notEqual(redirected.evidence.result.status, "passed");
      assert.equal(outsideRequests, 0);
    }
    console.log(
      "[REAL matrix] All three browser engines followed allowed redirects and refused two-hop redirects to an unlisted origin. No product files or model APIs used.",
    );
  } catch (error) {
    failed = true;
    console.error(`Advanced fixture evidence retained at ${directory}`);
    error.keepEvidence = true;
    throw error;
  } finally {
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => outside.close(resolve)),
    ]);
    if (!failed && !process.env.QA_KEEP_BROWSER_DEMO)
      await fs.rm(directory, { recursive: true, force: true });
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
