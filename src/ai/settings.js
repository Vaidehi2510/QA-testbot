const AI_ROLES = Object.freeze(['planner', 'code-review', 'security', 'ui-ux', 'triage']);
const DEFAULT_AI_CONFIG = Object.freeze({
  enabled: false,
  backend: 'openrouter',
  local: Object.freeze({ baseUrl: 'http://127.0.0.1:11434/v1', models: Object.freeze([]) }),
  model: '',
  roleModels: Object.freeze({}),
  roles: AI_ROLES,
  maxToolRounds: 3,
  maxCallsPerRun: 20,
  maxInputChars: 100000,
  maxOutputTokens: 3000,
  maxCostUsd: 2,
  requireReview: true,
  includePaths: Object.freeze(['**']),
  excludePaths: Object.freeze([]),
  allowImages: false,
  provider: Object.freeze({ data_collection: 'deny', allow_fallbacks: false, require_parameters: true }),
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function modelId(value, optional = false, backend = 'openrouter') {
  if (typeof value !== 'string') return false;
  if (optional && value === '') return true;
  if (!value || value.length > 200 || value.includes('://') || value.includes('//') || value.split('/').includes('..')) return false;
  return backend === 'local'
    ? /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    : /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function validateLocalEndpoint(value) {
  // Validate the literal spelling before URL canonicalization. Reject DNS names,
  // alternate IP encodings, credentials and path tricks before any network call.
  if (typeof value !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/v1\/?$/.test(value)) throw new Error('ai.local.baseUrl must use literal 127.0.0.1 or [::1] with http(s) and /v1');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid ai.local.baseUrl'); }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error('Invalid ai.local.baseUrl port');
  return url.href.replace(/\/$/, '');
}

function validateLocalConfig(value = DEFAULT_AI_CONFIG.local) {
  if (!record(value) || Object.keys(value).some(key => !['baseUrl', 'models'].includes(key))) throw new Error('ai.local must contain only baseUrl and model profiles; keep credentials in LOCAL_MODEL_API_KEY');
  const baseUrl = validateLocalEndpoint(value.baseUrl ?? DEFAULT_AI_CONFIG.local.baseUrl);
  const profiles = value.models ?? [];
  if (!Array.isArray(profiles) || profiles.length > 100) throw new Error('ai.local.models must be a bounded list of explicit model profiles');
  const seen = new Set();
  const models = profiles.map(profile => {
    if (!record(profile) || Object.keys(profile).some(key => !['id', 'contextLength', 'maxCompletionTokens', 'tools', 'vision'].includes(key))) throw new Error('Invalid local model profile');
    if (!modelId(profile.id, false, 'local') || seen.has(profile.id)) throw new Error('Local model profiles require distinct valid model IDs');
    seen.add(profile.id);
    if (!Number.isSafeInteger(profile.contextLength) || profile.contextLength < 1024 || profile.contextLength > 2000000) throw new Error('Local model contextLength must be the configured server context size between 1024 and 2000000');
    if (typeof profile.tools !== 'boolean' || typeof profile.vision !== 'boolean') throw new Error('Local model profiles must explicitly declare boolean tools and vision capabilities');
    if (profile.maxCompletionTokens !== undefined && (!Number.isSafeInteger(profile.maxCompletionTokens) || profile.maxCompletionTokens < 1 || profile.maxCompletionTokens > profile.contextLength)) throw new Error('Invalid local model maxCompletionTokens');
    return { ...profile };
  });
  return { baseUrl, models };
}

function localProfileModel(profile) {
  return { id: profile.id, backend: 'local', capabilitiesVerified: true, contextLength: profile.contextLength,
    maxCompletionTokens: profile.maxCompletionTokens ?? null, inputModalities: profile.vision ? ['text', 'image'] : ['text'],
    outputModalities: ['text'], supportedParameters: profile.tools ? ['tools'] : [] };
}

function modelForRole(ai, role) { return ai.roleModels?.[role] || ai.model; }

// Catalog capabilities are a union across providers. Requests additionally use
// require_parameters so a provider that ignores tools cannot silently be selected.
function modelEligibility(model, { images = false } = {}) {
  const reasons = [];
  if (!model) return { eligible: false, reasons: ['Model is absent from the current catalog'], tools: false, vision: false };
  const tools = (model.supportedParameters || []).includes('tools');
  const vision = (model.inputModalities || []).includes('image');
  if (!(model.inputModalities || []).includes('text') || !(model.outputModalities || []).includes('text')) reasons.push('Text input and output are required');
  if (!tools) reasons.push('Tool calling is required');
  if (images && !vision) reasons.push('Image input is required for screenshot review');
  if (model.backend === 'local' && (!model.capabilitiesVerified || !Number.isSafeInteger(model.contextLength) || model.contextLength <= 0)) reasons.push('Declare the local model context size and capabilities in a trusted profile before use');
  if (['openrouter/auto', 'openrouter/free'].includes(model.id)) reasons.push('Select a specific model for auditable model selection and pricing');
  return { eligible: reasons.length === 0, reasons, tools, vision };
}

function validateProvider(value) {
  if (!record(value)) throw new Error('ai.provider must be an object');
  const allowed = ['data_collection', 'allow_fallbacks', 'require_parameters', 'only', 'ignore', 'order', 'sort', 'zdr', 'max_price'];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported ai.provider setting');
  const result = { ...DEFAULT_AI_CONFIG.provider, ...value };
  if (!['allow', 'deny'].includes(result.data_collection)) throw new Error('ai.provider.data_collection must be allow or deny');
  if (typeof result.allow_fallbacks !== 'boolean' || result.require_parameters !== true) throw new Error('ai.provider requires boolean allow_fallbacks and require_parameters: true');
  if (result.zdr !== undefined && typeof result.zdr !== 'boolean') throw new Error('ai.provider.zdr must be boolean');
  if (result.sort !== undefined && !['price', 'latency', 'throughput'].includes(result.sort)) throw new Error('Unsupported ai.provider.sort');
  for (const key of ['only', 'ignore', 'order']) {
    if (result[key] === undefined) continue;
    if (!Array.isArray(result[key]) || result[key].length > 50 || result[key].some(v => typeof v !== 'string' || !v || v.length > 150 || /[\x00-\x1f]/.test(v))) throw new Error(`ai.provider.${key} must be a list of provider names`);
    result[key] = [...result[key]];
  }
  if (result.max_price !== undefined) {
    if (!record(result.max_price) || Object.keys(result.max_price).some(k => !['prompt', 'completion', 'request', 'image'].includes(k))) throw new Error('Invalid ai.provider.max_price');
    if (Object.values(result.max_price).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error('ai.provider.max_price must contain nonnegative prices');
    result.max_price = { ...result.max_price };
  }
  return result;
}

function validateAIConfig(value = {}, { models } = {}) {
  if (!record(value)) throw new Error('ai must be an object');
  if (Object.keys(value).some(k => !Object.hasOwn(DEFAULT_AI_CONFIG, k))) throw new Error('Unknown ai setting; keep API keys in OPENROUTER_API_KEY or LOCAL_MODEL_API_KEY');
  const ai = { ...DEFAULT_AI_CONFIG, ...value };
  if (!['openrouter', 'local'].includes(ai.backend)) throw new Error('ai.backend must be openrouter or local');
  ai.local = validateLocalConfig(ai.local);
  const backendName = ai.backend === 'local' ? 'local' : 'OpenRouter';
  for (const key of ['enabled', 'requireReview', 'allowImages']) if (typeof ai[key] !== 'boolean') throw new Error(`ai.${key} must be boolean`);
  if (!modelId(ai.model, true, ai.backend)) throw new Error(`ai.model must be a valid ${backendName} model ID`);
  if (!record(ai.roleModels)) throw new Error('ai.roleModels must be an object');
  ai.roleModels = { ...ai.roleModels };
  for (const [role, id] of Object.entries(ai.roleModels)) {
    if (!AI_ROLES.includes(role) || !modelId(id, false, ai.backend)) throw new Error('ai.roleModels contains an invalid role or model ID');
  }
  if (!Array.isArray(ai.roles) || !ai.roles.length || ai.roles.length > AI_ROLES.length || new Set(ai.roles).size !== ai.roles.length || ai.roles.some(r => !AI_ROLES.includes(r))) throw new Error('ai.roles must contain distinct supported QA roles');
  ai.roles = [...ai.roles];
  const ranges = { maxToolRounds: [0, 8], maxCallsPerRun: [1, 100], maxInputChars: [1000, 500000], maxOutputTokens: [256, 16000] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(ai[key]) || ai[key] < min || ai[key] > max) throw new Error(`ai.${key} must be an integer between ${min} and ${max}`);
  }
  if (typeof ai.maxCostUsd !== 'number' || !Number.isFinite(ai.maxCostUsd) || ai.maxCostUsd < 0 || ai.maxCostUsd > 100) throw new Error('ai.maxCostUsd must be between 0 and 100');
  for (const key of ['includePaths', 'excludePaths']) {
    if (!Array.isArray(ai[key]) || ai[key].length > 100 || (key === 'includePaths' && ai[key].length === 0)) throw new Error(`ai.${key} must be a list of repository-relative path patterns`);
    ai[key] = ai[key].map(pattern => {
      if (typeof pattern !== 'string' || !pattern || pattern.length > 300 || pattern.startsWith('/') || pattern.includes('\\') || /[\x00-\x1f]/.test(pattern) || pattern.split('/').includes('..') || /^[A-Za-z]:/.test(pattern)) throw new Error(`ai.${key} contains an invalid path pattern`);
      return pattern;
    });
  }
  ai.provider = validateProvider(ai.provider);
  if (ai.enabled) {
    for (const role of ai.roles) if (!modelForRole(ai, role)) throw new Error(`Select ${ai.backend === 'local' ? 'a local' : 'an OpenRouter'} model for the ${role} role before enabling AI`);
  }
  // OpenAI-compatible discovery endpoints do not reliably describe capabilities
  // or the context size actually loaded on this machine. Do not invent either.
  if (ai.backend === 'local') validateSelectedModels(ai, ai.local.models.map(localProfileModel), 'local');
  if (models !== undefined) {
    if (!Array.isArray(models)) throw new Error('models must be a model catalog array');
    validateSelectedModels(ai, models, backendName);
  }
  return ai;
}

function validateSelectedModels(ai, models, backendName) {
  for (const role of ai.roles) {
    const id = modelForRole(ai, role);
    if (!id) continue;
    const model = models.find(m => m.id === id);
    const eligibility = modelEligibility(model, { images: ai.allowImages && role === 'ui-ux' });
    if (!eligibility.eligible) throw new Error(`${backendName} model for ${role} is ineligible: ${eligibility.reasons.join('; ')}`);
    if (model.contextLength && model.contextLength <= ai.maxOutputTokens) throw new Error(`${backendName} model for ${role} has insufficient context for the output limit`);
    if (model.maxCompletionTokens && ai.maxOutputTokens > model.maxCompletionTokens) throw new Error(`ai.maxOutputTokens exceeds the model limit for ${role}`);
  }
}

module.exports = { AI_ROLES, DEFAULT_AI_CONFIG, validateAIConfig, modelForRole, modelEligibility, validateProvider, modelId, validateLocalConfig, validateLocalEndpoint, localProfileModel };
