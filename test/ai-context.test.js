const test = require('node:test');
const assert = require('node:assert/strict');
const { createContext, redact, glob, validPath } = require('../src/ai/context');

const revision = 'a'.repeat(40);
const fixture = () => ({ revision, body: 'Reject missing user names.', repository: 'example/app',
  files: [{ filename: 'src/profile.js', patch: '+return user.name.trim();' }],
  sourceFiles: [{ path: 'src/profile.js', content: 'function save(user) {\n  return user.name.trim();\n}' },
    { path: 'src/other.js', content: 'module.exports = 1;' }],
  existingTests: [{ path: 'test/profile.test.js', content: 'assert.throws(() => save({}));' }],
  specifications: [{ path: 'docs/profile.md', content: 'Reject missing user names.' }],
  repositoryFiles: ['src/profile.js', 'src/other.js', 'src/not-captured.js', '.env', 'private/secret.json'] });

test('snapshot tools read only captured source and never follow traversal or missing paths', () => {
  const context = createContext(fixture());
  assert.match(context.executeTool('read_file', { path: 'src/profile.js', startLine: 2, endLine: 2 }).content, /^2:   return/);
  assert.match(context.executeTool('read_file', { path: '../../etc/passwd' }).error, /approved/);
  assert.match(context.executeTool('read_file', { path: 'src/not-captured.js' }).error, /approved/);
  assert.match(context.executeTool('exec', { cmd: 'rm -rf /' }).error, /Unknown tool/);
  assert.equal(context.executeTool('list_files').files.find((file) => file.path === 'src/not-captured.js').captured, false);
});

test('paths, include patterns, excludes and sensitive files are enforced for every tool', () => {
  const pr = fixture();
  pr.sourceFiles.push({ path: '.env.production', content: 'PASSWORD=unredacted' }, { path: 'secrets.json', content: 'sensitive' }, { path: 'src/private.js', content: 'sensitive' });
  const context = createContext(pr, { includePaths: ['src/**'], excludePaths: ['src/private.*'] });
  assert.deepEqual(context.inventory.availableFiles.map((file) => file.path), ['src/profile.js', 'src/other.js']);
  assert.deepEqual(context.executeTool('search_code', { query: 'sensitive' }).matches, []);
  assert.ok(!JSON.stringify(context.inventory).includes('.env'));
  assert.ok(!context.knownFiles.has('src/private.js'));
  assert.equal(validPath('/etc/passwd'), false);
  assert.equal(validPath('src/../secret'), false);
  assert.equal(validPath('src\\file.js'), false);
  assert.equal(glob('**/*.js', 'src/profile.js'), true);
  assert.equal(glob('**/*.js', 'profile.js'), true);
  assert.equal(glob('src/*', 'src/nested/profile.js'), false);
});

test('source, PR text, and logs redact common credentials before model access', () => {
  const pr = fixture();
  const token = 'sk-or-v1-' + 'a'.repeat(40);
  pr.body = `Use token ${token}`;
  pr.sourceFiles[0].content += `\nconst api_key = "verysecretvalue";\nconst auth = "Bearer abcdefghijklmnop";`;
  const context = createContext(pr);
  assert.ok(!context.inventory.requirements.includes(token));
  const source = context.executeTool('read_file', { path: 'src/profile.js' });
  assert.ok(!source.content.includes('verysecretvalue'));
  assert.ok(!source.content.includes('abcdefghijklmnop'));
  const result = context.executeTool('get_test_results', {}, [{ checkId: 'base', status: 'failed', details: token, evidence: [{ excerpt: token }] }]);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.match(redact('-----BEGIN PRIVATE KEY-----\nsensitive\n-----END PRIVATE KEY-----'), /REDACTED/);
  assert.deepEqual(JSON.parse(redact('{"api_key":"verysecretvalue"}')), { api_key: '[REDACTED]' });
});

test('search is literal, bounded, and citations require actually supplied content', () => {
  const context = createContext(fixture());
  assert.deepEqual(context.executeTool('search_code', { query: '.*' }).matches, []);
  assert.match(context.executeTool('search_code', { query: '' }).error, /1–200/);
  assert.equal(context.verifyCitation({ file: 'src/profile.js', quote: 'return user.name.trim();' }), true);
  assert.equal(context.verifyCitation({ file: 'src/profile.js', quote: 'invented code' }), false);
  assert.equal(context.verifyCitation({ file: 'src/other.js', quote: 'module.exports = 1;' }), false);
  context.executeTool('read_file', { path: 'src/other.js' });
  assert.equal(context.verifyCitation({ file: 'src/other.js', quote: 'module.exports = 1;' }), true);
});

test('truncation is surfaced and does not expose uncaptured content', () => {
  const pr = fixture();
  pr.sourceFiles[0].content = 'x'.repeat(17000) + 'not-present';
  const context = createContext(pr, { maxInputChars: 2000 });
  assert.ok(context.limitations.some((entry) => entry.includes('truncated')));
  assert.equal(context.executeTool('search_code', { query: 'not-present' }).matches.length, 0);
});

test('only explicitly allowed same-revision images are passed to vision review', () => {
  const pr = { ...fixture(), screenshots: [{ name: 'profile.png', mimeType: 'image/png', data: 'YWJj', revision },
    { name: 'stale.png', mimeType: 'image/png', data: 'YWJj', revision: 'b'.repeat(40) }] };
  assert.equal(createContext(pr).screenshots.length, 0);
  const context = createContext(pr, { allowImages: true });
  assert.equal(context.screenshots.length, 1);
  assert.ok(context.limitations.some((entry) => entry.includes('excluded')));
});

test('test results from another revision cannot be used as evidence', () => {
  const context = createContext(fixture());
  const result = context.executeTool('get_test_results', {}, [
    { checkId: 'stale', revision: 'b'.repeat(40), status: 'passed' }, { checkId: 'current', revision, status: 'failed' },
  ]);
  assert.deepEqual(result.results.map((entry) => entry.checkId), ['current']);
  assert.equal(context.knownChecks.has('stale'), false);
  assert.equal(context.knownChecks.has('current'), true);
});

test('test files also captured as source retain their requirement-source identity', () => {
  const pr = fixture();
  pr.sourceFiles.push(pr.existingTests[0]);
  const context = createContext(pr);
  assert.equal(context.requirementSources.has('test/profile.test.js'), true);
});
