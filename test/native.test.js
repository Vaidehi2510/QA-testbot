const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { runNativeAudit, validateNativeSuite, capabilitiesFor, ELEMENT } = require('../src/native/audit');
const { NativeClient, nativeEndpoint } = require('../src/native/client');
const { artifactIdentity } = require('../src/native/artifact');
const { parseArgs } = require('../src/native/cli');
const revision = 'a'.repeat(40), metadata = { repository: 'fixture/mobile', revision, prNumber: 7 };
const env = { QA_NATIVE_ENABLED: 'true', QA_NATIVE_DEVICE_ID: 'emulator-5554', OPENROUTER_API_KEY: 'sk-or-v1-neversendthissecret', GITHUB_TOKEN: 'ghp_neversendthissecret' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=';
const steps = [{ action: 'fill', locator: { using: 'accessibilityId', value: 'Email address' }, value: 'synthetic@example.invalid' },
  { action: 'click', locator: { using: 'id', value: 'submit' } }, { action: 'expectText', locator: { using: 'xpath', value: '//*[@name="status"]' }, text: 'Ready' }];
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-native-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const build = path.join(root, 'build'); await fs.mkdir(build); const artifactPath = path.join(build, 'Fixture.apk'); await fs.writeFile(artifactPath, 'synthetic inert apk bytes');
  const attestationPath = path.join(root, 'attestation.json'), identity = await artifactIdentity(artifactPath);
  await fs.writeFile(attestationPath, JSON.stringify({ ...metadata, prNumber: undefined, artifactSha256: identity.artifactSha256 }));
  const requests = [], sessions = []; let count = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    const send = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ value })); };
    if (options.onRequest) await options.onRequest({ request, body, artifactPath });
    if (request.url === '/session' && request.method === 'POST') {
      if (options.redirect) { response.writeHead(307, { location: options.redirect }); response.end(); return; }
      if (options.truncatedSession) { response.writeHead(200); response.end('{"value":'); return; }
      const id = options.reuseSession ? 'reused-session' : `session-${++count}`; sessions.push(id);
      const capabilities = options.normalizedCaps ? Object.fromEntries(Object.entries(body.capabilities.alwaysMatch).map(([key, value]) => [key.replace(/^appium:/, ''), value])) : body.capabilities.alwaysMatch;
      return send({ sessionId: id, capabilities: { ...capabilities, ...(options.capabilities || {}) } });
    }
    if (request.method === 'DELETE') {
      if (options.malformedDelete) return send({ deleted: true });
      if (options.cleanupFails) { response.writeHead(500); response.end(JSON.stringify({ value: { error: 'unknown error', message: 'sensitive server detail' } })); return; }
      return send(null);
    }
    if (request.url.endsWith('/elements')) {
      if (options.truncated) { response.writeHead(200); response.end('{"value":['); return; }
      if (options.delay) { setTimeout(() => { if (!response.destroyed) send([{ [ELEMENT]: 'element-1' }]); }, options.delay).unref(); return; }
      if (options.huge) { response.writeHead(200, { 'content-length': '999999999' }); response.end(); return; }
      return send(Array.from({ length: options.ambiguous ? 2 : 1 }, (_, index) => ({ [ELEMENT]: `element-${index + 1}` })));
    }
    if (request.url.endsWith('/displayed')) return send(options.visible !== false);
    if (request.url.endsWith('/text')) return send(options.actualText ?? 'Ready');
    if (request.url.endsWith('/screenshot')) return send(options.badScreenshot ? 'eA==' : png);
    if (options.malformedWrite) return send({ success: true });
    return send(null);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const suite = { targetEnvironment: 'disposable-device', deviceId: 'emulator-5554', serverUrl: `http://127.0.0.1:${server.address().port}`, artifactPath, attestationPath,
    capabilities: { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': 'emulator-5554', 'appium:deviceName': 'Dedicated synthetic emulator' },
    journeys: [{ name: 'Synthetic form', steps }], captureScreenshots: true, timeoutMs: 5000, requestTimeoutMs: 1000 };
  return { root, build, artifactPath, attestationPath, suite, requests, sessions, outputDir: path.join(root, 'bot-output') };
}

