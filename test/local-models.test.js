const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalModelClient } = require('../src/ai/local');
const { createAIClient } = require('../src/ai/client');
const { modelEligibility } = require('../src/ai/settings');
const { runTeam } = require('../src/ai/team');

const profile = { id: 'qa-model:8b', contextLength: 32768, maxCompletionTokens: 4096, tools: true, vision: true };
const completion = { id: 'local-generation', model: profile.id, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"findings":[]}' } }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
const args = { model: profile.id, messages: [{ role: 'user', content: 'Inspect changes.' }], maxTokens: 1000 };
const json = (value, options) => new Response(JSON.stringify(value), options);
const ai = { backend: 'local', enabled: true, model: profile.id, local: { models: [profile] } };

test('local discovery uses loopback and trusts explicit profiles rather than catalog capability guesses', async () => {
  const requests = [];
  const client = new LocalModelClient({ models: [profile], apiKey: '', fetchImpl: async (...request) => { requests.push(request); return json({ data: [{ id: profile.id }, { id: 'unknown/model', context_length: 999999, supported_parameters: ['tools'] }, { id: 'https://external/model' }] }); } });
  const catalog = await client.listModels();
  assert.equal(requests[0][0], 'http://127.0.0.1:11434/v1/models');
  assert.equal(requests[0][1].headers.Authorization, undefined);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].contextLength, 32768);
  assert.equal(modelEligibility(catalog[0], { images: true }).eligible, true);
  assert.equal(catalog[1].contextLength, null);
  assert.equal(modelEligibility(catalog[1]).eligible, false);
  assert.match(modelEligibility(catalog[1]).reasons.join(' '), /trusted profile/);
  catalog[0].contextLength = 1;
  assert.equal((await client.listModels())[0].contextLength, 32768);
  assert.equal(requests.length, 1);
  await client.listModels({ refresh: true });
  assert.equal(requests.length, 2);
});

test('local chat sends tools, only the local key, and no OpenRouter routing fields', async () => {
  let sent;
  const toolCalls = [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }];
  const client = createAIClient({ ai, env: { LOCAL_MODEL_API_KEY: 'local-secret', OPENROUTER_API_KEY: 'cloud-secret' }, fetchImpl: async (url, request) => {
    sent = { url, request, body: JSON.parse(request.body) };
    return json({ ...completion, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: toolCalls, reasoning: 'do not store private reasoning' } }] });
  } });
  const result = await client.chat({ ...args, tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], provider: { max_price: { prompt: 0 }, data_collection: 'deny' } });
  assert.equal(sent.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(sent.request.headers.Authorization, 'Bearer local-secret');
  assert.equal(sent.request.redirect, 'error');
  assert.equal(sent.body.provider, undefined);
  assert.equal(sent.body.max_tokens, 1000);
  assert.equal(sent.body.stream, false);
  assert.equal(sent.body.tool_choice, 'auto');
  assert.equal(result.cost, 0);
  assert.deepEqual(result.billing, { metered: false, computeCostTracked: false });
  assert.deepEqual(result.message.tool_calls, toolCalls);
  assert.equal(result.message.reasoning, undefined);
  assert.equal(JSON.stringify(client).includes('local-secret'), false);
  assert.equal(JSON.stringify(sent).includes('cloud-secret'), false);
});

test('local requests require no key and never reuse a configured OpenRouter credential', async () => {
  const requests = [];
  const client = createAIClient({ ai, env: { OPENROUTER_API_KEY: 'cloud-secret' }, fetchImpl: async (...request) => { requests.push(request); return json(request[0].endsWith('/models') ? { data: [{ id: profile.id }] } : completion); } });
  await client.listModels();
  await client.chat(args);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(([, request]) => !request.headers.Authorization));
});

test('local vision requires declared capability and embedded images', async () => {
  let calls = 0;
  const client = new LocalModelClient({ models: [profile], apiKey: '', fetchImpl: async () => { calls++; return json(completion); } });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Review this page' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }];
  await client.chat({ ...args, messages });
  assert.equal(calls, 1);
  const textOnly = new LocalModelClient({ models: [{ ...profile, vision: false }], apiKey: '', fetchImpl: async () => { throw new Error('Must not call'); } });
  await assert.rejects(textOnly.chat({ ...args, messages }), /Image input/);
  messages[0].content[1].image_url.url = 'http://127.0.0.1:1234/private';
  await assert.rejects(client.chat({ ...args, messages }), /embedded PNG/);
  assert.equal(calls, 1);
});

