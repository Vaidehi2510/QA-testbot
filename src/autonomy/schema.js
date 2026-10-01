const crypto = require('node:crypto');
const { redact } = require('../ai/context');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const text = (value, max = 1000) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
function keys(value, allowed, label) { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label} fields`); }
function localPath(value) { return text(value) && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && new URL(value, 'https://preview.invalid').origin === 'https://preview.invalid'; }
function locator(value) {
  if (value.selector !== undefined && (!text(value.selector, 300) || /^(?:javascript|internal):/i.test(value.selector))) throw new Error('Invalid trusted assertion selector');
  if (value.role !== undefined && (!/^[a-z]+$/.test(value.role) || !text(value.name, 300))) throw new Error('Invalid trusted assertion role/name');
  if (!value.selector && !value.role) throw new Error('A trusted assertion requires an explicit locator');
}
function validateGoals(value) {
  keys(value, ['schemaVersion', 'goals', 'allowSemanticMaintenance'], 'goal configuration');
  const checkSecrets = item => {
    if (typeof item === 'string' && redact(item) !== item) throw new Error('Trusted goals and inputs must use synthetic values, not credentials or tokens');
    if (Array.isArray(item)) item.forEach(checkSecrets);
    else if (record(item)) for (const [key, child] of Object.entries(item)) { checkSecrets(key); checkSecrets(child); }
  };
  checkSecrets(value);
  if (value.schemaVersion !== 1 || !Array.isArray(value.goals) || !value.goals.length || value.goals.length > 8) throw new Error('Supply one to eight explicit trusted QA goals');
  if (value.allowSemanticMaintenance !== undefined && typeof value.allowSemanticMaintenance !== 'boolean') throw new Error('allowSemanticMaintenance must be boolean');
  const seen = new Set();
  const goals = value.goals.map(goal => {
    keys(goal, ['id', 'name', 'start', 'requirement', 'inputs', 'assertions'], 'goal');
    if (!id(goal.id) || seen.has(goal.id) || !text(goal.name, 150) || !localPath(goal.start) || !text(goal.requirement, 2000)) throw new Error('Goals need distinct IDs, a name, local start path, and an explicit requirement');
    seen.add(goal.id);
    const inputs = goal.inputs || {};
    if (!record(inputs) || Object.keys(inputs).length > 20 || Object.entries(inputs).some(([key, value]) => !id(key) || typeof value !== 'string' || value.length > 1000)) throw new Error('Goal inputs must be bounded named synthetic values');
    if (!Array.isArray(goal.assertions) || !goal.assertions.length || goal.assertions.length > 8) throw new Error('Every goal needs explicit trusted assertions; observed UI is not an oracle');
    const assertionIds = new Set();
    for (const assertion of goal.assertions) {
      keys(assertion, ['id', 'action', 'selector', 'role', 'name', 'text', 'path', 'exact'], 'assertion');
      if (!id(assertion.id) || assertionIds.has(assertion.id) || !['expectText', 'expectVisible', 'expectUrl'].includes(assertion.action)) throw new Error('Invalid trusted assertion');
      assertionIds.add(assertion.id);
      if (assertion.exact !== undefined && (assertion.action !== 'expectText' || typeof assertion.exact !== 'boolean')) throw new Error('Only text assertions accept an explicit exact-match policy');
      if (assertion.action === 'expectUrl') {
        if (!localPath(assertion.path) || ['selector', 'role', 'name', 'text'].some(key => assertion[key] !== undefined)) throw new Error('URL assertions need only an explicit same-origin path');
      } else {
        locator(assertion);
        if (assertion.path !== undefined || assertion.action === 'expectText' && !text(assertion.text) || assertion.action === 'expectVisible' && assertion.text !== undefined) throw new Error('Invalid expected assertion text');
      }
    }
    return structuredClone({ ...goal, inputs, assertions: goal.assertions.map(assertion => assertion.action === 'expectText' ? { ...assertion, exact: assertion.exact ?? true } : assertion) });
  });
  return { schemaVersion: 1, goals, allowSemanticMaintenance: value.allowSemanticMaintenance === true };
}

function inventoryTargets(inventory, revision, origin) {
  const targets = new Map();
  const pages = [];
  for (const state of (Array.isArray(inventory) ? inventory : []).slice(0, 24)) {
    if (state?.revisionVerified !== true || state.revision !== revision || !localPath(state.path)) continue;
    let page;
    try { page = new URL(state.page); } catch { continue; }
    if (page.origin !== origin) continue;
    const elements = [];
    for (const element of (Array.isArray(state.elements) ? state.elements : []).slice(0, 80)) {
      if (!record(element)) continue;
      const known = {};
      if (text(element.selector, 300) && !/^(?:javascript|internal):/i.test(element.selector)) known.selector = element.selector;
      if (typeof element.role === 'string' && /^[a-z]+$/.test(element.role) && text(element.name, 300)) { known.role = element.role; known.name = element.name; }
      if (!known.selector && !known.role) continue;
      if (typeof element.tag === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(element.tag)) known.tag = element.tag;
      if (typeof element.type === 'string' && /^[a-z-]{1,30}$/.test(element.type)) known.type = element.type;
      const targetId = hash([state.path, known]).slice(0, 24);
      targets.set(targetId, { ...known, path: state.path });
      elements.push({ targetId, ...known });
    }
    pages.push({ path: state.path, startPath: localPath(state.startPath) ? state.startPath : state.path, title: redact(state.title || '').slice(0, 300), elements, navigationSteps: Array.isArray(state.navigationSteps) ? state.navigationSteps.slice(0, 4) : [],
      visibleText: (Array.isArray(state.visibleText) ? state.visibleText : []).slice(0, 40).map(value => redact(value).slice(0, 300)) });
  }
  for (const page of pages) {
    const steps = [];
    for (const step of page.navigationSteps) {
      if (!record(step) || step.action !== 'click') continue;
      const target = [...targets.entries()].find(([, element]) => element.path === page.startPath &&
        (step.selector ? step.selector === element.selector : step.role === element.role && step.name === element.name));
      if (target) steps.push({ action: 'click', targetId: target[0] });
    }
    if (steps.length !== page.navigationSteps.length) page.navigationUnavailable = true;
    page.navigationSteps = steps;
  }
  return { targets, pages };
}

function compileCandidates(value, goals, targets) {
  keys(value, ['candidates', 'limitations'], 'model proposal');
  if (!Array.isArray(value.candidates) || value.candidates.length > 8 || !Array.isArray(value.limitations) || value.limitations.length > 30 || value.limitations.some(item => typeof item !== 'string' || item.length > 2000)) throw new Error('Invalid model candidate list');
  const seen = new Set();
  return value.candidates.map(candidate => {
    keys(candidate, ['goalId', 'steps'], 'candidate');
    const goal = goals.find(item => item.id === candidate.goalId);
    if (!goal || seen.has(goal.id) || !Array.isArray(candidate.steps) || !candidate.steps.length || candidate.steps.length > 20) throw new Error('Candidate must reference one distinct trusted goal and bounded steps');
    seen.add(goal.id);
    const asserted = new Set();
    const steps = candidate.steps.map(step => {
      keys(step, ['action', 'targetId', 'inputId', 'key', 'assertionId'], 'candidate step');
      if (step.action === 'assert') {
        if (['targetId', 'inputId', 'key'].some(key => step[key] !== undefined)) throw new Error('Assertions cannot supply replacement locators or values');
        const assertion = goal.assertions.find(item => item.id === step.assertionId);
        if (!assertion || asserted.has(assertion.id)) throw new Error('Unknown or duplicate trusted assertion reference');
        asserted.add(assertion.id);
        const { id: _, ...trusted } = assertion;
        return structuredClone(trusted);
      }
      if (asserted.size) throw new Error('Generated interactions must finish before the trusted final-state assertions');
      if (!['click', 'fill', 'press'].includes(step.action) || step.assertionId !== undefined) throw new Error('Generated code and arbitrary browser actions are forbidden');
      const target = targets.get(step.targetId);
      if (!target) throw new Error('Candidate refers to an element outside verified discovery');
      const compiled = { action: step.action };
      if (target.selector) compiled.selector = target.selector;
      else { compiled.role = target.role; compiled.name = target.name; }
      if (target.selector && target.role) compiled.fallback = { role: target.role, name: target.name,
        ...(target.tag ? { tag: target.tag } : {}), ...(target.type ? { type: target.type } : {}) };
      if (step.action === 'fill') {
        if (!Object.hasOwn(goal.inputs, step.inputId) || step.key !== undefined) throw new Error('Generated input must reference an approved synthetic value');
        compiled.value = goal.inputs[step.inputId];
      } else if (step.action === 'press') {
        if (!['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(step.key) || step.inputId !== undefined) throw new Error('Unapproved generated key press');
        compiled.value = step.key;
      } else if (step.inputId !== undefined || step.key !== undefined) throw new Error('Click steps cannot supply input values');
      return compiled;
    });
    if (asserted.size !== goal.assertions.length) throw new Error('A generated journey must retain every trusted business assertion');
    return { goalId: goal.id, goalHash: hash(goal), journey: { name: goal.name, start: goal.start, steps }, proposal: structuredClone(candidate) };
  });
}

function validateRetainedJourney(goal, journey) {
  if (!record(journey) || journey.name !== goal.name || journey.start !== goal.start || !Array.isArray(journey.steps) || !journey.steps.length || journey.steps.length > 20) throw new Error('Retained journey does not match its trusted goal');
  const expected = goal.assertions.map(({ id: _, ...assertion }) => hash(assertion)).sort();
  const actual = []; let asserting = false;
  for (const step of journey.steps) {
    if (step?.action?.startsWith('expect')) {
      const signature = hash(step);
      if (!expected.includes(signature)) throw new Error('Retained journey changed a trusted assertion');
      actual.push(signature); asserting = true;
    } else {
      if (asserting || !['click', 'fill', 'press'].includes(step?.action)) throw new Error('Retained journey changed the allowed action/assertion order');
      if (step.action === 'fill' && !Object.values(goal.inputs).includes(step.value)) throw new Error('Retained journey changed an approved synthetic input');
      if (step.action === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(step.value)) throw new Error('Retained journey changed an approved key press');
    }
  }
  if (hash(actual.sort()) !== hash(expected)) throw new Error('Retained journey omitted or duplicated a trusted assertion');
  return journey;
}

module.exports = { hash, validateGoals, inventoryTargets, compileCandidates, validateRetainedJourney };