test('native protocol performs fixed interactions against attested staged builds with fresh sessions and cleanup, never sending integration secrets', async t => {
  const f = await fixture(t);
  f.suite.journeys.push({ name: 'Second clean native session', steps: [{ action: 'expectVisible', locator: { using: 'id', value: 'submit' } }] });
  const before = await fs.readFile(f.artifactPath);
  const result = await runNativeAudit({ ...f, metadata, env });
  assert.equal(result.result.status, 'passed', JSON.stringify(result)); assert.equal(result.result.counts.passed, 2); assert.equal(result.revisionVerified, true);
  assert.equal(f.sessions.length, 2); assert.notEqual(f.sessions[0], f.sessions[1]); assert.equal(f.requests.filter(item => item.method === 'DELETE').length, 2);
  assert.equal(result.screenshots.length, 2); assert.deepEqual(await fs.readFile(f.artifactPath), before);
  const caps = f.requests[0].body.capabilities.alwaysMatch;
  assert.notEqual(caps['appium:app'], f.artifactPath); assert.match(caps['appium:app'], /bot-output\/staging/);
  assert.equal(caps['appium:noReset'], false); assert.equal(caps['appium:fullReset'], true);
  await assert.rejects(fs.stat(caps['appium:app']), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(f.requests), /neversendthissecret|execute\/|\/shell|environment|arguments/);
  const report = JSON.parse(await fs.readFile(path.join(f.outputDir, result.result.evidence[0].path)));
  assert.equal(report.artifact.sha256, (await artifactIdentity(f.artifactPath)).artifactSha256);
});

test('native expected text is exact, ambiguous selectors fail, and failure always deletes its session', async t => {
  for (const scenario of [{ actualText: 'Ready but incorrect' }, { ambiguous: true }, { visible: false }]) {
    const f = await fixture(t, scenario), result = await runNativeAudit({ ...f, metadata, env });
    assert.equal(result.result.status, 'failed', JSON.stringify(result)); assert.equal(result.result.counts.failed, 1); assert.equal(f.requests.at(-1).method, 'DELETE');
  }
});

test('stale revisions, mismatched hashes and missing enrollment block all device calls', async t => {
  const f = await fixture(t);
  for (const change of [
    { metadata: { ...metadata, revision: 'b'.repeat(40) }, env },
    { metadata, env: { ...env, QA_NATIVE_ENABLED: 'false' } },
    { metadata, env: { ...env, QA_NATIVE_DEVICE_ID: 'someone-elses-phone' } },
  ]) {
    const result = await runNativeAudit({ ...f, ...change }); assert.equal(result.result.status, 'blocked'); assert.equal(result.revisionVerified, false);
  }
  await fs.writeFile(f.artifactPath, 'changed untrusted build');
  const result = await runNativeAudit({ ...f, metadata, env }); assert.equal(result.result.status, 'blocked'); assert.equal(f.requests.length, 0);
});

test('driver artifact/device identity mismatch blocks evidence and cleans the reported session', async t => {
  const f = await fixture(t, { capabilities: { 'appium:udid': 'wrong-device' } });
  const result = await runNativeAudit({ ...f, metadata, env });
  assert.equal(result.result.status, 'blocked'); assert.equal(result.revisionVerified, false); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].method, 'DELETE');
});

test('truncated and oversized native responses do not pass and cleanup still occurs', async t => {
  for (const scenario of [{ truncated: true }, { huge: true }]) {
    const f = await fixture(t, scenario), result = await runNativeAudit({ ...f, metadata, env });
    assert.equal(result.result.status, 'execution_error', JSON.stringify(result)); assert.equal(f.requests.at(-1).method, 'DELETE');
  }
  const f = await fixture(t, { truncatedSession: true }), result = await runNativeAudit({ ...f, metadata, env });
  assert.equal(result.result.status, 'blocked'); assert.match(result.limitations.join('\n'), /unknown session/);
});

test('native request deadlines and limits fail closed while reserving cleanup', async t => {
  const slow = await fixture(t, { delay: 1000 }); slow.suite.requestTimeoutMs = 100;
  const timed = await runNativeAudit({ ...slow, metadata, env }); assert.equal(timed.result.status, 'blocked'); assert.equal(slow.requests.at(-1).method, 'DELETE');
  const f = await fixture(t); f.suite.maxRequests = 5;
  const exhausted = await runNativeAudit({ ...f, metadata, env }); assert.equal(exhausted.result.status, 'blocked'); assert.equal(f.requests.at(-1).method, 'DELETE');
  assert.equal(exhausted.requests, 5);
});

test('cleanup failure quarantines the enrolled device rather than starting further journeys', async t => {
  const f = await fixture(t, { cleanupFails: true });
  f.suite.journeys.push({ name: 'Must not execute after failed cleanup', steps });
  const result = await runNativeAudit({ ...f, metadata, env }); assert.equal(result.result.status, 'blocked'); assert.equal(f.sessions.length, 1);
  assert.ok(result.observations.some(value => value.name.includes('Must not execute') && value.status === 'blocked'));
  await fs.access(f.requests[0].body.capabilities.alwaysMatch['appium:app']);
});

