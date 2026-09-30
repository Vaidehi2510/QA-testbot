const { validateProvider } = require('./settings');

const API_URL = 'https://openrouter.ai/api/v1';
const CATALOG_LIMIT = 8 * 1024 * 1024;
const CHAT_LIMIT = 2 * 1024 * 1024;
const REQUEST_LIMIT = 12 * 1024 * 1024;

class OpenRouterError extends Error {
  constructor(message, { status = null, code = 'OPENROUTER_ERROR' } = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = code;
  }
}

function price(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function strings(value) { return Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, 100) : []; }
function normalizeModel(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(raw.id)) return null;
  const inputModalities = strings(raw.architecture?.input_modalities);
  const outputModalities = strings(raw.architecture?.output_modalities);
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 500) : raw.id,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 10000) : '',
    contextLength: count(raw.context_length),
    maxCompletionTokens: count(raw.top_provider?.max_completion_tokens),
    inputModalities, outputModalities,
    architecture: { input_modalities: inputModalities, output_modalities: outputModalities },
    supportedParameters: strings(raw.supported_parameters),
    pricing: Object.fromEntries(['prompt', 'completion', 'request', 'image'].map(key => [key, price(raw.pricing?.[key])])),
  };
}

async function readJson(response, maxBytes) {
  const length = Number(response.headers?.get('content-length'));
  if (length > maxBytes) throw new OpenRouterError('OpenRouter response exceeds the size limit', { code: 'RESPONSE_TOO_LARGE' });
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
          throw new OpenRouterError('OpenRouter response exceeds the size limit', { code: 'RESPONSE_TOO_LARGE' });
        }
        chunks.push(Buffer.from(chunk.value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new OpenRouterError('OpenRouter response exceeds the size limit', { code: 'RESPONSE_TOO_LARGE' });
  }
  try { return JSON.parse(text); }
  catch { throw new OpenRouterError('OpenRouter returned invalid JSON', { code: 'INVALID_RESPONSE' }); }
}

function validToolCalls(calls) {
  return Array.isArray(calls) && calls.length <= 30 && calls.every(call => call && typeof call.id === 'string'
    && call.id.length <= 200 && call.type === 'function' && call.function
    && typeof call.function.name === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(call.function.name)
    && typeof call.function.arguments === 'string' && call.function.arguments.length <= 200000);
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 300) throw new Error('OpenRouter messages must be a nonempty, bounded list');
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('Invalid OpenRouter message role');
    if (typeof message.content !== 'string' && message.content !== null && !Array.isArray(message.content)) throw new Error('Invalid OpenRouter message content');
    if (Array.isArray(message.content)) {
      if (message.role !== 'user' || message.content.length > 20) throw new Error('Multimodal content is supported only for bounded user messages');
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') continue;
        if (part?.type === 'image_url' && typeof part.image_url?.url === 'string'
          && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(part.image_url.url)) continue;
        throw new Error('Image review accepts embedded PNG, JPEG, or WebP images only');
      }
    }
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) throw new Error('Tool messages require tool_call_id');
    if (message.tool_calls !== undefined && (message.role !== 'assistant' || !validToolCalls(message.tool_calls))) throw new Error('Invalid OpenRouter tool calls');
  }
}

