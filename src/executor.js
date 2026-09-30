const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { screenshotType } = require('./images');

const MAX_OUTPUT = 512 * 1024;
const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const MAX_SCREENSHOTS = 4;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_TOTAL_BYTES = 6 * 1024 * 1024;

// This fixed program runs in a separate trusted container. It never receives
// repository code or a user-supplied command, and its sole mount is read-only.
function readCaptureVolume() {
  const fs = require('node:fs');
  const directory = '/qa-evidence';
  const files = [], limitations = [], names = [];
  const handle = fs.opendirSync(directory);
  let totalBytes = 0;
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (names.length >= 64) { limitations.push('Screenshot directory exceeded the 64-entry inspection limit.'); break; }
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  for (const name of names.sort()) {
    let descriptor;
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.(?:png|jpe?g)$/i.test(name)) throw new Error('Unsupported screenshot filename');
      descriptor = fs.openSync(`${directory}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || !stat.size || stat.size > 2 * 1024 * 1024) throw new Error('Unsafe or oversized screenshot file');
      if (files.length >= 4 || totalBytes + stat.size > 6 * 1024 * 1024) throw new Error('Screenshot count or byte budget exhausted');
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const size = fs.readSync(descriptor, bytes, read, bytes.length - read, read);
        if (!size) throw new Error('Incomplete screenshot file');
        read += size;
      }
      files.push({ name, dataBase64: bytes.toString('base64') });
      totalBytes += bytes.length;
    } catch { limitations.push('One screenshot was omitted because its name, file type, or size was unsafe or its capture budget was exhausted.'); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  process.stdout.write(JSON.stringify({ files, limitations }));
}

function dockerControl(args) {
  return spawnSync('docker', args, { env: cleanEnvironment(), timeout: 15000, encoding: 'utf8', maxBuffer: 64 * 1024 });
}

function startScreenshotCapture(image, { control = dockerControl, processRunner = runProcess } = {}) {
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]+$/.test(image)) throw new Error('Invalid screenshot helper image.');
  const token = crypto.randomBytes(10).toString('hex');
  const volume = `qa-screenshots-${token}`;
  const helper = `qa-screenshot-reader-${token}`;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return true;
    cleaned = true;
    control(['rm', '-f', helper]);
    return control(['volume', 'rm', '-f', volume]).status === 0;
  };
  try {
    const created = control(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=8m,nr_inodes=128,uid=1000,gid=1000,mode=0777', volume]);
    if (created.status !== 0 || created.error) throw new Error('Unable to create the bounded screenshot volume.');
    // Keep the tmpfs mounted while the workload stops; otherwise Docker may
    // unmount the last user and discard the tmpfs before evidence is collected.
    const started = control(['run', '--detach', '--rm', '--pull=never', '--name', helper,
      '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=32', '--memory=128m', '--cpus=0.25', '--user=1000:1000',
      '--mount', `type=volume,src=${volume},dst=/qa-evidence,readonly,volume-nocopy`, image,
      'node', '-e', 'setInterval(() => {}, 1000);']);
    if (started.status !== 0 || started.error) throw new Error('Unable to start the trusted screenshot reader.');
  } catch (error) { cleanup(); throw error; }
  return {
    mount: ['--mount', `type=volume,src=${volume},dst=/qa-evidence,volume-nocopy`],
    cleanup,
    async collect(outputDir, metadata) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-collected-screenshots-'));
      try {
        const result = await processRunner('docker', ['exec', helper, 'node', '-e', `(${readCaptureVolume.toString()})();`], { cwd: os.tmpdir(), timeoutMs: 15000, maxOutput: 9 * 1024 * 1024 });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.error || result.overflow) throw new Error('Trusted screenshot reader failed or exceeded its resource limit.');
        let payload;
        try { payload = JSON.parse(result.output); } catch { throw new Error('Trusted screenshot reader returned malformed evidence.'); }
        if (!payload || !Array.isArray(payload.files) || payload.files.length > MAX_SCREENSHOTS
          || !Array.isArray(payload.limitations) || payload.limitations.length > 65
          || payload.limitations.some(text => typeof text !== 'string' || text.length > 300)) throw new Error('Trusted screenshot reader returned invalid evidence.');
        let totalBytes = 0;
        for (const file of payload.files) {
          if (!file || typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.(?:png|jpe?g)$/i.test(file.name)
            || typeof file.dataBase64 !== 'string' || file.dataBase64.length > 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3)
            || !/^[A-Za-z0-9+/]+=*$/.test(file.dataBase64)) throw new Error('Trusted screenshot reader returned unsafe file data.');
          const bytes = Buffer.from(file.dataBase64, 'base64');
          totalBytes += bytes.length;
          if (bytes.length > MAX_SCREENSHOT_BYTES || totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) throw new Error('Trusted screenshot reader exceeded the byte budget.');
          fs.writeFileSync(path.join(temporary, file.name), bytes, { flag: 'wx', mode: 0o600 });
        }
        const collected = collectScreenshots(temporary, outputDir, metadata);
        collected.limitations.unshift(...payload.limitations);
        return collected;
      } catch (error) { return { screenshots: [], totalBytes: 0, limitations: [error.message] }; }
      finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    },
  };
}

// Called only after the isolated process stops. This mount is separate from all
// trusted state. Read through O_NOFOLLOW and verify fstat before bounded reads.
function collectScreenshots(directory, outputDir, { revision, checkId, remainingCount = MAX_SCREENSHOTS, remainingBytes = MAX_SCREENSHOT_TOTAL_BYTES } = {}) {
  const screenshots = [], limitations = [];
  let totalBytes = 0;
  const limitCount = Math.min(MAX_SCREENSHOTS, Math.max(0, Number.isInteger(remainingCount) ? remainingCount : 0));
  const limitBytes = Math.min(MAX_SCREENSHOT_TOTAL_BYTES, Math.max(0, Number.isInteger(remainingBytes) ? remainingBytes : 0));
  if (typeof revision !== 'string' || typeof checkId !== 'string' || !revision || !checkId) throw new Error('Screenshot evidence requires revision and check ID');
  let directoryStat;
  try { directoryStat = fs.lstatSync(directory); }
  catch { return { screenshots, limitations: ['Screenshot capture directory is unavailable.'], totalBytes }; }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return { screenshots, limitations: ['Screenshot capture directory is not a regular directory.'], totalBytes };
  const entries = [];
  let handle;
  try { handle = fs.opendirSync(directory); }
  catch { return { screenshots, limitations: ['Screenshot capture directory cannot be inspected.'], totalBytes }; }
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (entries.length >= 64) { limitations.push('Screenshot directory exceeded the 64-entry inspection limit.'); break; }
      entries.push(entry.name);
    }
  } finally { handle.closeSync(); }
  for (const name of entries.sort()) {
    let descriptor;
    const displayName = name.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 120);
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.(?:png|jpe?g)$/i.test(name)) throw new Error('only named PNG/JPEG files are accepted');
      const filename = path.join(directory, name);
      const before = fs.lstatSync(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('links and nonregular files are rejected');
      if (before.size > MAX_SCREENSHOT_BYTES || before.size === 0) throw new Error('file is empty or exceeds the 2 MiB limit');
      if (screenshots.length >= limitCount || totalBytes + before.size > limitBytes) throw new Error('run screenshot count or byte budget exhausted');
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw new Error('file changed during evidence collection');
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const size = fs.readSync(descriptor, bytes, read, bytes.length - read, read);
        if (!size) throw new Error('file ended during evidence collection');
        read += size;
      }
      const after = fs.fstatSync(descriptor);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('file changed during evidence collection');
      const type = screenshotType(bytes);
      if (!type || (type.mimeType === 'image/png') !== /\.png$/i.test(name)) throw new Error('image signature, structure, dimensions, or extension is invalid');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const relativePath = `screenshots/${sha256}.${type.extension}`;
      fs.mkdirSync(path.join(outputDir, 'screenshots'), { recursive: true });
      try { fs.writeFileSync(path.join(outputDir, relativePath), bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST' || !fs.readFileSync(path.join(outputDir, relativePath)).equals(bytes)) throw error;
      }
      screenshots.push({ name: displayName, path: relativePath, mimeType: type.mimeType, sha256, revision, checkId });
      totalBytes += bytes.length;
    } catch (error) {
      limitations.push(`Screenshot ${displayName}: ${['EACCES', 'EPERM', 'ENOENT', 'ELOOP'].includes(error.code) ? 'file unavailable or unsafe' : error.message}.`);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  return { screenshots, limitations, totalBytes };
}

function cleanEnvironment() {
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', CI: 'true', NODE_ENV: 'test', LANG: 'C.UTF-8' };
}

// The controller interprets a report only after the process has ended. A zero
// exit code alone is never sufficient: an actual TAP plan and results are needed.
function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const results = lines.filter((line) => /^(?:not )?ok(?:\s|$)/.test(line));
  const plans = lines.map((line) => line.match(/^1\.\.(\d+)(?:\s|$)/)).filter(Boolean);
  if (/^Bail out!/mi.test(text)) return { valid: false, reason: 'TAP runner bailed out.' };
  if (plans.length !== 1 || Number(plans[0][1]) !== results.length) return { valid: false, reason: 'Missing, duplicate, or incomplete TAP plan.' };
  const summary = (name) => {
    const value = text.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
    return value ? Number(value[1]) : null;
  };
  const tests = summary('tests') ?? results.length;
  const failed = summary('fail') ?? results.filter((line) => /^not ok/.test(line) && !/#\s*(?:SKIP|TODO)\b/i.test(line)).length;
  const skipped = (summary('skipped') ?? results.filter((line) => /#\s*SKIP\b/i.test(line)).length)
    + (summary('todo') ?? results.filter((line) => /#\s*TODO\b/i.test(line)).length);
  const cancelled = summary('cancelled') ?? 0;
  const passed = summary('pass') ?? tests - failed - skipped - cancelled;
  if (tests < 1) return { valid: false, reason: 'Runner discovered zero tests.' };
  if (failed < 0 || passed < 0 || tests !== passed + failed + skipped + cancelled) return { valid: false, reason: 'Inconsistent TAP test counts.' };
  if (results.filter((line) => /#\s*(?:SKIP|TODO)\b/i.test(line)).length > skipped) return { valid: false, reason: 'TAP skipped tests contradict its summary.' };
  if (results.some((line) => /^not ok/.test(line) && !/#\s*(?:SKIP|TODO)\b/i.test(line)) && failed === 0 && cancelled === 0) return { valid: false, reason: 'TAP failure contradicts its summary.' };
  return { valid: true, tests, passed, failed, skipped, cancelled };
}

function safeRelativeFile(filename) {
  return typeof filename === 'string' && filename.length > 0 && !filename.startsWith('-') && !path.isAbsolute(filename)
    && !filename.includes('\\') && !filename.split('/').includes('..') && !filename.includes('\0');
}

function runnerCommand(runner, cwd) {
  if (runner.type === 'node-test') {
    if (!Array.isArray(runner.files) || !runner.files.length || !runner.files.every(safeRelativeFile)) throw new Error('node-test runner requires explicit relative test files or globs.');
    const files = [...new Set(runner.files.flatMap((pattern) => fs.globSync(pattern, { cwd })))].sort();
    if (!files.length) throw new Error('Configured test files/globs matched zero files.');
    for (const file of files) {
      // Recheck expanded names: a trusted glob can match a PR-owned CLI option.
      if (!safeRelativeFile(file)) throw new Error(`Unsafe test path argument from glob: ${file}`);
      const resolved = fs.realpathSync(path.resolve(cwd, file));
      const relative = path.relative(fs.realpathSync(cwd), resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Test file escapes checkout: ${file}`);
      if (!fs.statSync(resolved).isFile()) throw new Error(`Test file is not a regular file: ${file}`);
    }
    return { command: 'node', args: ['--test', '--test-reporter=tap', '--', ...files] };
  }
  if (runner.type === 'npm-script') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(runner.script || '')) throw new Error('Invalid trusted npm script name.');
    if (runner.format !== 'tap') throw new Error('npm-script currently requires format: tap.');
    const packageFile = path.join(cwd, 'package.json');
    const real = fs.realpathSync(packageFile);
    if (path.relative(fs.realpathSync(cwd), real).startsWith('..')) throw new Error('package.json escapes checkout.');
    const pkg = JSON.parse(fs.readFileSync(real, 'utf8'));
    if (!pkg.scripts || typeof pkg.scripts[runner.script] !== 'string') throw new Error(`Missing npm script: ${runner.script}`);
    // Lifecycle scripts are not prerequisites for a QA check. The chosen script
    // still executes untrusted application code inside the isolated container.
    return { command: 'npm', args: ['--ignore-scripts', '--silent', 'run', runner.script] };
  }
  throw new Error(`Unsupported runner type: ${runner.type}`);
}