test('artifact mutation during execution invalidates all passes and screenshots', async t => {
  const f = await fixture(t, { onRequest: async ({ request, artifactPath }) => { if (request.method === 'DELETE') await fs.writeFile(artifactPath, 'changed after session'); } });
  const result = await runNativeAudit({ ...f, metadata, env });
  assert.equal(result.result.status, 'blocked'); assert.equal(result.revisionVerified, false); assert.equal(result.result.counts.passed, 0); assert.equal(result.screenshots.length, 0);
});

test('invalid screenshot evidence blocks its requested coverage instead of accepting arbitrary returned bytes', async t => {
  const f = await fixture(t, { badScreenshot: true }), result = await runNativeAudit({ ...f, metadata, env });
  assert.equal(result.result.status, 'blocked'); assert.deepEqual(result.screenshots, []);
});

test('native enrollment rejects scripts, arbitrary capabilities, keyboard commands, remote endpoints and product output paths', async t => {
  const f = await fixture(t);
  for (const change of [{ capabilities: { ...f.suite.capabilities, 'appium:prerun': 'do shell script "whoami"' } },
    { capabilities: { ...f.suite.capabilities, 'appium:environment': { SECRET: 'sensitive' } } },
    { capabilities: { ...f.suite.capabilities, 'appium:app': 'https://evil.invalid/app.apk' } },
    { journeys: [{ name: 'bad', steps: [{ action: 'execute', script: 'mobile: shell' }] }] },
    { journeys: [{ name: 'bad keys', steps: [{ action: 'fill', locator: { using: 'id', value: 'input' }, value: '\uE03Dterminal' }, steps[2]] }] },
    { targetEnvironment: 'production' }]) assert.throws(() => validateNativeSuite({ ...f.suite, ...change }, metadata));
  for (const endpoint of ['http://localhost:4723', 'http://127.1:4723', 'https://remote.invalid', 'http://127.0.0.1:4723?url=evil', 'http://user:pass@127.0.0.1:4723', 'http://127.0.0.1:4723/execute']) assert.throws(() => nativeEndpoint(endpoint));
  await assert.rejects(runNativeAudit({ ...f, outputDir: path.join(f.build, 'output'), metadata, env }), /outside the product/);
  const client = new NativeClient({ serverUrl: f.suite.serverUrl, timeoutMs: 1000, requestTimeoutMs: 1000, maxRequests: 10 });
  await assert.rejects(client.request('POST', '/session/a/execute/sync', { script: 'mobile: shell' }), /allowlist/);
  assert.equal(f.requests.length, 0);
  assert.throws(() => parseArgs(['--suite', '/suite', '--shell', 'x']));
});

test('native endpoint redirects never reach another host or server', async t => {
  let reached = 0;
  const target = http.createServer((_request, response) => { reached++; response.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => target.close(resolve)));
  const f = await fixture(t, { redirect: `http://127.0.0.1:${target.address().port}/session` });
  const result = await runNativeAudit({ ...f, metadata, env }); assert.equal(result.result.status, 'blocked'); assert.equal(reached, 0);
});

test('app bundle hashes are deterministic across staging and reject escaping symlinks and hard links', async t => {
  const f = await fixture(t), app = path.join(f.build, 'Fixture.app');
  await fs.mkdir(path.join(app, 'Contents', 'Frameworks'), { recursive: true });
  await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>example.fixture</string></dict></plist>');
  await fs.writeFile(path.join(app, 'Contents', 'Frameworks', 'binary'), 'inert test bytes', { mode: 0o755 });
  await fs.symlink('binary', path.join(app, 'Contents', 'Frameworks', 'Current'));
  const first = await artifactIdentity(app), staging = path.join(f.root, 'staging'); await fs.mkdir(staging);
  const copy = await artifactIdentity(app, { stageDir: staging });
  assert.equal(first.artifactSha256, copy.artifactSha256); assert.equal(first.artifactSha256, (await artifactIdentity(copy.path)).artifactSha256);
  const mac = validateNativeSuite({ ...f.suite, deviceId: 'qa-mac-vm', artifactPath: app,
    capabilities: { platformName: 'mac', 'appium:automationName': 'Mac2', 'appium:bundleId': 'example.fixture' } }, metadata);
  const caps = capabilitiesFor(mac, copy.path); assert.equal(caps['appium:appPath'], copy.path); assert.equal(caps['appium:app'], undefined); assert.equal(caps['appium:skipAppKill'], false);
  await fs.symlink(f.artifactPath, path.join(app, 'outside')); await assert.rejects(artifactIdentity(app), /external|unsafe/); await fs.unlink(path.join(app, 'outside'));
  await fs.link(f.artifactPath, path.join(app, 'hardlink')); await assert.rejects(artifactIdentity(app), /unsafe/);
});

