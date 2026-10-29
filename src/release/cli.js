#!/usr/bin/env node
const { runRelease, gateDecision } = require('./run');
const { inspectArtifact, readBytes, runnerPolicyHash, externalInputFingerprint } = require('./artifact');
const { redact } = require('../ai/context');
const { validateTarget } = require('../assessment');
const path = require('node:path');
const flags = new Set(['repo', 'repository', 'base', 'head', 'config', 'manifest', 'suite', 'goals', 'output-dir', 'budget-usd', 'rerun-token', 'kind', 'name', 'platform', 'artifact-sha256', 'report', 'revision', 'max-age-minutes']);
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') { if (options.dryRun) throw new Error('Duplicate --dry-run'); options.dryRun = true; continue; }
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !flags.has(name) || Object.hasOwn(options, name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown, duplicate or incomplete option: ${args[i]}`);
    options[name] = args[++i];
  }
  options.target = validateTarget({ kind: options.kind, name: options.name, platform: options.platform, artifactSha256: options['artifact-sha256'] });
  return options;
}
async function main(args = process.argv.slice(2)) {
  const gate = args[0] === 'gate'; if (gate) args = args.slice(1);
  const options = parseArgs(args);
  let decision;
  if (gate) {
    if (!options.report || !options.manifest || !options.repo || !options.repository || !/^[a-f0-9]{40}$/.test(options.revision || '')) throw new Error('A deployment gate requires report, manifest, repo, repository, exact revision and target');
    await require('../autonomy/store').outsideProduct(path.resolve(options.report), options.repo);
    const report = JSON.parse(await readBytes(path.resolve(options.report), 16 * 1024 * 1024));
    const maxAge = Number(options['max-age-minutes'] || 60); if (!Number.isFinite(maxAge) || maxAge < 1 || maxAge > 1440) throw new Error('Evidence freshness must be between 1 and 1440 minutes');
    const artifact = await inspectArtifact({ manifestPath: path.resolve(options.manifest), target: options.target, repository: options.repository, revision: options.revision, repo: options.repo });
    decision = gateDecision(report, { repository: options.repository, revision: options.revision, target: options.target, maxAgeMs: maxAge * 60000 });
    if (artifact.manifestHash !== report.release?.manifestHash) { decision.eligible = false; decision.reasons.push('Builder manifest changed after QA.'); }
    if (options.target.platform === 'web') {
      if (!options.suite || !options.goals) throw new Error('Web deployment gates require the current trusted suite and goals files');
      const readPolicy = async filename => JSON.parse(await readBytes(await require('../autonomy/store').outsideProduct(path.resolve(filename), options.repo), 256 * 1024));
      if (require('../autonomy/schema').hash(await readPolicy(options.suite)) !== report.release?.suiteHash || require('../autonomy/schema').hash(await readPolicy(options.goals)) !== report.release?.goalsHash) { decision.eligible = false; decision.reasons.push('Trusted browser suite or business assertions changed after QA.'); }
    }
    const configPath = await require('../autonomy/store').outsideProduct(path.resolve(options.config || path.join(__dirname, '../../qa-config.json')), options.repo);
    const config = JSON.parse(await readBytes(configPath, 256 * 1024));
    if (runnerPolicyHash(config) !== report.release?.runnerPolicyHash || await externalInputFingerprint(config, options.repo) !== report.release?.inputHash) { decision.eligible = false; decision.reasons.push('Enrolled runner policy or imported CI evidence changed after QA.'); }
    for (const runner of (config.runners || []).filter(r => r.baseline)) if (!report.plan?.checks?.some(c => c.id === `runner-${runner.id}` && c.required !== false && c.method === 'automated')) { decision.eligible = false; decision.reasons.push(`Required enrolled suite is missing: ${runner.id}`); }
    console.log(JSON.stringify(decision));
  } else {
    const run = await runRelease({ options, log: value => console.error(redact(value)) });
    if (run.status === 'preview') { console.log(JSON.stringify(run)); return; }
    decision = run.release.gate; console.log(JSON.stringify({ repository: run.repository, revision: run.revision, target: run.target, report: run.report.path, ...decision }));
  }
  if (!decision.eligible) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { parseArgs, main };
