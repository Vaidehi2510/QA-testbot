#!/usr/bin/env node
const path = require('node:path');
const { readJson, outsideProduct } = require('../autonomy/store');
const { runNativeAudit } = require('./audit');
const { redact } = require('../ai/context');
function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--suite', '--metadata', '--output'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--') || options[args[index]]) throw new Error('Usage: qa:native --suite trusted-suite.json --metadata revision.json --output bot-output');
    options[args[index]] = path.resolve(args[index + 1]);
  }
  if (Object.keys(options).length !== 3) throw new Error('Native suite, metadata and output are required');
  return options;
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args), suite = await readJson(options['--suite']), metadata = await readJson(options['--metadata']);
  for (const root of [suite.productRoot, metadata.productRoot].filter(Boolean)) { await outsideProduct(options['--suite'], root); await outsideProduct(options['--metadata'], root); }
  const evidence = await runNativeAudit({ suite, metadata, outputDir: options['--output'] });
  console.log(JSON.stringify({ status: evidence.result.status, revision: evidence.revision, report: evidence.result.evidence[0].path }));
}
if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { main, parseArgs };
