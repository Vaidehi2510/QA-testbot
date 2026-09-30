'use strict';
const $ = id => document.getElementById(id);
const ROLES = [
  { id: 'planner', name: 'Test planner', icon: '⌘', description: 'Maps changed behavior to test cases, edge conditions, and coverage gaps.' },
  { id: 'code-review', name: 'Code reviewer', icon: '⌕', description: 'Reads surrounding code, traces regressions, and proposes targeted fixes.' },
  { id: 'security', name: 'Security reviewer', icon: '◇', description: 'Checks trust boundaries, sensitive data, and risky paths through your code.' },
  { id: 'ui-ux', name: 'UI / UX reviewer', icon: '▧', description: 'Reviews interface code, accessibility, and supplied screenshot evidence.' },
  { id: 'triage', name: 'Bug triage', icon: '↗', description: 'Investigates failed checks and turns evidence into actionable next steps.' },
];
let config, savedConfig, revision, csrfToken, models = [], modelLimit = 24, saving = false, toastTimer;
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
};
const errorNotice = message => { $('notice').textContent = message; $('notice').hidden = !message; };
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}
const hasTools = model => model.supportedParameters?.includes('tools');
const hasVision = model => model.inputModalities?.includes('image');
function eligible(model, target = 'default') {
  const needsImages = config?.allowImages && (target === 'ui-ux' || target === 'default' && config.roles.includes('ui-ux') && !config.roleModels['ui-ux']);
  return hasTools(model) && model.inputModalities?.includes('text') && model.outputModalities?.includes('text')
    && !['openrouter/auto', 'openrouter/free'].includes(model.id) && (!needsImages || hasVision(model));
}
const modelName = id => models.find(model => model.id === id)?.name || id || 'Choose a model';
const isDirty = () => config && JSON.stringify(config) !== JSON.stringify(savedConfig);
function markChanged() {
  const dirty = isDirty(); $('save-settings').disabled = !dirty || saving;
  $('save-state').textContent = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Configuration saved';
}
function navigate(tab) {
  if (!['team', 'models', 'runs'].includes(tab)) tab = 'team';
  for (const name of ['team', 'models', 'runs']) $(name + '-view').hidden = name !== tab;
  document.querySelectorAll('[data-tab]').forEach(link => {
    link.classList.toggle('active', link.dataset.tab === tab);
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  $('breadcrumb-current').textContent = { team: 'Your QA team', models: 'Model library', runs: 'Review activity' }[tab];
  if (tab === 'runs') void loadRuns();
}
function chooseTarget(role) {
  $('assign-target').value = role; $('filter-vision').checked = Boolean(config.allowImages && role === 'ui-ux');
  modelLimit = 24; renderModels(); location.hash = 'models'; $('model-search').focus({ preventScroll: true });
}
function renderRoles() {
  if (!config) return;
  $('role-grid').replaceChildren(...ROLES.map(role => {
    const active = config.roles.includes(role.id), card = node('article', null, 'role-card' + (active ? '' : ' disabled'));
    const header = node('div', null, 'role-card-header'), icon = node('span', role.icon, 'role-icon');
    icon.setAttribute('aria-hidden', 'true');
    const status = node('label', null, 'role-status'), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = active; checkbox.setAttribute('aria-label', 'Enable ' + role.name);
    checkbox.addEventListener('change', () => {
      if (!checkbox.checked && config.roles.length === 1) { checkbox.checked = true; toast('Keep at least one review role enabled.'); return; }
      config.roles = checkbox.checked ? ROLES.map(item => item.id).filter(id => id === role.id || config.roles.includes(id)) : config.roles.filter(id => id !== role.id);
      renderRoles(); markChanged();
    });
    status.append(checkbox, node('span', active ? 'Enabled' : 'Paused')); header.append(icon, status);
    const assignment = node('div', null, 'role-model'), override = config.roleModels[role.id];
    assignment.append(node('small', override ? 'SPECIALIST MODEL' : 'DEFAULT MODEL'));
    const button = node('button', null, 'model-selection');
    button.append(node('span', modelName(override || config.model)), node('span', '↗'));
    button.setAttribute('aria-label', 'Choose model for ' + role.name); button.addEventListener('click', () => chooseTarget(role.id));
    assignment.append(button);
    if (override) {
      const reset = node('button', 'Use default model instead', 'role-reset');
      reset.addEventListener('click', () => { delete config.roleModels[role.id]; renderRoles(); renderModels(); markChanged(); }); assignment.append(reset);
    }
    card.append(header, node('h3', role.name), node('p', role.description), assignment); return card;
  }));
}
function renderModelOptions() {
  if (!config) return;
  const options = [node('option', 'Select a model')]; options[0].value = '';
  for (const model of [...models].filter(item => eligible(item)).sort((a, b) => a.name.localeCompare(b.name))) {
    const option = node('option', model.name); option.value = model.id; options.push(option);
  }
  if (config.model && !options.some(option => option.value === config.model)) {
    const current = node('option', config.model + ' (check catalog capabilities)'); current.value = config.model; options.push(current);
  }
  $('default-model').replaceChildren(...options); $('default-model').value = config.model;
}
function renderSettings() {
  renderModelOptions(); renderRoles();
  $('ai-enabled').checked = config.enabled; $('allow-images').checked = config.allowImages; $('require-review').checked = config.requireReview;
  $('max-cost').value = config.maxCostUsd; $('max-calls').value = config.maxCallsPerRun; $('max-rounds').value = config.maxToolRounds; markChanged();
}
async function loadSettings() {
  const settings = await api('/api/settings'); config = settings.ai; savedConfig = structuredClone(config); revision = settings.revision;
  $('key-label').textContent = settings.credentialConfigured ? 'API credential configured' : 'API credential needed';
  $('key-dot').classList.toggle('ready', settings.credentialConfigured);
  $('credential-help').textContent = settings.credentialConfigured ? 'Your OpenRouter credential is configured on the server. Select models below, then save your team configuration.'
    : 'Set OPENROUTER_API_KEY in your terminal before starting the dashboard. Credentials stay on the server.';
  renderSettings(); renderModels();
}
const price = value => typeof value === 'number' && Number.isFinite(value)
  ? (value === 0 ? 'Free' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value * 1000000)) : 'Unknown';
const context = value => value >= 1000000 ? (value / 1000000).toFixed(1) + 'm' : value >= 1000 ? Math.round(value / 1000) + 'k' : String(value || 'Unknown');
function renderModels() {
  const query = $('model-search').value.trim().toLowerCase(), target = $('assign-target').value;
  const filtered = models.filter(model => (!query || (model.id + ' ' + model.name + ' ' + model.description).toLowerCase().includes(query))
    && (!$('filter-tools').checked || hasTools(model)) && (!$('filter-vision').checked || hasVision(model))
    && (!$('filter-free').checked || model.pricing?.prompt === 0 && model.pricing?.completion === 0)
    && (model.contextLength || 0) >= Number($('filter-context').value));
  filtered.sort((a, b) => $('model-sort').value === 'price' ? (a.pricing?.prompt ?? Infinity) - (b.pricing?.prompt ?? Infinity) || a.name.localeCompare(b.name)
    : $('model-sort').value === 'context' ? b.contextLength - a.contextLength || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  $('model-results-count').textContent = filtered.length + ' models match'; $('catalog-total').textContent = models.length.toLocaleString(); $('nav-model-count').textContent = models.length;
  const selected = target === 'default' ? config?.model : config?.roleModels[target];
  const cards = filtered.slice(0, modelLimit).map(model => {
    const card = node('article', null, 'model-card' + (selected === model.id ? ' selected' : ''));
    const top = node('div', null, 'model-topline'), capabilities = node('div', null, 'capabilities');
    top.append(node('span', model.id.split('/')[0], 'provider-label'));
    if (hasTools(model)) capabilities.append(node('span', 'Tools', 'capability'));
    if (hasVision(model)) capabilities.append(node('span', 'Vision', 'capability vision')); top.append(capabilities);
    const metrics = node('dl', null, 'model-metrics');
    for (const [label, value] of [['Input / 1M', price(model.pricing?.prompt)], ['Output / 1M', price(model.pricing?.completion)], ['Context', context(model.contextLength)]]) {
      const item = node('div'); item.append(node('dt', label), node('dd', value)); metrics.append(item);
    }
    const button = node('button', selected === model.id ? 'Selected ✓' : 'Use for ' + (target === 'default' ? 'default model' : ROLES.find(role => role.id === target).name.toLowerCase()) + ' ↗', 'button ' + (selected === model.id ? 'primary' : 'secondary'));
    button.disabled = !config || !eligible(model, target);
    button.addEventListener('click', () => {
      if (target === 'default') config.model = model.id; else config.roleModels[target] = model.id;
      renderSettings(); renderModels(); toast(model.name + ' selected. Save your configuration to apply.');
    });
    card.append(top, node('h3', model.name), node('span', model.id, 'model-id'), node('p', model.description || 'No description provided by the model publisher.', 'model-description'), metrics, button);
    if (!eligible(model, target)) card.append(node('p', 'Requires tool calling, text input/output, and vision when screenshot review is enabled.', 'model-warning'));
    else if (model.pricing?.prompt == null || model.pricing?.completion == null) card.append(node('p', 'Unknown token prices: execution is blocked until pricing can be checked.', 'model-warning'));
    return card;
  });
  $('model-grid').replaceChildren(...(cards.length ? cards : [node('p', models.length ? 'No models match these filters. Try a broader search.' : 'The model catalog is not loaded. Reload this page to retry.', 'empty-state')]));
  $('show-more-models').hidden = filtered.length <= modelLimit;
}
function renderFinding(finding) {
  const severity = ['critical', 'high', 'medium', 'low'].includes(finding.severity) ? finding.severity : 'info';
  const card = node('div', null, 'finding ' + severity); card.append(node('strong', severity.toUpperCase() + ' · ' + (finding.title || 'Review finding')));
  if (finding.description) card.append(node('p', finding.description));
  for (const evidence of Array.isArray(finding.evidence) ? finding.evidence : []) card.append(node('p', 'Evidence: ' + (evidence.quote || evidence.description || JSON.stringify(evidence))));
  if (finding.file) card.append(node('div', finding.file + (finding.line ? ':' + finding.line : ''), 'finding-location'));
  if (finding.suggestedFix) card.append(node('p', 'Suggested fix: ' + finding.suggestedFix));
  card.append(node('p', 'Model finding · ' + (finding.status || 'unverified'))); return card;
}
function renderRun(run) {
  const card = node('details', null, 'run-card'), summary = node('summary', null, 'run-summary'), title = node('div', null, 'run-summary-main');
  title.append(node('strong', run.pr?.title || run.repository || 'Local code review'));
  const date = new Date(run.createdAt);
  title.append(node('small', [run.repository, run.revision?.slice(0, 10), Number.isNaN(date.getTime()) ? '' : date.toLocaleString()].filter(Boolean).join(' · ')));
  const status = ['passed', 'failed', 'execution_error', 'blocked', 'pending'].includes(run.outcome?.status) ? run.outcome.status : 'untested';
  summary.append(title, node('span', status.replaceAll('_', ' '), 'run-status ' + status));
  const detail = node('div', null, 'run-detail'); detail.append(node('h3', 'Recorded test evidence'));
  if (!run.results?.length) detail.append(node('p', 'No executed test results were supplied for this review. AI investigation alone does not establish a QA pass.'));
  for (const result of run.results || []) {
    const row = node('div', null, 'check-row'); row.append(node('span', result.checkId || result.name || 'Check'), node('span', result.status || 'Unreported')); detail.append(row);
  }
  const snapshots = [run.ai?.planning, run.ai?.completion].filter(snapshot => snapshot && typeof snapshot === 'object');
  for (const snapshot of snapshots) {
    detail.append(node('h3', snapshot.stage === 'planning' ? 'Test planning' : 'AI review'));
    if (snapshot.status) detail.append(node('p', 'Review status: ' + snapshot.status));
    for (const role of snapshot.roles || []) detail.append(node('span', role.role + ' · ' + role.status + (role.model ? ' · ' + role.model : ''), 'role-result'));
    for (const finding of snapshot.findings || []) detail.append(renderFinding(finding));
    if (!snapshot.findings?.length) detail.append(node('p', 'No findings recorded in this review phase. This does not establish complete coverage.'));
    for (const candidate of snapshot.candidates || []) {
      const candidateCard = node('details', null, 'finding');
      candidateCard.append(node('summary', 'Proposed test · ' + (candidate.title || candidate.filename || candidate.id)));
      candidateCard.append(node('p', 'Candidate only · not executed. ' + (candidate.assertion || '')));
      candidateCard.append(node('pre', candidate.source || JSON.stringify(candidate, null, 2))); detail.append(candidateCard);
    }
    for (const question of snapshot.questions || []) detail.append(node('p', 'Open question: ' + (typeof question === 'string' ? question : question.question || JSON.stringify(question))));
    for (const limitation of snapshot.limitations || []) detail.append(node('p', 'Coverage limitation: ' + (typeof limitation === 'string' ? limitation : JSON.stringify(limitation))));
    if (typeof snapshot.cost === 'number') detail.append(node('p', (snapshot.costIsEstimate ? 'Estimated' : 'Recorded') + ' model cost: $' + snapshot.cost.toFixed(6)));
  }
  if (!snapshots.length) detail.append(node('p', 'No AI review snapshot is recorded for this run.'));
  if (run.report?.markdown) { const report = node('details'); report.append(node('summary', 'Saved report'), node('pre', run.report.markdown, 'report-source')); detail.append(report); }
  card.append(summary, detail); return card;
}
async function loadRuns() {
  $('refresh-runs').disabled = true;
  try {
    const result = await api('/api/runs');
    $('run-list').replaceChildren(...(result.runs.length ? result.runs.map(renderRun) : [node('p', 'Your first review starts here. Run npm run review with a repository and committed base/head refs, then refresh to inspect the findings.', 'empty-state')]));
  } catch (error) { $('run-list').replaceChildren(node('p', error.message, 'empty-state')); }
  finally { $('refresh-runs').disabled = false; }
}
async function saveSettings() {
  errorNotice(''); for (const id of ['max-cost', 'max-calls', 'max-rounds']) if (!$(id).reportValidity()) return;
  saving = true; markChanged();
  const submitted = structuredClone(config);
  try {
    const result = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-QA-CSRF': csrfToken, 'If-Match': revision }, body: JSON.stringify({ ai: submitted }) });
    if (JSON.stringify(config) === JSON.stringify(submitted)) config = result.ai;
    savedConfig = structuredClone(result.ai); revision = result.revision;
    renderSettings(); renderModels(); toast('Team configuration saved.');
  } catch (error) { errorNotice(error.message); }
  finally { saving = false; markChanged(); }
}
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
window.addEventListener('beforeunload', event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.go; }));
$('setup-toggle').addEventListener('click', () => {
  const expanded = $('setup-instructions').hidden; $('setup-instructions').hidden = !expanded; $('setup-toggle').setAttribute('aria-expanded', String(expanded));
});
for (const [id, field, type] of [['ai-enabled', 'enabled', 'boolean'], ['allow-images', 'allowImages', 'boolean'], ['require-review', 'requireReview', 'boolean'], ['max-cost', 'maxCostUsd', 'number'], ['max-calls', 'maxCallsPerRun', 'number'], ['max-rounds', 'maxToolRounds', 'number'], ['default-model', 'model', 'string']]) {
  $(id).addEventListener('change', () => {
    if (!config) return; config[field] = type === 'boolean' ? $(id).checked : type === 'number' ? Number($(id).value) : $(id).value;
    renderRoles(); renderModelOptions(); renderModels(); markChanged();
  });
}
for (const id of ['model-search', 'filter-tools', 'filter-vision', 'filter-free', 'filter-context', 'model-sort', 'assign-target']) $(id).addEventListener(id === 'model-search' ? 'input' : 'change', () => { modelLimit = 24; renderModels(); });
$('show-more-models').addEventListener('click', () => { modelLimit += 24; renderModels(); });
$('save-settings').addEventListener('click', () => { void saveSettings(); });
$('reload-settings').addEventListener('click', () => { void loadSettings().then(() => { errorNotice(''); toast('Saved configuration reloaded.'); }).catch(error => errorNotice(error.message)); });
$('refresh-runs').addEventListener('click', () => { void loadRuns(); });
async function start() {
  navigate(location.hash.slice(1));
  const tasks = await Promise.allSettled([
    api('/api/bootstrap').then(result => { csrfToken = result.csrfToken; }),
    loadSettings(),
    api('/api/models').then(result => { models = result.models; renderModelOptions(); renderRoles(); renderModels(); }),
  ]);
  const errors = tasks.filter(task => task.status === 'rejected').map(task => task.reason.message); if (errors.length) errorNotice(errors.join(' '));
}
void start();
