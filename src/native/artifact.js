const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inside, ownedPath } = require('../autonomy/store');
const MAX_BYTES = 512 * 1024 * 1024, MAX_ENTRIES = 20000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function hashFile(filename, state, destination) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size + state.bytes > MAX_BYTES) throw new Error('Native artifact file is unsafe or exceeds the 512 MiB limit');
    if (destination) { output = await fs.open(destination, 'wx', before.mode & 0o777); await output.chmod(before.mode & 0o777); }
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead; state.bytes += bytesRead;
      if (state.bytes > MAX_BYTES || size > before.size) throw new Error('Native artifact changed while being read or exceeds its byte budget');
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    const after = await handle.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Native artifact changed while being read');
    return { sha256: hash.digest('hex'), bytes: size, mode: before.mode & 0o777 };
  } finally { await output?.close(); await handle.close(); }
}

// Files use ordinary SHA-256. App bundles use a versioned digest of a sorted
// physical tree: relative path, kind, permissions, and file hash/link target.
// Internal framework links are allowed; escapes, hard links and special files are not.
async function artifactIdentity(artifactPath, { stageDir } = {}) {
  if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath)) throw new Error('Native artifact must be an absolute local path');
  const input = path.resolve(artifactPath), stat = await fs.lstat(input);
  if (stat.isSymbolicLink()) throw new Error('Native artifact root cannot be a symbolic link');
  const root = await fs.realpath(input), extension = path.extname(root).toLowerCase();
  if (!(stat.isFile() && ['.apk', '.ipa'].includes(extension) || stat.isDirectory() && extension === '.app')) throw new Error('Native artifact must be a local .apk, .ipa or .app bundle');
  const state = { bytes: 0, entries: 0 }, manifest = [];
  const target = stageDir ? await ownedPath(stageDir, path.basename(root), { directory: stat.isDirectory() }) : null;
  if (target && !stat.isDirectory()) await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (stat.isFile()) {
    const file = await hashFile(root, state, target);
    return { artifactSha256: file.sha256, bytes: state.bytes, entries: 1, algorithm: 'sha256', path: target || root, sourcePath: root };
  }
  async function walk(directory, relative = '', depth = 0) {
    if (depth > 40) throw new Error('Native bundle exceeds its directory-depth limit');
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      if (++state.entries > MAX_ENTRIES) throw new Error('Native bundle exceeds its file-count limit');
      const source = path.join(directory, name), rel = relative ? `${relative}/${name}` : name, current = await fs.lstat(source);
      const staged = target ? await ownedPath(target, rel) : null;
      if (current.isSymbolicLink()) {
        const link = await fs.readlink(source);
        if (path.isAbsolute(link) || !inside(root, path.resolve(path.dirname(source), link)) || !inside(root, await fs.realpath(source))) throw new Error('Native bundle contains an external or unsafe symbolic link');
        manifest.push([rel, 'symlink', link]);
        if (staged) await fs.symlink(link, staged);
      } else if (current.isDirectory()) {
        manifest.push([rel, 'directory', current.mode & 0o777]);
        if (staged) { await fs.mkdir(staged, { mode: current.mode & 0o777 }); await fs.chmod(staged, current.mode & 0o777); }
        await walk(source, rel, depth + 1);
      } else if (current.isFile()) {
        const file = await hashFile(source, state, staged);
        manifest.push([rel, 'file', file.mode, file.bytes, file.sha256]);
      } else throw new Error('Native bundle contains a special file');
    }
  }
  await walk(root);
  if (!manifest.length) throw new Error('Native app bundle is empty');
  return { artifactSha256: digest(`patchsentry-native-tree-v1\0${JSON.stringify(manifest)}`), bytes: state.bytes, entries: state.entries,
    algorithm: 'patchsentry-native-tree-v1', path: target || root, sourcePath: root };
}
module.exports = { artifactIdentity, MAX_BYTES, MAX_ENTRIES };
