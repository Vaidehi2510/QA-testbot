const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { ownedPath, outsideProduct } = require('../autonomy/store');
function validateUnitTests(tests = []) {
  if (!Array.isArray(tests) || tests.length > 8) throw new Error('At most eight authored unit tests can run in one assessment');
  const seen = new Set(); let bytes = 0;
  return tests.map(test => {
    if (!test || Object.keys(test).some(k => !['id', 'name', 'source', 'sha256'].includes(k)) || !/^[a-f0-9-]{36}$/.test(test.id || '') || seen.has(test.id)
      || typeof test.name !== 'string' || !test.name.trim() || test.name.length > 120 || typeof test.source !== 'string' || !test.source.trim() || Buffer.byteLength(test.source) > 24000 || test.source.includes('\0')
      || crypto.createHash('sha256').update(test.source).digest('hex') !== test.sha256) throw new Error('Authored unit tests need distinct IDs, names, bounded source and matching SHA-256 digests');
    bytes += Buffer.byteLength(test.source); if (bytes > 96000) throw new Error('Authored unit tests exceed the job source budget'); seen.add(test.id);
    return { id: test.id, name: test.name, source: test.source, sha256: test.sha256 };
  });
}
async function stageUnitTests({ tests, policy, config, directory, repo }) {
  const validated = validateUnitTests(tests);
  if (!validated.length) return config;
  if (policy.allowWorkspaceTests !== true || policy.executeBaseline !== true) throw new Error('Website-authored tests require explicit offline execution enrollment on this runner');
  const id = 'patchsentry-authored-unit-tests';
  if ((config.runners || []).some(r => r.id === id)) throw new Error('Reserved workspace unit-test runner ID already exists');
  const root = await ownedPath(await outsideProduct(directory, repo), 'unit-tests', { directory: true });
  await fs.chmod(root, 0o755);
  for (const test of validated) {
    const filename = await ownedPath(root, `${test.id}.test.cjs`);
    try { await fs.writeFile(filename, test.source, { flag: 'wx', mode: 0o444 }); }
    catch (error) { if (error.code !== 'EEXIST' || crypto.createHash('sha256').update(await require('./artifact').readBytes(filename, 24000)).digest('hex') !== test.sha256) throw new Error('Saved authored unit-test source changed; request a new assessment'); }
  }
  return { ...config, runners: [...(config.runners || []), { id, type: 'workspace-node-test', baseline: true, testRoot: root, files: validated.map(t => `${t.id}.test.cjs`), sourceDigests: Object.fromEntries(validated.map(t => [`${t.id}.test.cjs`, t.sha256])), timeoutMs: 60000, expected: 'Explicitly enabled, bot-owned unit tests pass in the offline sandbox.' }] };
}
module.exports = { validateUnitTests, stageUnitTests };
