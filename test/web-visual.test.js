const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PNG } = require("pngjs");
const {
  comparePng,
  compareScreenshot,
  acceptBaseline,
  safeDirectory,
} = require("../src/web/visual");
const revision = "a".repeat(40),
  identity = {
    repository: "fixture/shop",
    browser: "chromium",
    viewport: "mobile",
    pagePath: "/",
  };
const pixels = (width = 2, height = 2, color = [255, 255, 255, 255]) => {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set(color, i);
  return PNG.sync.write(png);
};
async function dir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-visual-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test("PNG comparisons are deterministic, detect pixel and dimension changes, and respect explicit tolerance", () => {
  const white = pixels(),
    black = pixels(2, 2, [0, 0, 0, 255]);
  const same = comparePng(white, white);
  assert.equal(same.status, "passed");
  assert.equal(same.differentPixels, 0);
  assert.equal(comparePng(white, black).diffRatio, 1);
  assert.equal(comparePng(white, pixels(1, 4)).dimensionsMatch, false);
  assert.deepEqual(
    comparePng(white, black).diff,
    comparePng(white, black).diff,
  );
  assert.equal(
    comparePng(white, pixels(2, 2, [254, 255, 255, 255]), {
      pixelThreshold: 1 / 255,
    }).status,
    "passed",
  );
  assert.throws(() => comparePng(Buffer.alloc(100), white), /PNG/);
  assert.throws(
    () => comparePng(white, white, { maxDiffRatio: 1 }),
    /tolerance/,
  );
});
test("missing baselines block until explicit exact-SHA acceptance; a failing comparison cannot overwrite them", async (t) => {
  const root = await dir(t),
    baselineDir = path.join(root, "baselines"),
    outputDir = path.join(root, "run1");
  const options = {
    baselineDir,
    identity,
    metadata: {
      repository: identity.repository,
      revision,
      revisionVerified: true,
    },
  };
  const first = await compareScreenshot({
    ...options,
    outputDir,
    bytes: pixels(),
  });
  assert.equal(first.status, "blocked");
  await assert.rejects(fs.stat(baselineDir), /ENOENT/);
  await assert.rejects(
    acceptBaseline({
      candidatePath: path.join(outputDir, first.candidatePath),
      baselineDir,
      expectedRevision: "b".repeat(40),
      approvedBy: "QA",
    }),
    /identity/,
  );
  await acceptBaseline({
    candidatePath: path.join(outputDir, first.candidatePath),
    baselineDir,
    expectedRevision: revision,
    approvedBy: "Fixture QA",
  });
  const saved = await fs.readFile(
    path.join(baselineDir, first.key + ".json"),
    "utf8",
  );
  assert.equal(
    (
      await compareScreenshot({
        ...options,
        outputDir: path.join(root, "run2"),
        bytes: pixels(),
      })
    ).status,
    "passed",
  );
  const changed = await compareScreenshot({
    ...options,
    outputDir: path.join(root, "run3"),
    bytes: pixels(2, 2, [0, 0, 0, 255]),
  });
  assert.equal(changed.status, "failed");
  assert.ok(changed.diffPath);
  assert.equal(
    await fs.readFile(path.join(baselineDir, first.key + ".json"), "utf8"),
    saved,
  );
  await assert.rejects(
    acceptBaseline({
      candidatePath: path.join(outputDir, first.candidatePath),
      baselineDir,
      expectedRevision: revision,
      approvedBy: "Fixture QA",
    }),
    /changed after/,
  );
});
test("baseline store rejects symlinks, tampered candidates, unbound revisions, and linked files", async (t) => {
  const root = await dir(t),
    outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "alias"));
  await assert.rejects(
    safeDirectory(path.join(root, "alias", "nested"), true),
    /symbolic/,
  );
  const options = {
    baselineDir: path.join(root, "baseline"),
    identity,
    metadata: { revision, revisionVerified: true },
    outputDir: path.join(root, "output"),
    bytes: pixels(),
  };
  await assert.rejects(
    compareScreenshot({
      ...options,
      metadata: { revision, revisionVerified: false },
    }),
    /verified/,
  );
  const candidate = await compareScreenshot(options),
    candidatePath = path.join(options.outputDir, candidate.candidatePath);
  const record = JSON.parse(await fs.readFile(candidatePath, "utf8"));
  record.sha256 = "b".repeat(64);
  await fs.writeFile(candidatePath, JSON.stringify(record));
  await assert.rejects(
    acceptBaseline({
      candidatePath,
      baselineDir: options.baselineDir,
      expectedRevision: revision,
      approvedBy: "QA",
    }),
    /digest/,
  );
});
module.exports = { pixels };
