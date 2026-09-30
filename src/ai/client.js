const { validateAIConfig } = require('./settings');
const { OpenRouterClient } = require('./openrouter');
const { LocalModelClient } = require('./local');

function createAIClient({ ai = {}, env = process.env, dryRun = false, fetchImpl, timeoutMs, maxRetries } = {}) {
  const config = validateAIConfig(ai);
  const common = { dryRun, ...(fetchImpl === undefined ? {} : { fetchImpl }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  if (config.backend === 'local') return new LocalModelClient({ ...common, ...config.local, apiKey: env.LOCAL_MODEL_API_KEY || '' });
  return new OpenRouterClient({ ...common, apiKey: env.OPENROUTER_API_KEY || '', ...(maxRetries === undefined ? {} : { maxRetries }) });
}

module.exports = { createAIClient };