test('local capability and output limits fail before sending source', async () => {
  const client = new LocalModelClient({ models: [profile], apiKey: '', fetchImpl: async () => { throw new Error('Must not call'); } });
  await assert.rejects(client.chat({ ...args, model: 'unprofiled' }), /trusted profile/);
  await assert.rejects(client.chat({ ...args, maxTokens: 5000 }), /output or context limit/);
  await assert.rejects(client.chat({ ...args, tools: [{ type: 'computer' }] }), /function tools/);
  await assert.rejects(client.chat({ ...args, messages: [{ role: 'tool', content: 'source' }] }), /tool_call_id/);
  const incapable = new LocalModelClient({ models: [{ ...profile, tools: false }], apiKey: '', fetchImpl: async () => { throw new Error('Must not call'); } });
  await assert.rejects(incapable.chat(args), /Tool calling/);
});

test('dry-run local mode makes no discovery or inference requests', async () => {
  const client = createAIClient({ ai, dryRun: true, env: {}, fetchImpl: async () => { throw new Error('Must not call'); } });
  assert.deepEqual(await client.listModels(), []);
  await assert.rejects(client.chat(args), error => error.code === 'DRY_RUN');
});

test('local HTTP, network and timeout failures never retry or fall back to cloud', async () => {
  for (const fetchImpl of [async () => json({ error: 'local-secret' }, { status: 429 }), async () => { throw new Error('local-secret https://private.invalid'); }, async () => new Promise(() => {})]) {
    const requests = [];
    const client = createAIClient({ ai, env: { OPENROUTER_API_KEY: 'cloud-secret', LOCAL_MODEL_API_KEY: 'local-secret' }, timeoutMs: 5, fetchImpl: async (...request) => { requests.push(request); return fetchImpl(); } });
    await assert.rejects(client.chat(args), error => !error.message.includes('local-secret') && !error.message.includes('private.invalid'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], 'http://127.0.0.1:11434/v1/chat/completions');
  }
});

test('local responses are bounded and malformed output never becomes review evidence', async () => {
  const cases = [
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => new Response('invalid JSON'),
    () => json({ error: { message: 'local-secret' } }),
    () => json({ ...completion, choices: [{ error: { message: 'local-secret' } }] }),
    () => json({ ...completion, choices: [{ message: { role: 'assistant', content: {}, tool_calls: [] } }] }),
    () => json({ ...completion, choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'bad' }] } }] }),
  ];
  for (const response of cases) {
    const client = new LocalModelClient({ models: [profile], apiKey: '', fetchImpl: async () => response() });
    await assert.rejects(client.chat(args), error => !error.message.includes('local-secret'));
  }
});

test('local catalog validates response shape and permits an empty installed model list', async () => {
  const empty = new LocalModelClient({ apiKey: '', fetchImpl: async () => json({ data: [] }) });
  assert.deepEqual(await empty.listModels(), []);
  const malformed = new LocalModelClient({ apiKey: '', fetchImpl: async () => json({ data: {}, error: 'secret' }) });
  await assert.rejects(malformed.listModels(), /invalid model catalog/);
});

test('factory defaults to OpenRouter and isolates keys for either backend', async () => {
  let request;
  const client = createAIClient({ env: { OPENROUTER_API_KEY: 'cloud-secret', LOCAL_MODEL_API_KEY: 'local-secret' }, fetchImpl: async (url, options) => { request = { url, options }; return json({ ...completion, model: 'provider/model' }); } });
  await client.chat({ ...args, model: 'provider/model' });
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer cloud-secret');
  assert.equal(JSON.stringify(request).includes('local-secret'), false);
  assert.throws(() => createAIClient({ ai: { backend: 'fallback' } }), /backend/);
});

test('the actual team tool loop runs with a local client, bounded calls and zero provider budget', async () => {
  const calls = [];
  const client = createAIClient({ ai, env: {}, fetchImpl: async (url, request) => {
    if (url.endsWith('/models')) return json({ data: [{ id: profile.id }] });
    const payload = JSON.parse(request.body); calls.push(payload);
    if (calls.length === 1) return json({ ...completion, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }] } }] });
    return json({ ...completion, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: 'Reviewed the source file.', findings: [], questions: [], testCandidates: [], selectedRunnerIds: [], coverage: ['src/a.js'], limitations: ['Only the supplied source file was inspected.'] }) } }] });
  } });
  const result = await runTeam({ pr: { repository: 'owner/product', number: 1, revision: 'a'.repeat(40), files: [{ filename: 'src/a.js', patch: '+const n = 1;' }], sourceFiles: [{ path: 'src/a.js', content: 'const n = 1;' }] }, plan: { checks: [] }, config: { ...ai, roles: ['planner'], maxCostUsd: 0, maxToolRounds: 2, maxCallsPerRun: 2, maxOutputTokens: 1000 }, client, stage: 'planning', trustedRunners: [] });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.equal(result.budget.calls, 2);
  assert.equal(result.cost, 0);
  assert.equal(result.budget.reservedCostUsd, 0);
});
