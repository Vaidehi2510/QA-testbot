const { validateLocalConfig, modelId, localProfileModel, modelEligibility } = require('./settings');

const BILLING = Object.freeze({ metered: false, computeCostTracked: false });
const CHAT_LIMIT = 2 * 1024 * 1024;
const REQUEST_LIMIT = 12 * 1024 * 1024;

class LocalModelError extends Error {
  constructor(message, { status = null, code = 'LOCAL_MODEL_ERROR' } = {}) {
    super(message);
    this.name = 'LocalModelError'; this.status = status; this.code = code;
  }
}

function normalizeLocalModel(raw, profile) {
  if (!raw || !modelId(raw.id, false, 'local')) return null;
  const capabilities = profile ? localProfileModel(profile) : { id: raw.id, backend: 'local', capabilitiesVerified: false,
    contextLength: null, maxCompletionTokens: null, inputModalities: [], outputModalities: [], supportedParameters: [] };
  return { ...capabilities, name: raw.id,
    description: profile ? 'Local server model. Capabilities and context size are declared in trusted configuration.' : 'Local server model. Configure its actual context size and tool/vision capabilities before use.',
    architecture: { input_modalities: capabilities.inputModalities, output_modalities: capabilities.outputModalities },
    pricing: { prompt: 0, completion: 0, request: 0, image: 0 }, billing: { ...BILLING } };
}

async function readJson(response, maxBytes) {
  if (Number(response.headers?.get('content-length')) > maxBytes) throw new LocalModelError('Local model response exceeds the size limit', { code: 'RESPONSE_TOO_LARGE' });
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new LocalModelError('Local model response exceeds the size limit', { code: 'RESPONSE_TOO_LARGE' });
        }
        chunks.push(Buffer.from(chunk.value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new LocalModelError('Local model response exceeds the size limit', { code: 'RESPONSE_TOO_LARGE' });
  }
  try { return JSON.parse(text); }
  catch { throw new LocalModelError('Local model server returned invalid JSON', { code: 'INVALID_RESPONSE' }); }
}

function validToolCalls(calls) {
  return Array.isArray(calls) && calls.length <= 30 && calls.every(call => call && typeof call.id === 'string'
    && call.id.length > 0 && call.id.length <= 200 && call.type === 'function' && call.function
    && typeof call.function.name === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(call.function.name)
    && typeof call.function.arguments === 'string' && call.function.arguments.length <= 200000);
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 300) throw new Error('Local model messages must be a nonempty, bounded list');
  let images = false;
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('Invalid local model message role');
    if (typeof message.content !== 'string' && message.content !== null && !Array.isArray(message.content)) throw new Error('Invalid local model message content');
    if (Array.isArray(message.content)) {
      if (message.role !== 'user' || message.content.length > 20) throw new Error('Multimodal content is supported only for bounded user messages');
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') continue;
        if (part?.type === 'image_url' && typeof part.image_url?.url === 'string'
          && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(part.image_url.url)) { images = true; continue; }
        throw new Error('Image review accepts embedded PNG, JPEG, or WebP images only');
      }
    }
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) throw new Error('Tool messages require tool_call_id');
    if (message.tool_calls !== undefined && (message.role !== 'assistant' || !validToolCalls(message.tool_calls))) throw new Error('Invalid local model tool calls');
  }
  return { images };
}

class LocalModelClient {
  constructor({ baseUrl, models, apiKey = process.env.LOCAL_MODEL_API_KEY, fetchImpl = globalThis.fetch, dryRun = false, timeoutMs = 60000 } = {}) {
    const local = validateLocalConfig({ ...(baseUrl === undefined ? {} : { baseUrl }), ...(models === undefined ? {} : { models }) });
    if (typeof fetchImpl !== 'function') throw new Error('Local inference requires a fetch implementation');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new Error('Local model timeoutMs must be between 1 and 180000');
    if (apiKey !== undefined && (typeof apiKey !== 'string' || /\s/.test(apiKey))) throw new Error('LOCAL_MODEL_API_KEY must be a token without whitespace');
    Object.defineProperty(this, 'apiKey', { value: apiKey });
    this.backend = 'local'; this.baseUrl = local.baseUrl; this.profiles = local.models;
    this.fetchImpl = fetchImpl; this.dryRun = Boolean(dryRun); this.timeoutMs = timeoutMs;
    this.catalog = null; this.catalogAt = 0; this.billing = BILLING;
  }