test('iOS and Mac2 support Appium normalized capabilities without accepting conflicting aliases', async t => {
  for (const platform of ['iOS', 'mac']) {
    const f = await fixture(t, { normalizedCaps: true });
    const artifactPath = path.join(f.build, platform === 'mac' ? 'MacFixture.app' : 'iOSFixture.ipa');
    if (platform === 'mac') { await fs.mkdir(artifactPath); await fs.writeFile(path.join(artifactPath, 'Info.plist'), 'synthetic inert app bundle'); }
    else await fs.writeFile(artifactPath, 'synthetic inert ipa');
    const identity = await artifactIdentity(artifactPath), deviceId = platform === 'mac' ? 'qa-mac-vm' : 'ios-simulator-01';
    await fs.writeFile(f.attestationPath, JSON.stringify({ repository: metadata.repository, revision, artifactSha256: identity.artifactSha256 }));
    f.suite = { ...f.suite, artifactPath, deviceId, capabilities: { platformName: platform, 'appium:automationName': platform === 'mac' ? 'Mac2' : 'XCUITest',
      'appium:bundleId': 'example.fixture', ...(platform === 'mac' ? {} : { 'appium:udid': deviceId }) } };
    const result = await runNativeAudit({ ...f, metadata, env: { ...env, QA_NATIVE_DEVICE_ID: deviceId } });
    assert.equal(result.result.status, 'passed', JSON.stringify(result));
    assert.equal(f.requests[0].body.capabilities.alwaysMatch[platform === 'mac' ? 'appium:appPath' : 'appium:app'].endsWith(path.basename(artifactPath)), true);
  }
  const conflict = await fixture(t, { capabilities: { udid: 'conflicting-device' } });
  const blocked = await runNativeAudit({ ...conflict, metadata, env }); assert.equal(blocked.result.status, 'blocked');
});

test('executePlan native runner preserves exact revision, common screenshot/check identity, status and read-only synthetic product', async t => {
  const f = await fixture(t), cwd = path.join(f.root, 'product'); await fs.mkdir(cwd);
  const previousEnabled = process.env.QA_NATIVE_ENABLED, previousDevice = process.env.QA_NATIVE_DEVICE_ID;
  process.env.QA_NATIVE_ENABLED = 'true'; process.env.QA_NATIVE_DEVICE_ID = 'emulator-5554';
  t.after(() => {
    if (previousEnabled === undefined) delete process.env.QA_NATIVE_ENABLED; else process.env.QA_NATIVE_ENABLED = previousEnabled;
    if (previousDevice === undefined) delete process.env.QA_NATIVE_DEVICE_ID; else process.env.QA_NATIVE_DEVICE_ID = previousDevice;
  });
  const outputDir = path.join(f.root, 'executor-output');
  const result = await require('../src/executor').executePlan({ plan: { checks: [{ id: 'runner-native', method: 'automated', runner: 'native' }] },
    config: { runners: [{ id: 'native', type: 'native-app', suite: f.suite }] }, cwd, metadata: { ...metadata, runId: 'fixture-run', attempt: 1, fixture: true },
    outputDir, isolation: 'process', allowLocal: true });
  assert.equal(result.results[0].status, 'passed', JSON.stringify(result)); assert.equal(result.results[0].checkId, 'runner-native');
  assert.equal(result.revision, revision); assert.equal(result.execution.nativeDevice, true);
  assert.equal(result.screenshots[0].checkId, 'runner-native'); assert.equal(result.screenshots[0].revision, revision);
  assert.match(result.screenshots[0].path, /^screenshots\/[a-f0-9]{64}\.png$/);
  await fs.access(path.join(outputDir, result.screenshots[0].path)); await fs.access(path.join(outputDir, result.results[0].evidence[0].path));
  assert.deepEqual(await fs.readdir(cwd), []);
});

test('malformed native action/cleanup acknowledgements and reused or non-reset sessions cannot pass', async t => {
  for (const scenario of [{ malformedWrite: true }, { malformedDelete: true }, { capabilities: { 'appium:noReset': true } }, { reuseSession: true }]) {
    const f = await fixture(t, scenario);
    f.suite.journeys.push({ name: 'Independent native state', steps });
    const result = await runNativeAudit({ ...f, metadata, env });
    assert.notEqual(result.result.status, 'passed', JSON.stringify(result));
    if (scenario.malformedDelete) { assert.equal(f.sessions.length, 1); await fs.access(f.requests[0].body.capabilities.alwaysMatch['appium:app']); }
    if (scenario.reuseSession) { assert.equal(result.revisionVerified, false); assert.equal(result.result.counts.passed, 0); }
  }
});
