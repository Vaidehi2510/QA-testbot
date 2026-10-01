// Read immutable Git objects as data. Never import or execute target code here.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { glob, validPath } = require('./context');
const { screenshotType } = require('../images');
const gitExec = promisify(execFile);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_FILE = 24000;
const MAX_FILES = 80;
const NEVER_SEND = /(^|\/)(\.git|node_modules|vendor|\.npmrc|\.netrc|id_rsa|id_ed25519|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)(\/|$)|\.(pem|key|p12|pfx|keystore)$/i;
const TEXT = /\.(?:[cm]?[jt]sx?|json|css|scss|html?|md|txt|ya?ml|py|go|rs|java|rb|sql|vue|svelte|sh|toml)$/i;
function globMatches(filename, pattern) { return glob(pattern, filename); }

function allowedPath(filename, ai = {}) {
  return validPath(filename) && !NEVER_SEND.test(filename)
    && (ai.includePaths || ['**']).some(pattern => globMatches(filename, pattern))
    && !(ai.excludePaths || []).some(pattern => globMatches(filename, pattern));
}
function selectSources(entries, changed, ai) {
  const changePaths = changed.map(file => typeof file === 'string' ? file : file.filename);
  const directories = new Set(changePaths.map(filename => path.posix.dirname(filename)));
  const ranking = file => changePaths.includes(file.path) ? 0 : directories.has(path.posix.dirname(file.path)) ? 1 : /README|package\.json|test|spec/i.test(file.path) ? 2 : 3;
  return entries.filter(file => (file.type === 'blob' || !file.type) && allowedPath(file.path, ai) && TEXT.test(file.path) && (!file.mode || file.mode !== '120000'))
    .sort((a, b) => ranking(a) - ranking(b) || a.path.localeCompare(b.path)).slice(0, Math.min(ai.maxFiles || MAX_FILES, 200));
}
async function loadSources(entries, changed, ai, read) {
  const candidates = selectSources(entries, changed, ai);
  const sourceFiles = [], limitations = [];
  let remaining = Math.min(ai.maxInputChars || 100000, 500000);
  for (const file of candidates) {
    if (remaining <= 0) break;
    const limit = Math.min(ai.maxFileChars || MAX_FILE, remaining, MAX_FILE);
    if (file.size > MAX_FILE * 8) { limitations.push(`Source file exceeds the inspection size limit: ${file.path}`); continue; }
    try {
      const full = await read(file);
      if (full.includes('\0')) continue;
      const content = full.slice(0, limit);
      sourceFiles.push({ path: file.path, content, truncated: content.length < full.length });
      remaining -= content.length;
      if (content.length < full.length) limitations.push(`Source excerpt truncated: ${file.path}`);
    } catch { limitations.push(`Source unavailable: ${file.path}`); }
  }
  const repositoryFiles = entries.filter(file => (file.type === 'blob' || !file.type) && allowedPath(file.path, ai)).map(file => file.path);
  if (sourceFiles.length < repositoryFiles.length) limitations.push(`Snapshot includes ${sourceFiles.length} source files from ${repositoryFiles.length} allowed repository paths; uninspected files remain outside this review.`);
  return { sourceFiles, repositoryFiles, aiLimitations: limitations };
}

async function githubSnapshot(gh, owner, repo, revision, entries, files, ai) {
  return loadSources(entries, files, ai, async entry => {
    const { data } = await gh.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
    return Buffer.from(data.content, 'base64').toString('utf8');
  });
}
async function git(cwd, args, options = {}) {
  const { stdout } = await gitExec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 3 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, ...options });
  return stdout;
}
async function localSnapshot({ repositoryPath, base = 'main', head = 'HEAD', config, repository, number = 1, title, body = '', author = 'local-reviewer' }) {
  const cwd = path.resolve(repositoryPath);
  // --end-of-options prevents refs supplied at the CLI from becoming git flags.
  const revision = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`])).trim();
  const baseRevision = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
  const rawTree = await git(cwd, ['ls-tree', '-r', '-z', '-l', revision]);
  const entries = rawTree.split('\0').filter(Boolean).map(line => {
    const separator = line.indexOf('\t');
    const meta = line.slice(0, separator), filename = line.slice(separator + 1);
    const [mode, type, sha, size] = meta.trim().split(/\s+/);
    return { mode, type, sha, size: Number(size), path: filename };
  });
  const changed = (await git(cwd, ['diff', '--name-only', '-z', baseRevision, revision, '--'])).split('\0').filter(Boolean);
  const files = [];
  for (const filename of changed.slice(0, 100)) {
    const allowed = allowedPath(filename, config.ai || {});
    let patch = '';
    if (allowed) {
      try { patch = (await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--unified=5', baseRevision, revision, '--', filename])).slice(0, 16000); }
      catch { patch = ''; }
    }
    files.push({ filename, patch, status: entries.some(entry => entry.path === filename) ? 'modified' : 'removed' });
  }
  const source = await loadSources(entries, files, config.ai || {}, entry => git(cwd, ['cat-file', 'blob', entry.sha]));
  const specifications = [];
  for (const filename of config.specificationPaths || []) {
    const file = source.sourceFiles.find(item => item.path === filename);
    if (file) specifications.push(file);
  }
  return { repository: repository || `local/${path.basename(cwd).replace(/[^\w.-]/g, '-')}`, number, title: title || `Review ${head} against ${base}`, author,
    body, revision, baseRevision, files, ...source, specifications,
    existingTests: source.sourceFiles.filter(file => /test|spec/i.test(file.path)), comments: [],
    inspectionLimitations: changed.length > 100 ? ['Only the first 100 changed paths were inspected.'] : [] };
}

async function readScreenshots(manifestPath, revision) {
  if (!manifestPath) return [];
  const root = path.dirname(path.resolve(manifestPath));
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.revision !== revision) throw new Error('Screenshots must be tied to the exact reviewed revision');
  if (!Array.isArray(manifest.images) || manifest.images.length > 4) throw new Error('Screenshot manifest supports up to four PNG/JPEG images');
  const images = [];
  let total = 0;
  for (const item of manifest.images) {
    if (!item.path || path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..')) throw new Error('Screenshot path escapes its manifest directory');
    const filename = await fs.realpath(path.join(root, item.path));
    if (!filename.startsWith(`${await fs.realpath(root)}${path.sep}`)) throw new Error('Screenshot symlink escapes its manifest directory');
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Screenshot exceeds the 2 MiB limit');
    const bytes = await fs.readFile(filename);
    total += bytes.length;
    if (total > 6 * 1024 * 1024) throw new Error('Screenshot set exceeds the 6 MiB limit');
    const type = screenshotType(bytes);
    if (!type) throw new Error('Screenshot is not a valid, bounded PNG or JPEG image');
    images.push({ name: item.name || item.path, mimeType: type.mimeType, data: bytes.toString('base64'), revision,
      sha256: sha256(bytes), viewport: item.viewport, environment: manifest.environment || 'provided screenshot' });
  }
  return images;
}
module.exports = { allowedPath, globMatches, selectSources, loadSources, githubSnapshot, localSnapshot, readScreenshots };