class OpenRouterClient {
  constructor({ apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = globalThis.fetch, dryRun = false, timeoutMs = 60000, maxRetries = 1 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('OpenRouter requires a fetch implementation');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new Error('OpenRouter timeoutMs must be between 1 and 180000');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new Error('OpenRouter maxRetries must be between 0 and 2');
    // Do not make credentials enumerable: reports and logs must not serialize them.
    Object.defineProperty(this, 'apiKey', { value: apiKey });
    this.fetchImpl = fetchImpl;
    this.dryRun = Boolean(dryRun);
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.catalog = null;
    this.catalogAt = 0;
  }

  async request(endpoint, { body, maxBytes }) {
    if (this.dryRun) throw new OpenRouterError('OpenRouter requests are disabled in dry-run', { code: 'DRY_RUN' });
    const paid = body !== undefined;
    if (paid && (typeof this.apiKey !== 'string' || !this.apiKey.trim() || /\s/.test(this.apiKey))) throw new OpenRouterError('Set OPENROUTER_API_KEY before running AI review', { code: 'MISSING_API_KEY' });
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      let timer;
      try {
        const work = async () => {
          const response = await this.fetchImpl(`${API_URL}${endpoint}`, {
            method: paid ? 'POST' : 'GET',
            headers: { Accept: 'application/json', ...(paid ? { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'QA Testbot' } : {}) },
            ...(paid ? { body } : {}),
            signal: controller.signal,
            redirect: 'error',
          });
          if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* Ignore cleanup errors. */ }
            const status = Number.isInteger(response.status) ? response.status : null;
            const error = new OpenRouterError(`OpenRouter request failed${status ? ` (HTTP ${status})` : ''}`, { status, code: 'HTTP_ERROR' });
            const retryAfter = response.headers?.get('retry-after');
            error.retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : 250;
            throw error;
          }
          return readJson(response, maxBytes);
        };
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new OpenRouterError('OpenRouter request timed out; its completion and billing status may be unknown', { code: 'TIMEOUT' }));
          }, this.timeoutMs);
        });
        return await Promise.race([work(), timeout]);
      } catch (error) {
        if (!(error instanceof OpenRouterError)) throw new OpenRouterError('OpenRouter network request failed; no automatic retry was attempted', { code: 'NETWORK_ERROR' });
        // Retrying a paid POST after a timeout or 5xx could buy a second response.
        if (error.status === 429 && attempt < this.maxRetries && error.retryAfterMs <= 2000) {
          clearTimeout(timer);
          await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
          continue;
        }
        throw error;
      } finally { clearTimeout(timer); }
    }
  }

  async listModels({ refresh = false } = {}) {
    if (this.dryRun) return [];
    if (!refresh && this.catalog && Date.now() - this.catalogAt < 5 * 60 * 1000) return structuredClone(this.catalog);
    const result = await this.request('/models', { maxBytes: CATALOG_LIMIT });
    if (!result || !Array.isArray(result.data) || result.data.length > 10000 || result.error) throw new OpenRouterError('OpenRouter returned an invalid model catalog', { code: 'INVALID_RESPONSE' });
    const models = result.data.map(normalizeModel).filter(Boolean);
    if (models.length === 0) throw new OpenRouterError('OpenRouter model catalog is empty', { code: 'INVALID_RESPONSE' });
    this.catalog = [...new Map(models.map(model => [model.id, model])).values()];
    this.catalogAt = Date.now();
    return structuredClone(this.catalog);
  }

  async chat({ model, messages, tools, maxTokens = 3000, temperature, provider, responseFormat } = {}) {
    if (this.dryRun) throw new OpenRouterError('OpenRouter requests are disabled in dry-run', { code: 'DRY_RUN' });
    if (typeof model !== 'string' || model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new Error('Select a valid OpenRouter model ID');
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16000) throw new Error('OpenRouter maxTokens must be between 1 and 16000');
    if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('OpenRouter temperature must be between 0 and 2');
    validateMessages(messages);
    if (tools !== undefined && (!Array.isArray(tools) || tools.length > 30 || tools.some(tool => !tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(tool.function.name)))) throw new Error('Invalid OpenRouter function tools');
    const payload = { model, messages, max_tokens: maxTokens, stream: false, provider: validateProvider(provider || {}) };
    if (tools?.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
    if (temperature !== undefined) payload.temperature = temperature;
    if (responseFormat !== undefined) payload.response_format = responseFormat;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error('OpenRouter request exceeds the size limit');
    const result = await this.request('/chat/completions', { body, maxBytes: CHAT_LIMIT });
    const choice = result?.choices?.[0];
    if (result?.error || choice?.error) throw new OpenRouterError('OpenRouter returned a provider error', { code: 'PROVIDER_ERROR' });
    const raw = choice?.message;
    if (!raw || raw.role !== 'assistant' || typeof result.model !== 'string'
      || !(typeof raw.content === 'string' || raw.content === null)
      || raw.tool_calls !== undefined && !validToolCalls(raw.tool_calls)) throw new OpenRouterError('OpenRouter returned an invalid assistant response', { code: 'INVALID_RESPONSE' });
    const message = { role: 'assistant', content: raw.content };
    if (raw.tool_calls) message.tool_calls = raw.tool_calls;
    // Some reasoning models require these opaque details on subsequent tool turns.
    if (Array.isArray(raw.reasoning_details)) message.reasoning_details = raw.reasoning_details;
    const usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (count(result.usage?.[key]) !== null) usage[key] = result.usage[key];
    const cost = price(result.usage?.cost);
    if (cost !== null) usage.cost = cost;
    return { id: typeof result.id === 'string' ? result.id : null, model: result.model, message, usage, cost, finishReason: choice.finish_reason || null };
  }
}

module.exports = { OpenRouterClient, OpenRouterError, normalizeModel };
