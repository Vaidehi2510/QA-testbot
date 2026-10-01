#!/usr/bin/env node
const { runAutonomous } = require('./run');
const { redact } = require('../ai/context');
function parseArgs(argv) {
  const flags = new Set(['repo', 'base', 'head', 'repository', 'pr', 'title', 'product', 'suite', 'goals', 'config', 'output-dir', 'budget-usd', 'rerun-token', 'results']);
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--dry-run' || argv[index] === '--execute-baseline') {
      const name = argv[index] === '--dry-run' ? 'dryRun' : 'executeBaseline';
      if (options[name]) throw new Error(`Duplicate ${argv[index]}`);
      options[name] = true; continue;
    }
    const name = argv[index].replace(/^--/, '');
    if (!argv[index].startsWith('--') || !flags.has(name) || Object.hasOwn(options, name) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown, duplicate or incomplete option: ${argv[index]}`);
    options[name] = argv[++index];
  }
  return options;
}
async function main(args = process.argv.slice(2)) {
  const run = await runAutonomous({ options: parseArgs(args), log: value => console.error(redact(value)) });
  console.log(JSON.stringify({ key: run.key, repository: run.repository, revision: run.revision, status: run.outcome?.status || run.status, report: run.report?.path }));
}
if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { parseArgs, main };
