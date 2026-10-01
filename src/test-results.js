// Strict adapters: missing, truncated, skipped or contradictory output never passes.
function invalid(reason) { return { valid: false, reason }; }
function parseGoJson(text) {
  const packages = new Map(), tests = new Map();
  try {
    for (const line of text.split(/\r?\n/).filter(value => value.trim())) {
      const event = JSON.parse(line);
      if (!event || typeof event.Package !== 'string' || typeof event.Action !== 'string') return invalid('Malformed Go test event.');
      const state = packages.get(event.Package) || { started: false, terminal: null };
      if (event.Action === 'start') { if (state.started) return invalid('Duplicate Go package start.'); state.started = true; }
      if (event.Test !== undefined) {
        if (typeof event.Test !== 'string' || !event.Test) return invalid('Invalid Go test identity.');
        const key = `${event.Package}\0${event.Test}`, test = tests.get(key) || { started: false, terminal: null };
        if (event.Action === 'run') { if (test.started) return invalid('Duplicate Go test start.'); test.started = true; }
        if (['pass', 'fail', 'skip'].includes(event.Action)) {
          if (!test.started || test.terminal) return invalid('Go test result without a unique start.');
          test.terminal = event.Action;
        }
        tests.set(key, test);
      } else if (['pass', 'fail', 'skip'].includes(event.Action)) {
        if (!state.started || state.terminal) return invalid('Go package result without a unique start.');
        state.terminal = event.Action;
      }
      packages.set(event.Package, state);
    }
  } catch { return invalid('Go runner did not emit complete JSON events.'); }
  if (!packages.size || [...packages.values()].some(value => !value.started || !value.terminal) || [...tests.values()].some(value => !value.started || !value.terminal)) return invalid('Missing or incomplete Go test/package results.');
  const result = { valid: true, tests: tests.size, passed: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const value of tests.values()) result[value.terminal === 'pass' ? 'passed' : value.terminal === 'fail' ? 'failed' : 'skipped']++;
  for (const [name, pkg] of packages) {
    const children = [...tests.entries()].filter(([key]) => key.startsWith(`${name}\0`)).map(([, value]) => value);
    if (pkg.terminal === 'pass' && children.some(value => value.terminal === 'fail')) return invalid('Go package pass contradicts a failed test.');
    if (pkg.terminal === 'fail' && !children.some(value => value.terminal === 'fail')) { result.tests++; result.cancelled++; }
  }
  return result.tests ? result : invalid('Go runner discovered zero tests.');
}
function parseVitestJson(text) {
  let payload;
  try { payload = JSON.parse(text.trim()); } catch { return invalid('Vitest runner did not emit a complete JSON report.'); }
  if (!payload || !Array.isArray(payload.testResults) || !payload.testResults.length) return invalid('Missing Vitest suite results.');
  const result = { valid: true, tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 };
  const names = new Set();
  for (const suite of payload.testResults) {
    if (typeof suite.name !== 'string' || names.has(suite.name) || !Array.isArray(suite.assertionResults) || !['passed', 'failed', 'pending'].includes(suite.status)) return invalid('Invalid or duplicate Vitest suite.');
    names.add(suite.name);
    let failures = 0;
    for (const assertion of suite.assertionResults) {
      if (!assertion || !['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].includes(assertion.status)) return invalid('Unknown Vitest assertion status.');
      result.tests++;
      if (assertion.status === 'passed') result.passed++;
      else if (assertion.status === 'failed') { result.failed++; failures++; }
      else result.skipped++;
    }
    if (suite.status === 'passed' && failures) return invalid('Vitest suite pass contradicts a failed assertion.');
    if (suite.status === 'failed' && failures === 0) { result.tests++; result.cancelled++; }
  }
  const assertions = result.tests - result.cancelled;
  if (!assertions) return invalid('Vitest runner discovered zero assertions.');
  if (payload.numTotalTests !== assertions || payload.numPassedTests !== result.passed || payload.numFailedTests !== result.failed || (payload.numPendingTests || 0) + (payload.numTodoTests || 0) !== result.skipped) return invalid('Vitest summary contradicts assertion counts.');
  if (payload.success === true && result.failed + result.cancelled > 0 || payload.success === false && result.failed + result.cancelled === 0) return invalid('Vitest success flag contradicts its results.');
  return result;
}
module.exports = { parseGoJson, parseVitestJson };
