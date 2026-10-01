const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validateWebSuite } = require("../src/web/audit");
const crypto = require("node:crypto");
const {
  resolveStepLocator,
  approveRepairs,
  validateFallback,
} = require("../src/web/maintenance");
const revision = "a".repeat(40),
  step = {
    action: "expectText",
    selector: "#old",
    text: "Saved",
    fallback: { role: "status", name: "Save state", tag: "p" },
  };
function page({
  primary = 0,
  semantic = 1,
  visible = true,
  tag = "p",
  same = true,
} = {}) {
  const fallback = {
    count: async () => semantic,
    isVisible: async () => visible,
    evaluate: async () => ({ tag, type: null }),
    elementHandle: async () => ({}),
  };
  return {
    fallback,
    locator: () => ({ count: async () => primary, evaluate: async () => same }),
    getByRole: () => fallback,
  };
}
test("semantic repair only applies to an absent locator and exactly one declared visible target", async () => {
  const repairs = [],
    fixture = page();
  assert.equal(
    await resolveStepLocator(fixture, step, {
      repairs,
      journey: "save",
      stepIndex: 0,
      revision,
    }),
    fixture.fallback,
  );
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].replacement.text, "Saved");
  assert.equal(repairs[0].persisted, false);
  for (const options of [
    { primary: 2 },
    { semantic: 2 },
    { semantic: 0 },
    { visible: false },
    { tag: "button" },
    { primary: 1, same: false },
    { primary: 1, tag: "button" },
  ])
    await assert.rejects(resolveStepLocator(page(options), step));
  assert.throws(() =>
    validateFallback({ ...step, fallback: { role: "button", name: "" } }),
  );
});
test("persistent repairs require explicit approval and independent passing replay without weakened assertions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-repair-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repairs = [];
  await resolveStepLocator(page(), step, {
    repairs,
    journey: "save",
    stepIndex: 0,
    revision,
    browser: "chromium",
    viewport: "desktop",
  });
  const originalSuite = {
    targetEnvironment: "preview",
    url: "http://127.0.0.1:8080",
    browsers: ["chromium", "firefox"],
    journeys: [{ name: "save", start: "/", steps: [step] }],
  };
  const metadata = { repository: "fixture/repair", prNumber: 1, revision };
  const suiteDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(validateWebSuite(originalSuite, metadata)))
    .digest("hex");
  const firstEvidence = {
    runId: "run-a",
    suiteDigest,
    ...metadata,
    checkId: "web-fixture",
    revisionVerified: true,
    result: { status: "passed" },
    repairs,
  };
  const replayEvidence = { ...firstEvidence, runId: "run-b" };
  const options = {
    originalSuite,
    proposals: repairs,
    firstEvidence,
    replayEvidence,
    approvedBy: "Fixture QA",
    outputPath: path.join(root, "repaired.json"),
  };
  await assert.rejects(
    approveRepairs({ ...options, approvedBy: "" }),
    /approval/,
  );
  await assert.rejects(
    approveRepairs({ ...options, replayEvidence: firstEvidence }),
    /independent/,
  );
  await assert.rejects(
    approveRepairs({
      ...options,
      replayEvidence: { ...replayEvidence, result: { status: "failed" } },
    }),
    /successful/,
  );
  await assert.rejects(
    approveRepairs({
      ...options,
      proposals: [
        {
          ...repairs[0],
          replacement: { ...repairs[0].replacement, text: "Anything" },
        },
      ],
    }),
    /alter/,
  );
  await assert.rejects(
    approveRepairs({
      ...options,
      originalSuite: { ...originalSuite, pages: ["/different"] },
    }),
    /start path|digest/,
  );
  await assert.rejects(
    approveRepairs({
      ...options,
      firstEvidence: { ...firstEvidence, suiteDigest: "wrong" },
      replayEvidence: { ...replayEvidence, suiteDigest: "wrong" },
    }),
    /digest/,
  );
  await assert.rejects(
    approveRepairs({
      ...options,
      proposals: [{ ...repairs[0], revision: "b".repeat(40) }],
    }),
    /identity or revision/,
  );
  await assert.rejects(
    approveRepairs({
      ...options,
      proposals: [{ ...repairs[0], id: "forged" }],
    }),
    /identity or revision/,
  );
  await assert.rejects(
    approveRepairs({
      ...options,
      replayEvidence: {
        ...replayEvidence,
        repairs: [
          {
            ...repairs[0],
            replacement: { ...repairs[0].replacement, text: "Changed" },
          },
        ],
      },
    }),
    /both replay/,
  );
  const duplicate = { ...repairs[0], browser: "firefox" };
  repairs.push(duplicate);
  const suite = await approveRepairs(options);
  assert.equal(suite.journeys[0].steps[0].text, "Saved");
  assert.equal(suite.journeys[0].steps[0].selector, undefined);
  assert.equal(suite.journeys[0].steps[0].role, "status");
  await assert.rejects(approveRepairs(options), /EEXIST/);
});
