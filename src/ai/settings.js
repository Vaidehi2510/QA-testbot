const AI_ROLES = Object.freeze(['planner', 'code-review', 'security', 'ui-ux', 'triage']);
const DEFAULT_AI_CONFIG = Object.freeze({
  enabled: false,
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

function modelId(value, optional = false) {
  return typeof value === 'string' && (optional && value === ''
    || value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value));
}

function modelForRole(ai, role) { return ai.roleModels?.[role] || ai.model; }

// Catalog capabilities are a union across providers. Requests additionally use
// require_parameters so a provider that ignores tools cannot silently be selected.
function modelEligibility(model, { images = false } = {}) {
  const reasons = [];
  if (!model) return { eligible: false, reasons: ['Model is absent from the current OpenRouter catalog'], tools: false, vision: false };
  const tools = (model.supportedParameters || []).includes('tools');
  const vision = (model.inputModalities || []).includes('image');
  if (!(model.inputModalities || []).includes('text') || !(model.outputModalities || []).includes('text')) reasons.push('Text input and output are required');
  if (!tools) reasons.push('Tool calling is required');
  if (images && !vision) reasons.push('Image input is required for screenshot review');
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
  if (Object.keys(value).some(k => !Object.hasOwn(DEFAULT_AI_CONFIG, k))) throw new Error('Unknown ai setting; keep API keys in OPENROUTER_API_KEY');
  const ai = { ...DEFAULT_AI_CONFIG, ...value };
  for (const key of ['enabled', 'requireReview', 'allowImages']) if (typeof ai[key] !== 'boolean') throw new Error(`ai.${key} must be boolean`);
  if (!modelId(ai.model, true)) throw new Error('ai.model must be an OpenRouter model ID');
  if (!record(ai.roleModels)) throw new Error('ai.roleModels must be an object');
  ai.roleModels = { ...ai.roleModels };
  for (const [role, id] of Object.entries(ai.roleModels)) {
    if (!AI_ROLES.includes(role) || !modelId(id)) throw new Error('ai.roleModels contains an invalid role or model ID');
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
    for (const role of ai.roles) if (!modelForRole(ai, role)) throw new Error(`Select an OpenRouter model for the ${role} role before enabling AI`);
  }
  if (models !== undefined) {
    if (!Array.isArray(models)) throw new Error('models must be an OpenRouter catalog array');
    for (const role of ai.roles) {
      const id = modelForRole(ai, role);
      if (!id) continue;
      const model = models.find(m => m.id === id);
      const eligibility = modelEligibility(model, { images: ai.allowImages && role === 'ui-ux' });
      if (!eligibility.eligible) throw new Error(`OpenRouter model for ${role} is ineligible: ${eligibility.reasons.join('; ')}`);
      if (model.contextLength && model.contextLength <= ai.maxOutputTokens) throw new Error(`OpenRouter model for ${role} has insufficient context for the output limit`);
      if (model.maxCompletionTokens && ai.maxOutputTokens > model.maxCompletionTokens) throw new Error(`ai.maxOutputTokens exceeds the model limit for ${role}`);
    }
  }
  return ai;
}

module.exports = { AI_ROLES, DEFAULT_AI_CONFIG, validateAIConfig, modelForRole, modelEligibility, validateProvider };
