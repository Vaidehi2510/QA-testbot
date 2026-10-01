const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileStore, emptyState, validateState } = require('../state');
const inside = (root, value) => { const relative = path.relative(root, value); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

async function resolvedPath(value) {
  let cursor = path.resolve(value), suffix = '';
  for (;;) {
    try { return path.join(await fs.realpath(cursor), suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix = path.join(path.basename(cursor), suffix); cursor = path.dirname(cursor);
    }
  }
}
async function outsideProduct(value, productRoot) {
  const resolved = await resolvedPath(value);
  if (inside(await fs.realpath(productRoot), resolved)) throw new Error('Autonomous configuration and evidence must stay outside the product checkout');
  return resolved;
}
async function readJson(filename, maximum = 256 * 1024) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error('Trusted JSON input exceeds its size limit, has hard links, or is not a regular file');
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw new Error('Trusted JSON input exceeds its size limit');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}
async function ownedPath(root, relative, { directory = false } = {}) {
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error('Evidence path escapes the bot workspace');
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean).reduce((all, part) => [...all, path.join(all.at(-1) || root, part)], [])) {
    try { if ((await fs.lstat(part)).isSymbolicLink()) throw new Error('Evidence paths cannot use symbolic links'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(directory ? target : path.dirname(target), { recursive: true, mode: 0o700 });
  return target;
}
async function writeJson(root, relative, value) {
  const filename = await ownedPath(root, relative);
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
  return filename;
}
class AutonomyStore extends FileStore {
  async load() {
    await ownedPath(this.directory, 'state.json');
    try { return validateState(await readJson(this.filename, 32 * 1024 * 1024)); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
  }
  async save(state) {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('Autonomous state needs archival before more runs');
    await writeJson(this.directory, 'state.json', validateState(state));
  }
}
module.exports = { AutonomyStore, outsideProduct, readJson, ownedPath, writeJson, inside };
