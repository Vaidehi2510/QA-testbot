const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { generateAppArmorProfile } = require("../src/web/apparmor-profile");

async function fixture(t) {
  // Resolve macOS /var and /tmp aliases before applying Linux path validation.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "qa-apparmor-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "ms-playwright");
  await fs.mkdir(cache);
  return { root, cache, env: { PLAYWRIGHT_BROWSERS_PATH: cache } };
}

async function binary(cache, relative, mode = 0o755) {
  const filename = path.join(cache, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, "synthetic browser binary\n", { mode });
  return filename;
}

test("AppArmor generator attaches only exact versioned Chromium and headless-shell binaries", async (t) => {
  const { cache, env } = await fixture(t);
  const chrome = await binary(cache, "chromium-1243/chrome-linux64/chrome");
  const shell = await binary(
    cache,
    "chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
  );
  await binary(cache, "firefox-1600/firefox/firefox");
  await binary(cache, "chromium-untrusted/chrome-linux64/chrome");
  await binary(cache, "chromium-1243/arbitrary/chrome");
  const profile = await generateAppArmorProfile({ env });
  assert.equal((profile.match(/^profile /gm) || []).length, 2);
  for (const filename of [chrome, shell])
    assert.ok(
      profile.includes(`"${filename}" flags=(unconfined) {\n  userns,\n}`),
    );
  assert.match(profile, /abi <abi\/4\.0>,/);
  assert.match(profile, /include <tunables\/global>/);
  assert.doesNotMatch(profile, /firefox|untrusted|arbitrary|\*|@\{|no-sandbox/);
  assert.equal(profile, await generateAppArmorProfile({ env }));
  const result = await execFile(
    process.execPath,
    [path.join(__dirname, "../src/web/apparmor-profile.js")],
    { env: { ...process.env, ...env } },
  );
  assert.equal(result.stdout, profile);
  assert.equal(result.stderr, "");
});

test("AppArmor generator rejects path syntax, traversal and empty or unsupported caches", async (t) => {
  const { cache, env } = await fixture(t);
  for (const value of [
    "relative",
    "0",
    `${cache}/../ms-playwright`,
    `${cache}/`,
    `${cache}/**`,
    `${cache}/@{HOME}`,
    `${cache}/bad\nprofile`,
    `${cache}/quote\"`,
    `${cache}/space name`,
  ]) {
    await assert.rejects(
      generateAppArmorProfile({ env: { PLAYWRIGHT_BROWSERS_PATH: value } }),
      /absolute normalized path/,
    );
  }
  await assert.rejects(generateAppArmorProfile({ env }), /No supported Linux/);
  await binary(cache, "chromium-1243/chrome-mac/Chromium");
  await assert.rejects(generateAppArmorProfile({ env }), /No supported Linux/);
});

test("AppArmor generator rejects symlinked cache roots, versions, parent directories and binaries", async (t) => {
  const { root, cache, env } = await fixture(t);
  const target = await binary(cache, "chromium-1243/chrome-linux64/chrome");
  const alias = path.join(root, "cache-link");
  await fs.symlink(cache, alias, "dir");
  await assert.rejects(
    generateAppArmorProfile({ env: { PLAYWRIGHT_BROWSERS_PATH: alias } }),
    /symlinks/,
  );
  const version = path.join(cache, "chromium-9999");
  await fs.symlink(path.dirname(path.dirname(target)), version, "dir");
  await assert.rejects(generateAppArmorProfile({ env }), /symlinks/);
  await fs.rm(version);
  await fs.mkdir(version);
  const architecture = path.join(version, "chrome-linux64");
  await fs.symlink(path.dirname(target), architecture, "dir");
  await assert.rejects(generateAppArmorProfile({ env }), /symlinks/);
  await fs.rm(architecture);
  await fs.mkdir(architecture);
  await fs.symlink(target, path.join(architecture, "chrome"));
  await assert.rejects(generateAppArmorProfile({ env }), /symlinks/);
});

test("AppArmor generator rejects hard-linked and non-executable candidates", async (t) => {
  const { cache, env } = await fixture(t);
  const target = await binary(
    cache,
    "chromium-1243/chrome-linux64/chrome",
    0o644,
  );
  await assert.rejects(
    generateAppArmorProfile({ env }),
    /executable regular file/,
  );
  await fs.chmod(target, 0o755);
  const linked = path.join(cache, "another-name");
  await fs.link(target, linked);
  await assert.rejects(generateAppArmorProfile({ env }), /hard links/);
});
