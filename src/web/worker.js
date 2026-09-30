const fs = require('node:fs/promises');
const path = require('node:path');
const { runWebAudit } = require('./audit');
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--request' || argv[2] !== '--output') throw new Error('Usage: web/worker.js --request trusted-request.json --output evidence-directory');
  const request = JSON.parse(await fs.readFile(argv[1], 'utf8'));
  const evidence = await runWebAudit({ ...request, outputDir: argv[3], env: { ...process.env,
    ...(request.browserExecutable ? { QA_BROWSER_EXECUTABLE: request.browserExecutable } : {}),
    ...(request.browserCache ? { PLAYWRIGHT_BROWSERS_PATH: request.browserCache } : {}) } });
  await fs.writeFile(path.join(argv[3], 'web-result.json'), JSON.stringify(evidence), { mode: 0o600 });
  console.log(evidence.result.details);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
