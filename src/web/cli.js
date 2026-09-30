const fs = require('node:fs/promises');
const path = require('node:path');
const { executeWebCheck } = require('./execute');
async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--suite', '--revision', '--repository', '--pr', '--output-dir'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --suite bot-owned-suite.json --revision <full SHA> --repository owner/product --pr <number> [--output-dir <bot directory>]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (!options.suite || !options.repository) throw new Error('An explicit suite and repository identity are required');
  const outputDir = path.resolve(options['output-dir'] || path.join(__dirname, '../../.qa-local/browser-standalone'));
  const metadata = { repository: options.repository, revision: options.revision, prNumber: Number(options.pr) };
  const evidence = await executeWebCheck({ suite: JSON.parse(await fs.readFile(options.suite, 'utf8')), metadata, outputDir, checkId: 'web-browser-audit' });
  console.log(`${evidence.result.status}: ${evidence.result.details}\nEvidence: ${outputDir}`);
  if (evidence.result.status !== 'passed') process.exitCode = 1;
  return evidence;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
