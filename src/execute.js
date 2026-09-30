#!/usr/bin/env node
// Offline entrypoint: the request must come from trusted bot state, never a PR.
const fs = require('node:fs');
const path = require('node:path');
const { executePlan } = require('./executor');

async function main(args = process.argv.slice(2)) {
  const option = (name) => args[args.indexOf(name) + 1];
  if (!['--request', '--checkout', '--output'].every((name) => args.includes(name) && option(name))) throw new Error('Usage: node src/execute.js --request trusted-request.json --checkout source --output results [--attestation source.json] [--allow-local-fixture]');
  const request = JSON.parse(fs.readFileSync(path.resolve(option('--request')), 'utf8'));
  const fixture = args.includes('--allow-local-fixture');
  if (!fixture) { request.metadata.fixture = false; request.config.execution = { ...request.config.execution, isolation: 'container' }; }
  const envelope = await executePlan({ ...request, cwd: path.resolve(option('--checkout')), outputDir: path.resolve(option('--output')), allowLocal: fixture, sourceAttestation: args.includes('--attestation') ? path.resolve(option('--attestation')) : undefined, metadata: { ...request.metadata, actionsRunId: process.env.GITHUB_RUN_ID, actionsAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1) } });
  console.log(JSON.stringify({ runId: envelope.runId, revision: envelope.revision, results: envelope.results.map(({ checkId, status }) => ({ checkId, status })), ...(envelope.screenshots ? { screenshots: envelope.screenshots.length, screenshotLimitations: envelope.screenshotLimitations } : {}) }));
  return envelope;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
