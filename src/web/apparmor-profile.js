const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { browserCache } = require("./execute");

// This tool only prints a profile for a trusted, already installed browser
// cache. The operator reviews and installs it on the dedicated Linux runner.
// Exact attachments follow Chromium's documented user-namespace exception:
// https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
const layouts = [
  {
    directory: /^chromium-\d+$/,
    executables: ["chrome-linux64/chrome", "chrome-linux-arm64/chrome"],
  },
  {
    directory: /^chromium_headless_shell-\d+$/,
    executables: [
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-headless-shell-linux-arm64/chrome-headless-shell",
    ],
  },
];

function safeAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !path.isAbsolute(value) ||
    value === path.parse(value).root ||
    path.normalize(value) !== value ||
    // Reject AppArmor globbing, variables, escaping and profile syntax instead
    // of attempting to quote an arbitrary operator-supplied attachment.
    !/^\/[A-Za-z0-9_./-]+$/.test(value) ||
    value
      .split("/")
      .some(
        (part, index) => index > 0 && (!part || part === "." || part === ".."),
      )
  )
    throw new Error(
      "Browser cache must be an absolute normalized path without AppArmor metacharacters",
    );
  return value;
}

async function inspectPath(
  filename,
  { optional = false, executable = false } = {},
) {
  const parts = safeAbsolutePath(filename).split("/").filter(Boolean);
  let current = path.parse(filename).root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (optional && error.code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error("Browser cache paths must not contain symlinks");
    if (index < parts.length - 1 || !executable) {
      if (!stat.isDirectory())
        throw new Error("Browser cache path must be a directory");
    } else if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size === 0 ||
      !(stat.mode & 0o111)
    ) {
      throw new Error(
        "Chromium executable must be a nonempty executable regular file without hard links",
      );
    }
  }
  if ((await fs.realpath(filename)) !== filename)
    throw new Error("Browser cache path must not escape through an alias");
  return true;
}

async function generateAppArmorProfile({ env = process.env } = {}) {
  const cache = safeAbsolutePath(browserCache(env));
  await inspectPath(cache);
  const entries = await fs.readdir(cache, { withFileTypes: true });
  if (entries.length > 128)
    throw new Error(
      "Browser cache contains too many entries to inspect safely",
    );
  const executables = [];
  let versions = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const layout = layouts.find((value) => value.directory.test(entry.name));
    if (!layout) continue;
    if (++versions > 32)
      throw new Error("Browser cache contains too many Chromium versions");
    const directory = path.join(cache, entry.name);
    await inspectPath(directory);
    for (const relative of layout.executables) {
      const filename = path.join(directory, relative);
      if (!filename.startsWith(`${cache}/`))
        throw new Error("Chromium executable escapes the browser cache");
      if (await inspectPath(filename, { optional: true, executable: true }))
        executables.push(filename);
    }
  }
  if (!executables.length)
    throw new Error(
      "No supported Linux Chromium binaries found; install the pinned Playwright Chromium browsers first",
    );
  const profiles = executables.sort().map((filename) => {
    const id = crypto
      .createHash("sha256")
      .update(filename)
      .digest("hex")
      .slice(0, 24);
    return `profile patchsentry-chromium-${id} "${filename}" flags=(unconfined) {\n  userns,\n}\n`;
  });
  return [
    "# Generated for exact installed Playwright binaries on a dedicated runner.",
    "# Review before installing; regenerate after browser upgrades.",
    "# Chromium's own sandbox remains enabled; no global sysctl is changed.",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    ...profiles,
  ].join("\n");
}

if (require.main === module) {
  if (process.argv.length !== 2) {
    process.stderr.write(
      "Usage: node src/web/apparmor-profile.js > chromium.apparmor\n",
    );
    process.exitCode = 1;
  } else {
    generateAppArmorProfile().then(
      (profile) => process.stdout.write(profile),
      (error) => {
        process.stderr.write(
          `AppArmor profile generation failed: ${error.message}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}

module.exports = { generateAppArmorProfile };
