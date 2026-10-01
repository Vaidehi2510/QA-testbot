const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const { executePlan } = require("../executor");

async function executeBaseline({
  repo,
  revision,
  repository,
  prNumber,
  runId,
  config,
  outputDir,
  checks,
  execute = executePlan,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !Array.isArray(checks))
    throw new Error(
      "Baseline execution requires an exact commit and trusted checks",
    );
  const source = await fs.realpath(repo),
    output = await require("./store").outsideProduct(
      path.resolve(outputDir),
      await fs.realpath(repo),
    );
  const relative = path.relative(source, output);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error("Baseline output must be outside product source");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-baseline-"));
  try {
    const archive = path.join(temporary, "source.tar.gz"),
      attestation = path.join(temporary, "source.json"),
      checkout = path.join(temporary, "source");
    const environment = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_ATTR_NOSYSTEM: "1",
    };
    const objects = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        source,
        "rev-parse",
        "--git-path",
        "objects",
      ],
      { encoding: "utf8", timeout: 10000, maxBuffer: 16384, env: environment },
    );
    const objectPath = await fs.realpath(
      path.resolve(source, objects.stdout.trim()),
    );
    if (/[\r\n]/.test(objectPath))
      throw new Error("Unsupported Git object-store path");
    // Read the existing object database through a temporary bare view. Product
    // Git config and info/attributes are never inherited or changed. The local
    // attribute override has higher priority than every committed .gitattributes
    // file, preventing export-ignore and export-subst from changing source bytes.
    const view = path.join(temporary, "object-view.git");
    await Promise.all(
      ["objects/info", "refs", "info"].map((directory) =>
        fs.mkdir(path.join(view, directory), { recursive: true, mode: 0o700 }),
      ),
    );
    await fs.writeFile(path.join(view, "HEAD"), "ref: refs/heads/unused\n", {
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(view, "config"),
      "[core]\nrepositoryformatversion = 0\nbare = true\n",
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(view, "objects/info/alternates"),
      objectPath + "\n",
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(view, "info/attributes"),
      "* -export-ignore -export-subst\n",
      { mode: 0o600 },
    );
    const { stdout } = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        `core.attributesFile=${os.devNull}`,
        "--git-dir",
        view,
        "archive",
        "--format=tar",
        "--prefix=source/",
        revision,
      ],
      {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30000,
        env: environment,
      },
    );
    // Git's tar.gz format may execute tar.tar.gz.command from product Git
    // configuration. The built-in tar writer plus Node compression runs no
    // product-defined archive helper on the host.
    const compressed = gzipSync(stdout);
    await fs.writeFile(archive, compressed, { mode: 0o600 });
    await fs.writeFile(
      attestation,
      JSON.stringify({
        repository,
        revision,
        sourceSha256: crypto
          .createHash("sha256")
          .update(compressed)
          .digest("hex"),
      }),
      { mode: 0o600 },
    );
    await exec(
      "python3",
      [
        "-I",
        path.join(__dirname, "../unpack-source.py"),
        archive,
        attestation,
        checkout,
      ],
      { timeout: 30000, maxBuffer: 64000 },
    );
    const plan = {
      checks: checks.map((check) => ({
        ...check,
        runner: check.runner || check.runnerId,
      })),
    };
    const result = await execute({
      plan,
      config: {
        ...config,
        execution: { ...config.execution, isolation: "container" },
      },
      cwd: checkout,
      sourceAttestation: attestation,
      outputDir: output,
      metadata: { repository, revision, prNumber, runId, attempt: 1 },
      isolation: "container",
    });
    return {
      results: result.results,
      limitations: result.screenshotLimitations || [],
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
module.exports = { executeBaseline };
