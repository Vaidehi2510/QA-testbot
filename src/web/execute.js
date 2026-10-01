const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const syncFs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { validateWebSuite } = require("./audit");
const { redact } = require("../ai/context");

// Only the fixed worker can update this private, parent-created registry. Never
// read process IDs from product content or a browser result/evidence document.
function stopBrowserProcesses(filename, token, kill) {
  let handle;
  try {
    handle = syncFs.openSync(
      filename,
      syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW,
    );
    const stat = syncFs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) return;
    const value = JSON.parse(syncFs.readFileSync(handle, "utf8"));
    if (
      value.token !== token ||
      !Array.isArray(value.pids) ||
      value.pids.length > 3 ||
      value.pids.some(
        (pid) =>
          !Number.isSafeInteger(pid) ||
          pid <= 1 ||
          [process.pid, process.ppid].includes(pid),
      )
    )
      return;
    for (const pid of new Set(value.pids)) {
      try {
        if (kill) kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
        else if (process.platform === "win32")
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 2000,
            windowsHide: true,
          });
        else process.kill(-pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  } catch {
    /* A missing/incomplete registry never authorizes another process. */
  } finally {
    if (handle !== undefined) syncFs.closeSync(handle);
  }
}

function browserCache(env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  // Resolve installation before the worker receives a secret-free HOME=/tmp.
  let directory = path.dirname(
    require("playwright-core").chromium.executablePath(),
  );
  for (;;) {
    if (/^chromium-\d+$/.test(path.basename(directory)))
      return path.dirname(directory);
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

// Only trusted bot code launches the browser. No target scripts or integration
// credentials are passed into this short-lived process or its browser children.
async function executeWebCheck({
  suite,
  metadata,
  outputDir,
  checkId,
  timeoutMs = 180000,
  env = process.env,
  processRunner,
}) {
  validateWebSuite(suite, metadata);
  const runProcess = processRunner || require("../executor").runProcess;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qa-web-request-"));
  const output = path.resolve(outputDir);
  const trackingToken = crypto.randomUUID(),
    registry = path.join(temporary, "browser-processes.json");
  await fs.mkdir(output, { recursive: true });
  try {
    const requestPath = path.join(temporary, "request.json");
    await fs.writeFile(
      requestPath,
      JSON.stringify({
        suite,
        metadata,
        checkId,
        browserTrackingToken: trackingToken,
        browserExecutable: env.QA_BROWSER_EXECUTABLE,
        browserExecutables: Object.fromEntries(
          ["chromium", "firefox", "webkit"]
            .filter((name) => env[`QA_${name.toUpperCase()}_EXECUTABLE`])
            .map((name) => [name, env[`QA_${name.toUpperCase()}_EXECUTABLE`]]),
        ),
        browserCache: browserCache(env),
      }),
      { mode: 0o600 },
    );
    const execution = await runProcess(
      process.execPath,
      [
        path.join(__dirname, "worker.js"),
        "--request",
        requestPath,
        "--output",
        output,
      ],
      {
        cwd: temporary,
        timeoutMs: Math.min(600000, Math.max(100, timeoutMs)),
        maxOutput: 64000,
        onStop: () => stopBrowserProcesses(registry, trackingToken),
        terminationGraceMs: 2500,
      },
    );
    if (
      execution.exitCode !== 0 ||
      execution.error ||
      execution.cancelled ||
      execution.timedOut ||
      execution.overflow
    ) {
      const log = redact(execution.output || execution.error || "").slice(
        -16000,
      );
      await fs.writeFile(path.join(output, "browser-worker.log"), log, {
        mode: 0o600,
      });
      return {
        result: {
          checkId,
          status: "execution_error",
          details: execution.timedOut
            ? "Browser suite exceeded its total deadline; browser process group terminated."
            : "Browser worker failed; no successful evidence was accepted.",
          evidence: [
            {
              type: "log",
              path: "browser-worker.log",
              excerpt: log.slice(-4000),
            },
          ],
        },
        screenshots: [],
        limitations: ["Browser execution did not finish."],
      };
    }
    const filename = path.join(output, "web-result.json");
    if ((await fs.stat(filename)).size > 2 * 1024 * 1024)
      throw new Error("Browser result exceeds its size limit");
    const evidence = JSON.parse(await fs.readFile(filename, "utf8"));
    if (
      evidence.revision !== metadata.revision ||
      evidence.repository !== metadata.repository ||
      evidence.prNumber !== metadata.prNumber ||
      evidence.checkId !== checkId ||
      evidence.result?.checkId !== checkId
    )
      throw new Error("Browser evidence identity mismatch");
    return evidence;
  } finally {
    stopBrowserProcesses(registry, trackingToken);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
module.exports = { executeWebCheck, stopBrowserProcesses, browserCache };
