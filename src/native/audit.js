const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('../ai/context');
const { screenshotType } = require('../images');
const { outsideProduct, ownedPath, readJson, writeJson, inside } = require('../autonomy/store');
const { artifactIdentity } = require('./artifact');
const { NativeClient, NativeProtocolError, nativeEndpoint } = require('./client');
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, name) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${name} fields`); }
const text = (value, max = 300) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
function bound(value, fallback, min, max, name) { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid native ${name}`); return result; }

function validateNativeSuite(value, metadata) {
  fields(value, ['targetEnvironment', 'serverUrl', 'deviceId', 'artifactPath', 'attestationPath', 'capabilities', 'journeys', 'timeoutMs', 'requestTimeoutMs', 'maxRequests', 'captureScreenshots', 'productRoot'], 'native suite');
  if (value.targetEnvironment !== 'disposable-device' || !id(value.deviceId)) throw new Error('Native QA requires a named enrolled disposable device or VM');
  if (!metadata || !/^[\w.-]+\/[\w.-]+$/.test(metadata.repository || '') || !/^[a-f0-9]{40}$/.test(metadata.revision || '') || !Number.isSafeInteger(metadata.prNumber) || metadata.prNumber < 1) throw new Error('Native QA requires repository, PR and exact revision metadata');
  for (const field of ['artifactPath', 'attestationPath']) if (typeof value[field] !== 'string' || !path.isAbsolute(value[field])) throw new Error(`Native ${field} must be an absolute local path`);
  if (value.productRoot !== undefined && (typeof value.productRoot !== 'string' || !path.isAbsolute(value.productRoot))) throw new Error('Native productRoot must be absolute');
  const capabilities = value.capabilities;
  fields(capabilities, ['platformName', 'appium:automationName', 'appium:deviceName', 'appium:udid', 'appium:bundleId', 'appium:platformVersion'], 'native capabilities');
  const driver = { Android: 'UiAutomator2', iOS: 'XCUITest', mac: 'Mac2' }[capabilities.platformName];
  if (!driver || capabilities['appium:automationName'] !== driver) throw new Error('Choose the matching Android UiAutomator2, iOS XCUITest, or Mac Mac2 driver');
  for (const [key, item] of Object.entries(capabilities)) if (!text(item, 160) || redact(item) !== item) throw new Error(`Invalid native capability ${key}`);
  if (driver === 'Mac2') {
    if (!/^[A-Za-z][\w.-]{2,150}$/.test(capabilities['appium:bundleId'] || '') || capabilities['appium:udid'] !== undefined) throw new Error('Mac2 requires an explicit application bundleId and a dedicated enrolled VM');
  } else if (capabilities['appium:udid'] !== value.deviceId) throw new Error('Mobile capabilities must select the exact enrolled device UDID');
  const extension = path.extname(value.artifactPath).toLowerCase();
  if (driver === 'UiAutomator2' && extension !== '.apk' || driver === 'XCUITest' && !['.ipa', '.app'].includes(extension) || driver === 'Mac2' && extension !== '.app') throw new Error('Native artifact does not match the selected platform');
  if (value.captureScreenshots !== undefined && typeof value.captureScreenshots !== 'boolean') throw new Error('Native captureScreenshots must be boolean');
  if (!Array.isArray(value.journeys) || !value.journeys.length || value.journeys.length > 8) throw new Error('Native suite requires one to eight explicit journeys');
  const names = new Set();
  for (const journey of value.journeys) {
    fields(journey, ['name', 'steps'], 'native journey');
    if (!text(journey.name, 150) || names.has(journey.name) || !Array.isArray(journey.steps) || !journey.steps.length || journey.steps.length > 20) throw new Error('Native journeys need distinct names and one to twenty steps');
    names.add(journey.name); let assertions = 0;
    for (const step of journey.steps) {
      fields(step, ['action', 'locator', 'value', 'text'], 'native step');
      if (!['click', 'fill', 'expectVisible', 'expectText'].includes(step.action)) throw new Error('Native DSL allows only click, fill, expectVisible and exact expectText');
      fields(step.locator, ['using', 'value'], 'native locator');
      if (!['accessibilityId', 'id', 'xpath'].includes(step.locator.using) || !text(step.locator.value, 500)) throw new Error('Invalid bounded native locator');
      if (step.locator.using === 'xpath' && /:\/\/|(?:document|doc|collection|unparsed-text|environment-variable|system-property)\s*\(/i.test(step.locator.value)) throw new Error('Native XPath cannot request external documents or environment data');
      if (step.action === 'fill' && (typeof step.value !== 'string' || step.value.length > 1000 || /[\x00-\x1f\x7f\uE000-\uF8FF]/.test(step.value) || redact(step.value) !== step.value)) throw new Error('Native inputs must be bounded synthetic text, never credentials or keyboard command codes');
      if (step.action !== 'fill' && step.value !== undefined || step.action !== 'expectText' && step.text !== undefined) throw new Error('Native step contains irrelevant values');
      if (step.action === 'expectText' && (!text(step.text, 1000) || redact(step.text) !== step.text)) throw new Error('Native text assertions require explicit safe expected text');
      if (step.action.startsWith('expect')) assertions++;
    }
    if (!assertions) throw new Error('Every native journey requires a trusted expected assertion');
  }
  return { ...structuredClone(value), serverUrl: nativeEndpoint(value.serverUrl), captureScreenshots: value.captureScreenshots === true,
    timeoutMs: bound(value.timeoutMs, 180000, 100, 600000, 'total deadline'), requestTimeoutMs: bound(value.requestTimeoutMs, 30000, 100, 120000, 'request timeout'),
    maxRequests: bound(value.maxRequests, 700, 5, 1000, 'request count') };
}
function capabilitiesFor(suite, stagedPath) {
  const mobile = suite.capabilities.platformName !== 'mac';
  return { ...suite.capabilities, [mobile ? 'appium:app' : 'appium:appPath']: stagedPath, 'appium:noReset': false,
    'appium:newCommandTimeout': 30, ...(mobile ? { 'appium:fullReset': true } : { 'appium:skipAppKill': false }) };
}
function validateSession(value, requested) {
  if (!object(value) || !id(value.sessionId) || !object(value.capabilities)) throw new NativeProtocolError('Native session response did not identify a fresh session', { status: 'blocked' });
  for (const key of ['platformName', 'appium:automationName', 'appium:app', 'appium:appPath', 'appium:udid', 'appium:bundleId', 'appium:noReset', 'appium:fullReset', 'appium:skipAppKill', 'appium:newCommandTimeout']) {
    const alias = key.replace(/^appium:/, ''), explicit = value.capabilities[key], normalized = value.capabilities[alias];
    if (explicit !== undefined && normalized !== undefined && explicit !== normalized) throw new NativeProtocolError('Native driver returned conflicting capability identities', { status: 'blocked' });
    if (requested[key] !== undefined && (explicit === undefined ? normalized : explicit) !== requested[key]) throw new NativeProtocolError('Native driver did not acknowledge the pinned artifact, device, or application identity', { status: 'blocked' });
  }
  return value.sessionId;
}
async function runNativeAudit({ suite: input, metadata, outputDir, checkId = 'native-app-audit', env = process.env, fetchImpl } = {}) {
  const suite = validateNativeSuite(input, metadata);
  if (!text(checkId, 160)) throw new Error('Invalid native check ID');
  const originalStat = await fs.lstat(suite.artifactPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const artifactRoot = originalStat?.isDirectory() ? suite.artifactPath : path.dirname(suite.artifactPath);
  let output = await outsideProduct(path.resolve(outputDir), artifactRoot);
  for (const root of [metadata.productRoot, suite.productRoot].filter(Boolean)) {
    output = await outsideProduct(output, root);
    await outsideProduct(suite.attestationPath, root);
  }
  const attestationCanonical = await fs.realpath(suite.attestationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (attestationCanonical && inside(await fs.realpath(artifactRoot), attestationCanonical)) {
    // For a file build output, an adjacent builder attestation is expected. A
    // bundle-internal attestation would be circular and controlled by app code.
    if (originalStat?.isDirectory()) throw new Error('Native attestation must be outside the application bundle');
  }
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const runId = crypto.randomUUID(), observations = [], screenshots = [], limitations = [
    'Native coverage includes only configured explicit journeys on the enrolled device. Drivers, devices, build signing and disposable VM isolation must be provisioned separately.',
    'Artifact identity is established by a trusted builder attestation and driver acknowledgement. It does not independently prove build provenance or hardware/device isolation.',
    'Fresh native sessions relaunch the app; Mac preferences, keychains and OS data require operator-controlled disposable VM snapshots. This adapter does not isolate an arbitrary app on a normal workstation.',
  ];
  const record = (name, status, details) => observations.push({ name: redact(name).slice(0, 200), status, details: redact(String(details || '')).slice(0, 2000) });
  let revisionVerified = false, identity, staged, staging, client, safeToRemoveStaging = true;
  try {
    if (env.QA_NATIVE_ENABLED !== 'true' || env.QA_NATIVE_DEVICE_ID !== suite.deviceId) throw new NativeProtocolError('Native execution is not enabled for this explicitly enrolled disposable device/VM', { status: 'blocked' });
    const attestation = await readJson(suite.attestationPath);
    fields(attestation, ['schemaVersion', 'repository', 'revision', 'artifactSha256', 'algorithm'], 'native builder attestation');
    if (attestation.schemaVersion !== undefined && attestation.schemaVersion !== 1 || attestation.repository !== metadata.repository || attestation.revision !== metadata.revision || !/^[a-f0-9]{64}$/.test(attestation.artifactSha256 || '')) throw new NativeProtocolError('Native builder attestation does not match the requested repository and revision', { status: 'blocked' });
    identity = await artifactIdentity(suite.artifactPath);
    if (identity.artifactSha256 !== attestation.artifactSha256 || attestation.algorithm && attestation.algorithm !== identity.algorithm) throw new NativeProtocolError('Native artifact hash does not match its trusted builder attestation', { status: 'blocked' });
    staging = await ownedPath(output, `staging/${runId}`, { directory: true });
    staged = await artifactIdentity(suite.artifactPath, { stageDir: staging });
    if (staged.artifactSha256 !== identity.artifactSha256 || (await artifactIdentity(staged.path)).artifactSha256 !== identity.artifactSha256) throw new NativeProtocolError('Native artifact changed during staging', { status: 'blocked' });
    const requested = capabilitiesFor(suite, staged.path);
    client = new NativeClient({ ...suite, fetchImpl });
    let imageBytes = 0; const sessionIds = new Set();
    for (const [journeyIndex, journey] of suite.journeys.entries()) {
      let session, acknowledged = false, quarantine = false;
      try {
        const value = await client.request('POST', '/session', { capabilities: { alwaysMatch: requested, firstMatch: [{}] } });
        if (id(value?.sessionId)) session = value.sessionId; // Always clean up even an identity-mismatched session.
        session = validateSession(value, requested);
        if (sessionIds.has(session)) throw new NativeProtocolError('Native driver reused a previous session ID instead of creating an independent session', { status: 'blocked' });
        sessionIds.add(session); acknowledged = true; revisionVerified = true;
        for (const step of journey.steps) {
          const found = await client.request('POST', `/session/${session}/elements`, { using: step.locator.using === 'accessibilityId' ? 'accessibility id' : step.locator.using, value: step.locator.value });
          if (!Array.isArray(found) || found.length !== 1 || !id(found[0]?.[ELEMENT])) throw new NativeProtocolError('Native locator did not resolve to exactly one element', { status: Array.isArray(found) ? 'failed' : 'execution_error' });
          const element = found[0][ELEMENT], prefix = `/session/${session}/element/${element}`;
          if (step.action === 'click') await client.request('POST', `${prefix}/click`, {});
          else if (step.action === 'fill') { await client.request('POST', `${prefix}/clear`, {}); await client.request('POST', `${prefix}/value`, { text: step.value }); }
          else {
            const displayed = await client.request('GET', `${prefix}/displayed`);
            if (displayed !== true) throw new NativeProtocolError('Expected native element is not visible', { status: 'failed' });
            if (step.action === 'expectText') {
              const actual = await client.request('GET', `${prefix}/text`);
              if (typeof actual !== 'string') throw new NativeProtocolError('Native text response is malformed');
              if (actual !== step.text) throw new NativeProtocolError('Native text does not exactly match the trusted expected value', { status: 'failed' });
            }
          }
        }
        record(journey.name, 'passed', 'All configured native interactions and explicit assertions passed.');
        if (suite.captureScreenshots && screenshots.length < 4) {
          try {
            const encoded = await client.request('GET', `/session/${session}/screenshot`, undefined, { screenshot: true });
            if (typeof encoded !== 'string' || encoded.length > 2796204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Malformed native screenshot');
            const bytes = Buffer.from(encoded, 'base64'), type = screenshotType(bytes);
            if (!type || bytes.length > 2 * 1024 * 1024 || imageBytes + bytes.length > 6 * 1024 * 1024) throw new Error('Native screenshot exceeds image validation or byte limits');
            const relative = `screenshots/${runId}-${screenshots.length}.${type.extension}`;
            await fs.writeFile(await ownedPath(output, relative), bytes, { flag: 'wx', mode: 0o600 });
            screenshots.push({ name: journey.name, path: relative, mimeType: type.mimeType, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), revision: metadata.revision }); imageBytes += bytes.length;
          } catch (error) { record(`${journey.name}: screenshot evidence`, 'blocked', error.message); }
        }
      } catch (error) { record(journey.name, error.status || 'execution_error', error.message); }
      finally {
        if (session) {
          try { await client.request('DELETE', `/session/${session}`, undefined, { cleanup: true }); }
          catch (error) { quarantine = true; safeToRemoveStaging = false; record(`${journey.name}: session cleanup`, 'blocked', 'Native session cleanup failed; discard the disposable device/VM before another job.'); }
        } else if (client?.requests) { quarantine = true; safeToRemoveStaging = false; limitations.push('If session creation was interrupted before its ID arrived, discard this disposable device/VM; cleanup cannot address an unknown session.'); }
      }
      if (!acknowledged) { revisionVerified = false; quarantine = true; }
      if (quarantine) { for (const skipped of suite.journeys.slice(journeyIndex + 1)) record(skipped.name, 'blocked', 'Further sessions are blocked until the enrolled disposable device/VM is reset.'); break; }
    }
    if ((await artifactIdentity(suite.artifactPath)).artifactSha256 !== identity.artifactSha256 || (await artifactIdentity(staged.path)).artifactSha256 !== identity.artifactSha256) {
      revisionVerified = false; record('Native artifact stability', 'blocked', 'Source or staged artifact changed during native execution; observations are not accepted as revision-bound evidence.');
    }
  } catch (error) { revisionVerified = false; record('Native execution prerequisite', error.status || 'blocked', error.message); }
  if (staging && safeToRemoveStaging) {
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch { record('Native staging cleanup', 'blocked', 'Staged artifact cleanup failed; archive or remove it from the bot workspace.'); }
  } else if (staging) limitations.push('The staged artifact remains in the bot workspace because native session shutdown is uncertain. Reset the enrolled device/VM before removing it.');
  let status = ['failed', 'execution_error', 'blocked'].find(value => observations.some(item => item.status === value)) || (observations.length ? 'passed' : 'blocked');
  const counts = { tests: observations.length, passed: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const observation of observations) counts[observation.status === 'passed' ? 'passed' : observation.status === 'failed' ? 'failed' : observation.status === 'execution_error' ? 'cancelled' : 'skipped']++;
  if (!revisionVerified) {
    status = 'blocked'; counts.passed = 0; counts.failed = 0; counts.cancelled = 0; counts.skipped = counts.tests;
    for (const image of screenshots) { try { await fs.rm(await ownedPath(output, image.path), { force: true }); } catch { /* Never expose an unverified image in the report. */ } }
    screenshots.splice(0); limitations.push('Deployment/artifact identity was not fully verified; observed results are unbound diagnostics and are withheld from exact-revision passes or defects.');
  }
  const filename = `native-${runId}.json`, result = { checkId, status, counts,
    details: `${counts.tests} native checks: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} blocked, ${counts.cancelled} execution errors.`,
    evidence: [{ type: 'native', path: filename, excerpt: observations.filter(item => item.status !== 'passed').map(item => `${item.name}: ${item.details}`).join('\n').slice(0, 6000) }] };
  const evidence = { schemaVersion: 1, runId, repository: metadata.repository, revision: metadata.revision, prNumber: metadata.prNumber, checkId, revisionVerified, result,
    artifact: identity ? { sha256: identity.artifactSha256, algorithm: identity.algorithm, bytes: identity.bytes, entries: identity.entries } : null,
    environment: 'disposable-native-device', deviceId: suite.deviceId, observations, screenshots, limitations: [...new Set(limitations)], requests: client?.requests || 0, completedAt: new Date().toISOString() };
  await writeJson(output, filename, evidence); return evidence;
}
module.exports = { runNativeAudit, validateNativeSuite, capabilitiesFor, ELEMENT };
