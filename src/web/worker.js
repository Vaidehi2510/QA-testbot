const fs = require("node:fs/promises");
const path = require("node:path");
const syncFs = require("node:fs");
const { runWebAudit } = require("./audit");
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== "--request" || argv[2] !== "--output")
    throw new Error(
      "Usage: web/worker.js --request trusted-request.json --output evidence-directory",
    );
  const request = JSON.parse(await fs.readFile(argv[1], "utf8"));
  if (request.browserCache)
    process.env.PLAYWRIGHT_BROWSERS_PATH = request.browserCache;
  // Parent cancellation must also cover browsers still starting, before
  // launchServer returns a PID. Playwright registers synchronous exit cleanup
  // for each child at spawn time; exiting runs that cleanup without waiting
  // indefinitely for an unfinished browser protocol handshake.
  process.once("SIGTERM", () => process.exit(143));
  if (!/^[a-f0-9-]{36}$/.test(request.browserTrackingToken || ""))
    throw new Error(
      "Browser worker requires a parent-created process registry token",
    );
  const active = new Set(),
    registry = path.join(path.dirname(argv[1]), "browser-processes.json");
  const onBrowserProcess = (pid, running) => {
    if (!Number.isSafeInteger(pid) || pid <= 1)
      throw new Error("Invalid owned browser process");
    running ? active.add(pid) : active.delete(pid);
    const temporary = registry + ".tmp";
    syncFs.writeFileSync(
      temporary,
      JSON.stringify({
        token: request.browserTrackingToken,
        pids: [...active],
      }),
      { flag: "wx", mode: 0o600 },
    );
    syncFs.renameSync(temporary, registry);
  };
  const evidence = await runWebAudit({
    ...request,
    outputDir: argv[3],
    onBrowserProcess,
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(request.browserExecutables || {})
          .filter(([name]) => ["chromium", "firefox", "webkit"].includes(name))
          .map(([name, value]) => [
            `QA_${name.toUpperCase()}_EXECUTABLE`,
            value,
          ]),
      ),
      ...(request.browserExecutable
        ? { QA_BROWSER_EXECUTABLE: request.browserExecutable }
        : {}),
      ...(request.browserCache
        ? { PLAYWRIGHT_BROWSERS_PATH: request.browserCache }
        : {}),
    },
  });
  await fs.writeFile(
    path.join(argv[3], "web-result.json"),
    JSON.stringify(evidence),
    { mode: 0o600 },
  );
  console.log(evidence.result.details);
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
