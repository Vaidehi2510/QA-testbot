const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const MAX_OUTPUT = 512 * 1024;
const DEFAULT_IMAGE = 'node:22-bookworm-slim';

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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]+$/.test(image)) throw new Error('Invalid container image.');
  const envelope = {
    schemaVersion: 1, repository: metadata.repository, prNumber: metadata.prNumber, revision,
    environment: metadata.environment || (mode === 'container' ? image : `fixture-node-${process.versions.node}`),
    runId: metadata.runId, attempt: metadata.attempt,
    ...(metadata.actionsRunId ? { actionsRunId: String(metadata.actionsRunId), actionsAttempt: Number(metadata.actionsAttempt || 1) } : {}),
    startedAt: new Date().toISOString(), execution: { isolation: mode, image: mode === 'container' ? image : null, fixture: metadata.fixture === true }, results: [],
  };
  for (const check of plan.checks) {
    // Human decisions and unsupported coverage are evaluated from the plan by
    // the controller; only actually attempted automated checks belong here.
    if (check.method !== 'automated') continue;
    const started = Date.now();
    const result = { checkId: check.id, status: 'blocked', evidence: [], details: '', durationMs: 0 };
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
        const args = ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1', '--user=1000:1000', '--tmpfs=/tmp:rw,nosuid,nodev,size=128m', '--mount', `type=bind,src=${path.resolve(cwd)},dst=/workspace,readonly`, '--workdir=/workspace', '--env=CI=true', '--env=NODE_ENV=test', '--env=HOME=/tmp', '--env=npm_config_cache=/tmp/npm-cache', '--env=NODE_PATH=/opt/qa/node_modules', '--env=PATH=/opt/qa/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', image, command.command, ...command.args];
        const cleanup = () => spawnSync('docker', ['rm', '-f', name], { env: cleanEnvironment(), timeout: 5000, stdio: 'ignore' });
        run = await runProcess('docker', args, { cwd, timeoutMs, onStop: cleanup });
        cleanup();
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

module.exports = { executePlan, parseTap, runnerCommand, runProcess, cleanEnvironment, readRevision, snapshotCheckout, DEFAULT_IMAGE };