function runProcess(command, args, { cwd, timeoutMs, maxOutput = MAX_OUTPUT, onStop }) {
  return new Promise((resolve) => {
    let output = '', timedOut = false, overflow = false, settled = false, termination;
    const child = spawn(command, args, { cwd, env: cleanEnvironment(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      if (onStop) onStop();
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { /* already finished */ }
    };
    const collect = (chunk) => {
      if (output.length + chunk.length > maxOutput) { overflow = true; output += chunk.toString().slice(0, Math.max(0, maxOutput - output.length)); stop(); }
      else output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGTERM', termination);
      process.removeListener('SIGINT', termination);
      resolve({ output, timedOut, overflow, ...extra });
    };
    termination = () => { stop(); finish({ cancelled: true, exitCode: null }); };
    process.once('SIGTERM', termination);
    process.once('SIGINT', termination);
    child.once('error', (error) => finish({ error: error.message, exitCode: null }));
    child.once('close', (exitCode, signal) => finish({ exitCode, signal }));
  });
}

function readRevision(cwd, metadata, sourceAttestation) {
  if (metadata.fixture === true) return metadata.revision;
  // Archives carry an attestation outside the untrusted source tree. It was
  // produced by the privileged prepare job after selecting the exact git SHA.
  if (sourceAttestation) {
    const source = JSON.parse(fs.readFileSync(sourceAttestation, 'utf8'));
    if (source.repository !== metadata.repository || source.revision !== metadata.revision) throw new Error('Source attestation does not match requested repository/revision.');
    return source.revision;
  }
  const revision = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: cleanEnvironment() });
  if (revision.status !== 0) throw new Error('Unable to verify tested git revision.');
  const dirty = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'], { encoding: 'utf8', env: cleanEnvironment() });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('Checkout must be clean to bind results to an exact revision.');
  if (revision.stdout.trim() !== metadata.revision) throw new Error('Checkout revision differs from requested revision.');
  return revision.stdout.trim();
}

