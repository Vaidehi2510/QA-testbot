const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { outsideProduct } = require('../autonomy/store');
const { validateTarget } = require('../assessment');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function readBytes(filename, maximum = 2 * 1024 * 1024) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error('Evidence must be a bounded regular file without hard links');
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Evidence changed during inspection');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
async function hashArtifact(filename) {
  const stat = await fs.lstat(filename);
  if (stat.isDirectory() && path.extname(filename).toLowerCase() === '.app') return (await require('../native/artifact').artifactIdentity(filename)).artifactSha256;
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !before.size || before.size > 512 * 1024 * 1024) throw new Error('Build artifact must be a nonempty regular file up to 512 MiB or a supported .app bundle');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let size = 0;
    for (;;) { const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; size += read.bytesRead; if (size > before.size) throw new Error('Build artifact grew during inspection'); hash.update(buffer.subarray(0, read.bytesRead)); }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Build artifact changed during inspection');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
async function inspectArtifact({ manifestPath, target: raw, repository, revision, repo }) {
  const target = validateTarget(raw);
  if (!path.isAbsolute(manifestPath)) throw new Error('Enroll an absolute build manifest path');
  await outsideProduct(manifestPath, repo);
  const bytes = await readBytes(manifestPath, 64 * 1024), manifest = JSON.parse(bytes);
  if (!manifest || Object.keys(manifest).some(key => !['schemaVersion', 'repository', 'revision', 'artifactSha256', 'artifactPath', 'platform', 'buildId', 'version'].includes(key)) || manifest.schemaVersion !== 1
    || manifest.repository !== repository || manifest.revision !== revision || manifest.platform !== target.platform || manifest.artifactSha256 !== target.artifactSha256
    || manifest[target.kind === 'release' ? 'version' : 'buildId'] !== target.name || !path.isAbsolute(manifest.artifactPath || '')) throw new Error('Trusted build manifest does not identify this exact build/release, artifact, source revision and platform');
  await outsideProduct(manifest.artifactPath, repo);
  if (await hashArtifact(manifest.artifactPath) !== target.artifactSha256) throw new Error('Built artifact bytes differ from the requested SHA-256');
  return { manifestHash: digest(bytes), artifactSha256: target.artifactSha256 };
}
async function importedJUnit({ runner, metadata, productRoot }) {
  if (!path.isAbsolute(runner.reportPath || '') || !path.isAbsolute(runner.attestationPath || '')) throw new Error('JUnit reports and CI attestations must be locally enrolled absolute paths');
  await outsideProduct(runner.reportPath, productRoot); await outsideProduct(runner.attestationPath, productRoot);
  const bytes = await readBytes(runner.reportPath), attestation = JSON.parse(await readBytes(runner.attestationPath, 64 * 1024));
  const subjectMatches = metadata.target ? attestation?.prNumber === undefined && attestation?.artifactSha256 === metadata.target.artifactSha256 && attestation?.platform === metadata.target.platform
    : Number.isSafeInteger(metadata.prNumber) && metadata.prNumber > 0 && attestation?.prNumber === metadata.prNumber && attestation?.artifactSha256 === undefined && attestation?.platform === undefined;
  if (!attestation || Object.keys(attestation).some(key => !['schemaVersion', 'repository', 'revision', 'prNumber', 'artifactSha256', 'platform', 'reportSha256', 'runnerId'].includes(key))
    || !subjectMatches || attestation.schemaVersion !== 1 || attestation.repository !== metadata.repository || attestation.revision !== metadata.revision
    || attestation.runnerId !== runner.id || attestation.reportSha256 !== digest(bytes)) throw new Error('CI JUnit attestation does not match this exact assessment, source revision, runner and report');
  const counts = require('./junit').parseJUnit(bytes.toString('utf8'));
  if (!counts.valid) throw new Error(counts.reason);
  return { counts, status: counts.failed ? 'failed' : counts.skipped ? 'skipped' : 'passed', details: `Imported CI JUnit: ${counts.passed}/${counts.tests} passed, ${counts.failed} failed, ${counts.skipped} skipped. CI attestation is trusted local input; the CI host was not independently verified.` };
}
function runnerPolicyHash(config) { return digest(JSON.stringify({ runners: (config.runners || []).filter(r => r.baseline && r.id !== 'patchsentry-authored-unit-tests'), execution: config.execution || {} })); }
async function externalInputFingerprint(config, repo) {
  const entries = [];
  for (const runner of (config.runners || []).filter(r => r.baseline && r.id !== 'patchsentry-authored-unit-tests')) {
    if (runner.type === 'junit-report') {
      for (const filename of [runner.reportPath, runner.attestationPath]) { await outsideProduct(filename, repo); entries.push([runner.id, filename, digest(await readBytes(filename))]); }
    } else if (runner.type === 'workspace-node-test') {
      require('../executor').runnerCommand(runner, repo);
      for (const filename of runner.files) entries.push([runner.id, filename, runner.sourceDigests[filename]]);
    }
  }
  return digest(JSON.stringify(entries));
}
module.exports = { readBytes, hashArtifact, inspectArtifact, importedJUnit, digest, runnerPolicyHash, externalInputFingerprint };
