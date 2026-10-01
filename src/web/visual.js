const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PNG } = require("pngjs");
const { screenshotType } = require("../images");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const IMAGE_LIMIT = 2 * 1024 * 1024,
  STORE_LIMIT = 128 * 1024 * 1024;
async function safeDirectory(directory, create = false) {
  const absolute = path.resolve(directory),
    parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (e) {
      if (e.code !== "ENOENT" || !create) throw e;
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink()) {
      // macOS's system aliases are fixed, not a user-supplied store shortcut.
      const real = await fs.realpath(current);
      if (
        !(
          (current === "/tmp" && real === "/private/tmp") ||
          (current === "/var" && real === "/private/var")
        )
      )
        throw new Error("Evidence stores cannot traverse symbolic links");
    } else if (!stat.isDirectory())
      throw new Error("Evidence store path is not a directory");
  }
  return fs.realpath(absolute);
}
function filename(value) {
  if (
    typeof value !== "string" ||
    !value ||
    path.basename(value) !== value ||
    value === "." ||
    value === ".." ||
    value.length > 180
  )
    throw new Error("Unsafe evidence filename");
  return value;
}
async function readBounded(directory, name, limit) {
  const root = await safeDirectory(directory),
    handle = await fs.open(
      path.join(root, filename(name)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new Error(
        "Evidence file is oversized, linked, or not a regular file",
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function writeExclusive(directory, name, bytes) {
  const root = await safeDirectory(directory, true),
    handle = await fs.open(
      path.join(root, filename(name)),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
function decode(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > IMAGE_LIMIT ||
    screenshotType(bytes)?.mimeType !== "image/png"
  )
    throw new Error("Visual comparison requires a bounded valid PNG");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width * height > 4200000)
    throw new Error("Visual image exceeds the configured pixel limit");
  return PNG.sync.read(bytes, { checkCRC: true });
}
function comparePng(
  expected,
  actual,
  { pixelThreshold = 0, maxDiffRatio = 0 } = {},
) {
  if (
    !Number.isFinite(pixelThreshold) ||
    pixelThreshold < 0 ||
    pixelThreshold > 1 ||
    !Number.isFinite(maxDiffRatio) ||
    maxDiffRatio < 0 ||
    maxDiffRatio > 0.25
  )
    throw new Error("Invalid visual tolerance");
  const a = decode(expected),
    b = decode(actual),
    width = Math.max(a.width, b.width),
    height = Math.max(a.height, b.height);
  if (width * height > 4200000)
    throw new Error("Visual diff exceeds pixel limit");
  const output = new PNG({ width, height }),
    limit = Math.round(pixelThreshold * 255);
  let different = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4,
        ai = (y * a.width + x) * 4,
        bi = (y * b.width + x) * 4;
      const missing =
        x >= a.width || y >= a.height || x >= b.width || y >= b.height;
      const differs =
        missing ||
        [0, 1, 2, 3].some(
          (c) => Math.abs(a.data[ai + c] - b.data[bi + c]) > limit,
        );
      if (differs) {
        different++;
        output.data.set([218, 50, 111, 255], offset);
      } else {
        const gray = Math.round(
          (b.data[bi] + b.data[bi + 1] + b.data[bi + 2]) / 3,
        );
        output.data.set([gray, gray, gray, 95], offset);
      }
    }
  const ratio = different / (width * height),
    dimensionsMatch = a.width === b.width && a.height === b.height;
  return {
    status: dimensionsMatch && ratio <= maxDiffRatio ? "passed" : "failed",
    differentPixels: different,
    totalPixels: width * height,
    diffRatio: ratio,
    dimensionsMatch,
    width,
    height,
    diff: PNG.sync.write(output, {
      colorType: 6,
      filterType: 4,
      deflateLevel: 9,
    }),
  };
}
function validateVisual(value) {
  if (value === undefined || value === false) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "baselineDir",
          "pixelThreshold",
          "maxDiffRatio",
          "maxSnapshots",
        ].includes(k),
    )
  )
    throw new Error("Invalid visual baseline settings");
  if (
    typeof value.baselineDir !== "string" ||
    !path.isAbsolute(value.baselineDir)
  )
    throw new Error(
      "Visual baselines require an absolute bot-owned baselineDir",
    );
  const result = {
    pixelThreshold: 0,
    maxDiffRatio: 0,
    maxSnapshots: 24,
    ...value,
  };
  if (
    !Number.isFinite(result.pixelThreshold) ||
    result.pixelThreshold < 0 ||
    result.pixelThreshold > 1 ||
    !Number.isFinite(result.maxDiffRatio) ||
    result.maxDiffRatio < 0 ||
    result.maxDiffRatio > 0.25 ||
    !Number.isInteger(result.maxSnapshots) ||
    result.maxSnapshots < 1 ||
    result.maxSnapshots > 60
  )
    throw new Error("Invalid visual bounds");
  return result;
}
async function baselineRecord(directory, key) {
  try {
    const data = JSON.parse(
      (await readBounded(directory, `${key}.json`, 16384)).toString(),
    );
    if (
      data.key !== key ||
      !data.acceptedBy ||
      !/^[a-f0-9]{64}$/.test(data.sha256) ||
      !/^[a-f0-9]{40}$/.test(data.revision)
    )
      throw new Error("Invalid baseline approval record");
    const bytes = await readBounded(
      directory,
      `${data.sha256}.png`,
      IMAGE_LIMIT,
    );
    if (digest(bytes) !== data.sha256)
      throw new Error("Baseline image digest mismatch");
    return { ...data, bytes };
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function compareScreenshot({
  bytes,
  baselineDir,
  identity,
  metadata,
  outputDir,
  pixelThreshold = 0,
  maxDiffRatio = 0,
}) {
  decode(bytes);
  if (!metadata.revisionVerified || !/^[a-f0-9]{40}$/.test(metadata.revision))
    throw new Error("A visual candidate requires verified revision identity");
  const key = digest(JSON.stringify(identity)),
    sha256 = digest(bytes),
    output = await safeDirectory(path.join(outputDir, "visual"), true);
  const current = await baselineRecord(baselineDir, key);
  const imageName = `${key}-${sha256}.png`,
    candidateName = `${key}-${sha256}.candidate.json`;
  const candidate = {
    schemaVersion: 1,
    key,
    identity,
    sha256,
    revision: metadata.revision,
    revisionVerified: true,
    repository: metadata.repository,
    image: imageName,
    previousDigest: current?.sha256 || null,
  };
  try {
    await writeExclusive(output, imageName, bytes);
  } catch (e) {
    if (
      e.code !== "EEXIST" ||
      digest(await readBounded(output, imageName, IMAGE_LIMIT)) !== sha256
    )
      throw e;
  }
  try {
    await writeExclusive(
      output,
      candidateName,
      Buffer.from(JSON.stringify(candidate, null, 2)),
    );
  } catch (e) {
    if (
      e.code !== "EEXIST" ||
      !Buffer.from(JSON.stringify(candidate, null, 2)).equals(
        await readBounded(output, candidateName, 16384),
      )
    )
      throw e;
  }
  const base = {
    key,
    baselineRevision: current?.revision,
    candidatePath: `visual/${candidateName}`,
    actualPath: `visual/${imageName}`,
    baselineDigest: current?.sha256 || null,
  };
  if (!current)
    return {
      ...base,
      status: "blocked",
      details:
        "No approved visual baseline exists. Inspect the candidate and explicitly accept it outside the product checkout.",
    };
  const compared = comparePng(current.bytes, bytes, {
    pixelThreshold,
    maxDiffRatio,
  });
  const diffName = `${key}-${sha256}.diff.png`;
  if (compared.diff.length > IMAGE_LIMIT)
    throw new Error("Visual diff exceeds artifact limit");
  try {
    await writeExclusive(output, diffName, compared.diff);
  } catch (e) {
    if (
      e.code !== "EEXIST" ||
      !compared.diff.equals(await readBounded(output, diffName, IMAGE_LIMIT))
    )
      throw e;
  }
  const { diff, ...summary } = compared;
  return {
    ...base,
    ...summary,
    diffPath: `visual/${diffName}`,
    details: `${compared.differentPixels}/${compared.totalPixels} pixels differ (${(100 * compared.diffRatio).toFixed(3)}%); allowed ${(100 * maxDiffRatio).toFixed(3)}%. Dimensions ${compared.dimensionsMatch ? "match" : "changed"}.`,
  };
}
async function acceptBaseline({
  candidatePath,
  baselineDir,
  expectedRevision,
  approvedBy,
}) {
  if (
    typeof approvedBy !== "string" ||
    !approvedBy.trim() ||
    approvedBy.length > 100 ||
    !/^[a-f0-9]{40}$/.test(expectedRevision)
  )
    throw new Error(
      "Baseline acceptance requires an approver and the exact reviewed candidate SHA",
    );
  const source = await safeDirectory(path.dirname(path.resolve(candidatePath))),
    candidate = JSON.parse(
      (
        await readBounded(source, path.basename(candidatePath), 16384)
      ).toString(),
    );
  if (
    candidate.schemaVersion !== 1 ||
    candidate.revision !== expectedRevision ||
    candidate.revisionVerified !== true ||
    !/^[a-f0-9]{64}$/.test(candidate.key) ||
    !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
    candidate.key !== digest(JSON.stringify(candidate.identity))
  )
    throw new Error("Invalid baseline candidate identity");
  const bytes = await readBounded(source, candidate.image, IMAGE_LIMIT);
  decode(bytes);
  if (digest(bytes) !== candidate.sha256)
    throw new Error("Candidate image digest mismatch");
  const root = await safeDirectory(baselineDir, true),
    lock = await fs.open(
      path.join(root, ".accept.lock"),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  try {
    const entries = await fs.readdir(root);
    if (entries.length > 500)
      throw new Error("Baseline store entry limit exceeded");
    let size = 0;
    for (const entry of entries) {
      const stat = await fs.lstat(path.join(root, entry));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Baseline store contains unsafe entries");
      size += stat.size;
    }
    if (size + bytes.length > STORE_LIMIT)
      throw new Error("Baseline store size limit exceeded");
    const previous = await baselineRecord(root, candidate.key);
    if ((previous?.sha256 || null) !== candidate.previousDigest)
      throw new Error(
        "Baseline changed after candidate capture; rerun before accepting",
      );
    const imageName = `${candidate.sha256}.png`;
    try {
      await writeExclusive(root, imageName, bytes);
    } catch (e) {
      if (
        e.code !== "EEXIST" ||
        digest(await readBounded(root, imageName, IMAGE_LIMIT)) !==
          candidate.sha256
      )
        throw e;
    }
    const record = {
      schemaVersion: 1,
      key: candidate.key,
      identity: candidate.identity,
      sha256: candidate.sha256,
      revision: candidate.revision,
      acceptedBy: approvedBy,
      acceptedAt: new Date().toISOString(),
      previousDigest: candidate.previousDigest,
    };
    const temporary = `${candidate.key}.${crypto.randomUUID()}.tmp`;
    await writeExclusive(
      root,
      temporary,
      Buffer.from(JSON.stringify(record, null, 2)),
    );
    await fs.rename(
      path.join(root, temporary),
      path.join(root, `${candidate.key}.json`),
    );
    return record;
  } finally {
    await lock.close();
    await fs.unlink(path.join(root, ".accept.lock"));
  }
}
async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      ![
        "--candidate",
        "--baseline-dir",
        "--revision",
        "--approved-by",
      ].includes(argv[i]) ||
      !argv[i + 1]
    )
      throw new Error(
        "Use --candidate file --baseline-dir directory --revision exact-sha --approved-by name",
      );
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const result = await acceptBaseline({
    candidatePath: options.candidate,
    baselineDir: options["baseline-dir"],
    expectedRevision: options.revision,
    approvedBy: options["approved-by"],
  });
  console.log(`Accepted baseline ${result.key} at ${result.revision}`);
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = {
  comparePng,
  compareScreenshot,
  acceptBaseline,
  validateVisual,
  safeDirectory,
  readBounded,
  writeExclusive,
  main,
};