function snapshotCheckout(cwd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-source-snapshot-'));
  const source = path.join(root, 'source');
  try {
    // A local git checkout can carry credentials in .git/config. Never expose
    // Git metadata to PR code. Remote GitHub archives already exclude it.
    fs.cpSync(cwd, source, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (filename) => path.basename(filename) !== '.git' });
    fs.chmodSync(source, 0o755);
    return { root, source };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function executePlan({ plan, config, cwd, metadata, outputDir, isolation, allowLocal = false, sourceAttestation }) {
  if (!plan || !Array.isArray(plan.checks) || !metadata || !metadata.repository || !metadata.revision || !metadata.runId || !Number.isInteger(metadata.prNumber) || !Number.isInteger(metadata.attempt)) throw new Error('Execution requires a plan and complete run metadata.');
  if (new Set(plan.checks.map((check) => check.id)).size !== plan.checks.length || plan.checks.some((check) => typeof check.id !== 'string' || !check.id)) throw new Error('Check IDs must be unique nonempty strings.');
  if (!Array.isArray(config.runners) || new Set(config.runners.map((runner) => runner.id)).size !== config.runners.length) throw new Error('Configured runners must have unique IDs.');
  const mode = isolation || config.execution?.isolation || 'container';
  if (!['container', 'process'].includes(mode)) throw new Error('Unsupported isolation mode.');
  if (mode === 'process' && !(allowLocal && metadata.fixture === true)) throw new Error('Local execution is permitted only for explicitly trusted fixtures.');
  const revision = readRevision(cwd, metadata, sourceAttestation);
  let snapshot;
  try {
    if (mode === 'container' && !sourceAttestation) snapshot = snapshotCheckout(cwd);
    return await executeVerifiedPlan({ plan, config, cwd: snapshot?.source || cwd, metadata, outputDir, mode, revision });
  } finally {
    if (snapshot) fs.rmSync(snapshot.root, { recursive: true, force: true });
  }
}

async function executeVerifiedPlan({ plan, config, cwd, metadata, outputDir, mode, revision }) {
  fs.mkdirSync(path.join(outputDir, 'logs'), { recursive: true });
  const image = config.execution?.image || DEFAULT_IMAGE;
  const captureScreenshots = config.execution?.captureScreenshots === true;
  if (config.execution?.captureScreenshots !== undefined && typeof config.execution.captureScreenshots !== 'boolean') throw new Error('execution.captureScreenshots must be boolean.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]+$/.test(image)) throw new Error('Invalid container image.');
  const envelope = {
    schemaVersion: 1, repository: metadata.repository, prNumber: metadata.prNumber, revision,
    environment: metadata.environment || (mode === 'container' ? image : `fixture-node-${process.versions.node}`),
    runId: metadata.runId, attempt: metadata.attempt,
    ...(metadata.actionsRunId ? { actionsRunId: String(metadata.actionsRunId), actionsAttempt: Number(metadata.actionsAttempt || 1) } : {}),
    startedAt: new Date().toISOString(), execution: { isolation: mode, image: mode === 'container' ? image : null, fixture: metadata.fixture === true }, results: [],
    ...(captureScreenshots ? { screenshots: [], screenshotLimitations: [] } : {}),
  };
  let screenshotBytes = 0;
  if (captureScreenshots && mode !== 'container') envelope.screenshotLimitations.push('Automatic screenshot capture requires container isolation.');
  for (const check of plan.checks) {
    // Human decisions and unsupported coverage are evaluated from the plan by
    // the controller; only actually attempted automated checks belong here.
    if (check.method !== 'automated') continue;
    const started = Date.now();
    const result = { checkId: check.id, status: 'blocked', evidence: [], details: '', durationMs: 0 };
    let screenshotCapture;
    try {
      const runner = config.runners.find((item) => item.id === check.runner);
      if (!runner) throw new Error(`Unknown trusted runner: ${check.runner}`);
      const command = runnerCommand(runner, cwd);
      const timeoutMs = Math.min(10 * 60 * 1000, Math.max(20, Number(runner.timeoutMs) || 60000));
      let run;
      if (mode === 'process') {
        run = await runProcess(command.command, command.args, { cwd, timeoutMs });
      } else {
        const name = `qa-${crypto.randomBytes(10).toString('hex')}`;
        if (captureScreenshots) screenshotCapture = startScreenshotCapture(image);
        const args = ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1', '--user=1000:1000', '--tmpfs=/tmp:rw,nosuid,nodev,size=128m', '--mount', `type=bind,src=${path.resolve(cwd)},dst=/workspace,readonly`, ...(screenshotCapture?.mount || []), '--workdir=/workspace', '--env=CI=true', '--env=NODE_ENV=test', '--env=HOME=/tmp', '--env=npm_config_cache=/tmp/npm-cache', '--env=NODE_PATH=/opt/qa/node_modules', '--env=PATH=/opt/qa/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', image, command.command, ...command.args];
        const cleanup = () => spawnSync('docker', ['rm', '-f', name], { env: cleanEnvironment(), timeout: 5000, stdio: 'ignore' });
        run = await runProcess('docker', args, { cwd, timeoutMs, onStop: cleanup });
        cleanup();
        if (screenshotCapture) {
          const collected = await screenshotCapture.collect(outputDir, { revision, checkId: check.id, remainingCount: MAX_SCREENSHOTS - envelope.screenshots.length, remainingBytes: MAX_SCREENSHOT_TOTAL_BYTES - screenshotBytes });
          envelope.screenshots.push(...collected.screenshots);
          envelope.screenshotLimitations.push(...collected.limitations);
          screenshotBytes += collected.totalBytes;
          if (!collected.screenshots.length && !collected.limitations.length) envelope.screenshotLimitations.push(`No screenshots were produced by check ${check.id}.`);
        }
      }
      const logFile = `logs/${crypto.createHash('sha256').update(check.id).digest('hex').slice(0, 24)}.log`;
      fs.writeFileSync(path.join(outputDir, logFile), run.output);
      result.evidence.push({ type: 'log', path: logFile, excerpt: run.output.slice(-6000) });
      const tap = parseTap(run.output);
      if (run.timedOut || run.overflow || run.cancelled || run.error) {
        result.status = 'execution_error';
        result.details = run.timedOut ? `Runner exceeded ${timeoutMs} ms timeout; process tree terminated.` : run.overflow ? 'Runner exceeded the output limit.' : run.cancelled ? 'Execution canceled.' : run.error;
      } else if (!tap.valid) {
        result.status = 'execution_error';
        result.details = `${tap.reason} Process exit code: ${run.exitCode}.`;
      } else {
        result.counts = { tests: tap.tests, passed: tap.passed, failed: tap.failed, skipped: tap.skipped, cancelled: tap.cancelled };
        if (tap.cancelled > 0 || run.signal) { result.status = 'execution_error'; result.details = 'Runner canceled one or more tests.'; }
        else if (tap.failed > 0) { result.status = 'failed'; result.details = `${tap.failed} test(s) failed (exit ${run.exitCode}).`; }
        else if (run.exitCode !== 0) { result.status = 'execution_error'; result.details = `Runner exited ${run.exitCode} despite reporting no assertion failures.`; }
        else if (tap.skipped > 0) { result.status = 'skipped'; result.details = `${tap.skipped} test(s) skipped or pending; required coverage remains incomplete.`; }
        else { result.status = 'passed'; result.details = `${tap.passed} test(s) passed.`; }
      }
    } catch (error) {
      result.status = 'execution_error';
      result.details = error.message;
    } finally {
      if (screenshotCapture && !screenshotCapture.cleanup()) envelope.screenshotLimitations.push('Screenshot volume cleanup failed; discard this ephemeral runner after execution.');
    }
    result.durationMs = Date.now() - started;
    envelope.results.push(result);
  }
  envelope.completedAt = new Date().toISOString();
  const temporary = path.join(outputDir, 'results.json.tmp');
  fs.writeFileSync(temporary, JSON.stringify(envelope, null, 2) + '\n');
  fs.renameSync(temporary, path.join(outputDir, 'results.json'));
  return envelope;
}

module.exports = { executePlan, parseTap, runnerCommand, runProcess, cleanEnvironment, readRevision, snapshotCheckout, collectScreenshots, screenshotType, startScreenshotCapture, DEFAULT_IMAGE };
