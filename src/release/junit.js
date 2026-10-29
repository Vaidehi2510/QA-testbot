const { XMLParser, XMLValidator } = require('fast-xml-parser');
const invalid = reason => ({ valid: false, reason });
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
function parseJUnit(xml) {
  if (typeof xml !== 'string' || !xml.trim() || Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(xml)) return invalid('JUnit XML is empty, oversized, or contains forbidden declarations');
  try {
    if (XMLValidator.validate(xml) !== true) return invalid('JUnit XML is malformed');
    const tree = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false, ignoreDeclaration: true, maxNestedTags: 24 }).parse(xml);
    if (Object.keys(tree).length !== 1 || (!tree.testsuites && !tree.testsuite)) return invalid('JUnit must have one testsuites or testsuite root');
    const seen = new Set();
    const empty = () => ({ tests: 0, passed: 0, failures: 0, errors: 0, skipped: 0 });
    function total(node, depth = 0) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 12) throw new Error('Invalid JUnit suite nesting');
      const counts = empty();
      for (const child of [...array(node.testsuites), ...array(node.testsuite)]) {
        const found = total(child, depth + 1); for (const key of Object.keys(counts)) counts[key] += found[key];
      }
      for (const testcase of array(node.testcase)) {
        if (!testcase || typeof testcase !== 'object' || typeof testcase['@_name'] !== 'string' || !testcase['@_name'].trim()) throw new Error('JUnit testcase requires a name');
        const id = `${testcase['@_classname'] || ''}\0${testcase['@_name']}`;
        if (seen.has(id) || seen.size >= 20000) throw new Error('Duplicate JUnit testcase or result limit reached');
        seen.add(id);
        const outcome = ['failure', 'error', 'skipped'].filter(key => testcase[key] !== undefined);
        if (outcome.length > 1 || outcome.some(key => Array.isArray(testcase[key]))) throw new Error('Conflicting JUnit testcase outcomes');
        const status = testcase['@_status'];
        if (status !== undefined && !['run', 'passed', 'success', 'completed', 'notrun', 'disabled', 'skipped'].includes(status)) throw new Error('Unknown JUnit testcase status');
        const skipped = ['notrun', 'disabled', 'skipped'].includes(status);
        if (skipped && outcome.length && outcome[0] !== 'skipped') throw new Error('Contradictory skipped testcase');
        counts.tests++;
        counts[skipped || outcome[0] === 'skipped' ? 'skipped' : outcome[0] === 'failure' ? 'failures' : outcome[0] === 'error' ? 'errors' : 'passed']++;
      }
      for (const [field, key] of [['tests', 'tests'], ['failures', 'failures'], ['errors', 'errors'], ['skipped', 'skipped'], ['disabled', 'skipped']]) {
        const value = node[`@_${field}`];
        if (value !== undefined && (!/^\d+$/.test(String(value)) || Number(value) !== counts[key])) throw new Error(`JUnit ${field} summary contradicts testcase outcomes`);
      }
      return counts;
    }
    const counts = total(tree.testsuites || tree.testsuite);
    if (!counts.tests) return invalid('JUnit discovered zero tests');
    return { valid: true, tests: counts.tests, passed: counts.passed, failed: counts.failures + counts.errors, skipped: counts.skipped, cancelled: 0 };
  } catch (error) { return invalid(error.message); }
}
module.exports = { parseJUnit };
