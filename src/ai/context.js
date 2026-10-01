// The model sees a bounded, redacted snapshot. These tools never touch the filesystem.
const path = require('node:path');

const DEFAULT_EXCLUDES = /(^|\/)(?:\.git|node_modules|vendor|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_rsa|id_ed25519)(?:\/|$)|\.(?:pem|key|p12|pfx|keystore)$/i;

function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED KEY MATERIAL]')
    .replace(/\b(?:sk-or-v1-|sk-proj-|sk-ant-|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|pst_)[A-Za-z0-9_-]{10,}/g, '[REDACTED TOKEN]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED ACCESS KEY]')
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)["']?)\s*[=:]\s*)(["']?)[^\s"',;\n]{6,}\2/gi, '$1$2[REDACTED]$2')
    .replace(/\bBearer\s+[A-Za-z0-9_.+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 400 &&
    !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) &&
    !value.split('/').some((part) => part === '..' || part === '.' || !part);
}

function glob(pattern, value) {
  if (typeof pattern !== 'string' || pattern.length > 400) return false;
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { expression += '(?:.*/)?'; i++; } else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(value);
}

function createContext(pr, config = {}) {
  const limitations = (pr.aiLimitations || []).filter((entry) => typeof entry === 'string').map((entry) => redact(entry).slice(0, 2000));
  const files = new Map();
  const allowed = (filename) => validPath(filename) && !DEFAULT_EXCLUDES.test(filename) &&
    (config.includePaths || ['**']).some((pattern) => glob(pattern, filename)) &&
    !(config.excludePaths || []).some((pattern) => glob(pattern, filename));
  const maxChars = Math.max(1000, Math.min(config.maxInputChars || 100000, 1000000));
  const maxFileChars = Math.min(16000, maxChars);
  const maxFiles = 150;
  let storedChars = 0;
  let excluded = 0;
  const truncated = [];
  const add = (filename, content, kind) => {
    if (!allowed(filename)) { excluded++; return; }
    if (files.size >= maxFiles && !files.has(filename)) { truncated.push(filename); return; }
    const previous = files.get(filename);
    if (previous && previous.kind !== 'patch') return;
    if (typeof content !== 'string') return;
    const clean = redact(content);
    const room = Math.max(0, maxChars - storedChars + (previous?.content.length || 0));
    const bounded = clean.slice(0, Math.min(maxFileChars, room));
    if (bounded.length < clean.length) truncated.push(filename);
    if (!bounded && clean) return;
    storedChars += bounded.length - (previous?.content.length || 0);
    files.set(filename, { path: filename, kind, content: bounded, truncated: bounded.length < clean.length });
  };
  // Requirements and changed source take precedence over unrelated inventory.
  for (const spec of pr.specifications || []) add(spec.path, spec.content, 'requirement');
  for (const source of pr.sourceFiles || []) add(source.path || source.filename, source.content, 'source');
  for (const test of pr.existingTests || []) add(test.path, test.content, 'test');
  for (const file of pr.files || []) if (typeof file === 'object') add(file.filename || file.path, file.patch, 'patch');
  const repositoryPaths = [...new Set([...(pr.repositoryFiles || []).map((entry) => typeof entry === 'string' ? entry : entry.path || entry.filename), ...files.keys()])].filter(allowed).slice(0, 1000);
  const knownFiles = new Set(files.keys());
  const inspectedFiles = new Set();
  const knownChecks = new Set();
  const requirementSources = new Set([...files.values()].filter((file) => ['requirement', 'test'].includes(file.kind)).map((file) => file.path));
  for (const test of pr.existingTests || []) if (files.has(test.path)) requirementSources.add(test.path);
  for (const spec of pr.specifications || []) if (files.has(spec.path)) requirementSources.add(spec.path);
  if (pr.body?.trim()) requirementSources.add('PR description');
  const screenshots = [];
  let imageBytes = 0;
  if (config.allowImages) for (const item of (pr.screenshots || []).slice(0, 4)) {
    if (item.revision !== pr.revision || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType) ||
        typeof item.data !== 'string' || item.data.length > 2796204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) ||
        Buffer.byteLength(item.data, 'base64') > 2097152 || imageBytes + Buffer.byteLength(item.data, 'base64') > 6291456) {
      limitations.push('A screenshot was excluded because its revision, format, or size was invalid.');
      continue;
    }
    imageBytes += Buffer.byteLength(item.data, 'base64');
    screenshots.push({ name: redact(item.name || `screenshot-${screenshots.length + 1}`), mimeType: item.mimeType, data: item.data, revision: pr.revision });
  }
  if (!screenshots.length) limitations.push('UI/UX review is limited to source; no approved screenshots for this revision were available. Browser interactions, layout, accessibility behavior, and visual regressions were not executed by the model.');
  if (excluded) limitations.push(`${excluded} snapshot entries were excluded by path or secret-file policy.`);
  if (truncated.length) limitations.push(`Snapshot content was truncated for ${new Set(truncated).size} files; review coverage is incomplete.`);
  if ((pr.repositoryFiles || []).length > 1000) limitations.push('Repository path inventory was limited to 1000 paths.');
  limitations.push('Secret redaction is best effort; source upload requires repository-owner approval through trusted AI configuration.');
  const overviewLimit = Math.floor(maxChars / 3);
  const changedFiles = [];
  let overviewChars = 0;
  for (const file of pr.files || []) {
    const filename = typeof file === 'string' ? file : file.filename || file.path;
    if (!allowed(filename)) continue;
    const patch = redact(typeof file === 'string' ? '' : file.patch || '').slice(0, Math.max(0, Math.min(6000, overviewLimit - overviewChars)));
    overviewChars += patch.length;
    if (patch) { inspectedFiles.add(filename); knownFiles.add(filename); }
    changedFiles.push({ path: filename, status: file.status, patch, patchTruncated: typeof file.patch === 'string' && patch.length < file.patch.length });
  }
  const inventory = {
    revision: pr.revision, repository: pr.repository, number: pr.number,
    title: redact(pr.title).slice(0, 400), requirements: redact(pr.body).slice(0, 8000),
    changedFiles: changedFiles.slice(0, 100),
    availableFiles: [...files.values()].map(({ path: filename, kind, truncated: cut }) => ({ path: filename, kind, truncated: cut })),
    repositoryFiles: repositoryPaths, screenshotNames: screenshots.map((item) => item.name),
  };
  const tools = [
    { type: 'function', function: { name: 'list_files', description: 'List allowed repository snapshot paths. Listed paths without captured content cannot be read.', parameters: { type: 'object', properties: { prefix: { type: 'string' } }, additionalProperties: false } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a redacted file from the exact revision snapshot. Line numbers are snapshot lines; patch line numbers are not source lines.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } } },
    { type: 'function', function: { name: 'search_code', description: 'Search captured allowed files using a literal string, never a shell command or regular expression.', parameters: { type: 'object', properties: { query: { type: 'string' }, prefix: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
    { type: 'function', function: { name: 'get_test_results', description: 'Read structured test evidence supplied by the trusted executor. A tool cannot execute or change tests.', parameters: { type: 'object', properties: { checkId: { type: 'string' } }, additionalProperties: false } } },
  ];
  function executeTool(name, args = {}, results = []) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'Tool arguments must be an object.' };
    if (name === 'list_files') {
      const prefix = typeof args.prefix === 'string' ? args.prefix : '';
      return { files: repositoryPaths.filter((filename) => filename.startsWith(prefix)).slice(0, 150).map((filename) => ({ path: filename, captured: files.has(filename) })) };
    }
    if (name === 'read_file') {
      const file = files.get(args.path);
      if (!file) return { error: 'File is outside the approved captured snapshot.' };
      const lines = file.content.split('\n');
      const start = Number.isSafeInteger(args.startLine) && args.startLine > 0 ? args.startLine : 1;
      const end = Number.isSafeInteger(args.endLine) && args.endLine >= start ? Math.min(args.endLine, start + 119) : start + 119;
      inspectedFiles.add(file.path);
      return { path: file.path, kind: file.kind, startLine: start, endLine: Math.min(end, lines.length), totalLines: lines.length, truncated: file.truncated || end < lines.length,
        content: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, 12000) };
    }
    if (name === 'search_code') {
      if (typeof args.query !== 'string' || !args.query || args.query.length > 200) return { error: 'A literal query of 1–200 characters is required.' };
      const matches = [];
      for (const file of files.values()) {
        if (typeof args.prefix === 'string' && !file.path.startsWith(args.prefix)) continue;
        for (const [index, line] of file.content.split('\n').entries()) {
          if (!line.toLowerCase().includes(args.query.toLowerCase())) continue;
          inspectedFiles.add(file.path);
          matches.push({ path: file.path, kind: file.kind, line: index + 1, content: line.slice(0, 400) });
          if (matches.length >= 30) return { matches, truncated: true };
        }
      }
      return { matches, truncated: false };
    }
    if (name === 'get_test_results') {
      const selected = results.filter((result) => (!args.checkId || result.checkId === args.checkId) && (!result.revision || result.revision === pr.revision)).slice(0, 50);
      for (const result of selected) if (typeof result.checkId === 'string') knownChecks.add(result.checkId);
      return { revision: pr.revision, results: selected.map((result) => ({ checkId: result.checkId, status: result.status, details: redact(result.details || result.error).slice(0, 2000), counts: result.counts,
        evidence: (Array.isArray(result.evidence) ? result.evidence : []).slice(0, 3).map((entry) => ({ path: entry.path, excerpt: redact(entry.excerpt).slice(0, 2500) })) })) };
    }
    return { error: 'Unknown tool. Only snapshot reads and existing executor results are allowed.' };
  }
  function verifyCitation(entry) {
    if (!knownFiles.has(entry.file) || !inspectedFiles.has(entry.file) || typeof entry.quote !== 'string' || !entry.quote.trim()) return false;
    const source = files.get(entry.file)?.content || '';
    const patch = changedFiles.find((file) => file.path === entry.file)?.patch || '';
    return source.includes(entry.quote) || patch.includes(entry.quote);
  }
  return { tools, executeTool, inventory, limitations, knownFiles, inspectedFiles, knownChecks, requirementSources, screenshots, sanitize: redact, verifyCitation };
}

module.exports = { createContext, redact, validPath, glob };