  async request(endpoint, { body, maxBytes }) {
    if (this.dryRun) throw new LocalModelError('Local model requests are disabled in dry-run', { code: 'DRY_RUN' });
    if (!['/models', '/chat/completions'].includes(endpoint)) throw new Error('Unsupported local model endpoint');
    const controller = new AbortController();
    let timer;
    try {
      const work = async () => {
        const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body }),
        });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* Ignore cleanup errors. */ }
          const status = Number.isInteger(response.status) ? response.status : null;
          throw new LocalModelError(`Local model request failed${status ? ` (HTTP ${status})` : ''}`, { status, code: 'HTTP_ERROR' });
        }
        return readJson(response, maxBytes);
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new LocalModelError('Local model request timed out; no automatic retry was attempted', { code: 'TIMEOUT' })); }, this.timeoutMs);
      });
      return await Promise.race([work(), timeout]);
    } catch (error) {
      if (error instanceof LocalModelError) throw error;
      throw new LocalModelError('Local model network request failed; no automatic retry or cloud fallback was attempted', { code: 'NETWORK_ERROR' });
    } finally { clearTimeout(timer); }
  }

  async listModels({ refresh = false } = {}) {
    if (this.dryRun) return [];
    if (!refresh && this.catalog && Date.now() - this.catalogAt < 5 * 60 * 1000) return structuredClone(this.catalog);
    const result = await this.request('/models', { maxBytes: 2 * 1024 * 1024 });
    if (!result || !Array.isArray(result.data) || result.data.length > 10000 || result.error) throw new LocalModelError('Local model server returned an invalid model catalog', { code: 'INVALID_RESPONSE' });
    const models = result.data.map(raw => normalizeLocalModel(raw, this.profiles.find(profile => profile.id === raw?.id))).filter(Boolean);
    this.catalog = [...new Map(models.map(model => [model.id, model])).values()];
    this.catalogAt = Date.now();
    return structuredClone(this.catalog);
  }

  async chat({ model, messages, tools, maxTokens = 3000, temperature, responseFormat } = {}) {
    if (this.dryRun) throw new LocalModelError('Local model requests are disabled in dry-run', { code: 'DRY_RUN' });
    if (!modelId(model, false, 'local')) throw new Error('Select a valid local model ID');
    const profile = this.profiles.find(item => item.id === model);
    if (!profile) throw new Error('Declare a trusted profile for the selected local model before use');
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16000 || maxTokens >= profile.contextLength || profile.maxCompletionTokens && maxTokens > profile.maxCompletionTokens) throw new Error('Local model maxTokens exceeds its configured output or context limit');
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('Local model temperature must be between 0 and 2');
    const { images } = validateMessages(messages);
    const eligibility = modelEligibility(localProfileModel(profile), { images });
    if (!eligibility.eligible) throw new Error(`Local model is ineligible: ${eligibility.reasons.join('; ')}`);
    if (tools !== undefined && (!Array.isArray(tools) || tools.length > 30 || tools.some(tool => !tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(tool.function.name)))) throw new Error('Invalid local model function tools');
    // Provider routing/privacy/pricing fields are OpenRouter-specific. Never send
    // them to a local server, and never reuse an OpenRouter credential here.
    const payload = { model, messages, max_tokens: maxTokens, stream: false };
    if (tools?.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
    if (temperature !== undefined) payload.temperature = temperature;
    if (responseFormat !== undefined) payload.response_format = responseFormat;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error('Local model request exceeds the size limit');
    const result = await this.request('/chat/completions', { body, maxBytes: CHAT_LIMIT });
    const choice = result?.choices?.[0];
    if (result?.error || choice?.error) throw new LocalModelError('Local model server returned an inference error', { code: 'PROVIDER_ERROR' });
    const raw = choice?.message;
    if (!raw || raw.role !== 'assistant' || !modelId(result.model, false, 'local')
      || !(typeof raw.content === 'string' || raw.content === null)
      || raw.tool_calls !== undefined && !validToolCalls(raw.tool_calls)) throw new LocalModelError('Local model server returned an invalid assistant response', { code: 'INVALID_RESPONSE' });
    const message = { role: 'assistant', content: raw.content };
    if (raw.tool_calls) message.tool_calls = raw.tool_calls;
    const usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (Number.isSafeInteger(result.usage?.[key]) && result.usage[key] >= 0) usage[key] = result.usage[key];
    return { id: typeof result.id === 'string' ? result.id.slice(0, 200) : null, model: result.model, message, usage, cost: 0, billing: { ...BILLING }, finishReason: choice.finish_reason || null };
  }
}

module.exports = { LocalModelClient, LocalModelError, normalizeLocalModel };
