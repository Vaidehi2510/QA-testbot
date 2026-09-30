const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenRouterClient, normalizeModel } = require('../src/ai/openrouter');

const rawModel = {
  id: 'example/qa-model', name: 'QA model', description: 'Tool-capable text model', context_length: 32768,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'max_tokens'],
  pricing: { prompt: '0.000001', completion: '0.000002', request: '0', image: '0.001' },
  top_provider: { max_completion_tokens: 8192 },
};
const completion = {
  id: 'gen-qa', model: 'example/qa-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"findings":[]}' } }],
  usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40, cost: 0.00005 },
};
const args = { model: rawModel.id, messages: [{ role: 'user', content: 'Inspect changes.' }], maxTokens: 1000 };
function json(value, options) { return new Response(JSON.stringify(value), options); }

test('OpenRouter catalog needs no key, normalizes live model prices, and caches without mutation', async () => {
  const requests = [];
  const client = new OpenRouterClient({ apiKey: 'should-not-be-sent', fetchImpl: async (...params) => { requests.push(params); return json({ data: [rawModel, { id: '../invalid' }] }); } });
  const first = await client.listModels();
  assert.equal(first.length, 1);
  assert.equal(first[0].pricing.prompt, 0.000001);
  assert.equal(first[0].maxCompletionTokens, 8192);
  assert.deepEqual(first[0].inputModalities, ['text', 'image']);
  first[0].name = 'changed';
  assert.equal((await client.listModels())[0].name, 'QA model');
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'https://openrouter.ai/api/v1/models');
  assert.equal(requests[0][1].headers.Authorization, undefined);
  await client.listModels({ refresh: true });
  assert.equal(requests.length, 2);
});

test('unknown and malformed model prices remain unknown, never free', () => {
  const model = normalizeModel({ ...rawModel, pricing: { prompt: null, completion: '-1', image: 'NaN', request: '' } });
  assert.deepEqual(model.pricing, { prompt: null, completion: null, request: null, image: null });
  assert.equal(normalizeModel({ ...rawModel, pricing: { prompt: '0', completion: 0 } }).pricing.prompt, 0);
});

test('OpenRouter submits authenticated tools and carries usage and opaque reasoning for tool continuations', async () => {
  const toolCalls = [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }];
  const reasoning = [{ type: 'reasoning.encrypted', data: 'opaque-signature' }];
  let sent;
  const client = new OpenRouterClient({ apiKey: 'secret-key', fetchImpl: async (url, request) => {
    sent = { url, request, body: JSON.parse(request.body) };
    return json({ ...completion, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: toolCalls, reasoning_details: reasoning } }] });
  } });
  const result = await client.chat({ ...args, tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] });
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.request.headers.Authorization, 'Bearer secret-key');
  assert.equal(sent.request.redirect, 'error');
  assert.equal(sent.body.max_tokens, 1000);
  assert.equal(sent.body.provider.require_parameters, true);
  assert.equal(sent.body.provider.data_collection, 'deny');
  assert.equal(sent.body.provider.allow_fallbacks, false);
  assert.equal(sent.body.stream, false);
  assert.equal(result.cost, 0.00005);
  assert.deepEqual(result.message.tool_calls, toolCalls);
  assert.deepEqual(result.message.reasoning_details, reasoning);
  assert.equal(JSON.stringify(client).includes('secret-key'), false);
  await client.chat({ ...args, messages: [...args.messages, result.message, { role: 'tool', tool_call_id: 'read-1', content: 'source contents' }] });
  assert.deepEqual(sent.body.messages[1].reasoning_details, reasoning);
});

test('vision supports embedded screenshots and rejects arbitrary remote image URLs', async () => {
  let sent;
  const client = new OpenRouterClient({ apiKey: 'key', fetchImpl: async (_url, request) => { sent = JSON.parse(request.body); return json(completion); } });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Inspect this state' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }];
  await client.chat({ ...args, messages });
  assert.deepEqual(sent.messages, messages);
  messages[0].content[1].image_url.url = 'https://attacker.example/image';
  await assert.rejects(client.chat({ ...args, messages }), /embedded PNG/);
});

test('dry-run prevents catalog and paid requests even when credentials exist', async () => {
  const client = new OpenRouterClient({ apiKey: 'key', dryRun: true, fetchImpl: async () => { throw new Error('Must not call'); } });
  assert.deepEqual(await client.listModels(), []);
  await assert.rejects(client.chat(args), error => error.code === 'DRY_RUN');
});

test('missing API key fails before network access', async () => {
  const client = new OpenRouterClient({ apiKey: '', fetchImpl: async () => { throw new Error('Must not call'); } });
  await assert.rejects(client.chat(args), error => error.code === 'MISSING_API_KEY');
});

test('rate limit retries are bounded; ambiguous 5xx and network failures never retry paid calls', async () => {
  let requests = 0;
  const client = new OpenRouterClient({ apiKey: 'key', fetchImpl: async () => ++requests === 1 ? json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } }) : json(completion) });
  await client.chat(args);
  assert.equal(requests, 2);
  for (const failure of [async () => json({ error: 'secret-key provider detail' }, { status: 500 }), async () => { throw new Error('https://internal.example/ secret-key'); }]) {
    requests = 0;
    const failed = new OpenRouterClient({ apiKey: 'secret-key', fetchImpl: async () => { requests++; return failure(); } });
    await assert.rejects(failed.chat(args), error => !error.message.includes('secret-key') && !error.message.includes('internal.example'));
    assert.equal(requests, 1);
  }
});

test('timeout is bounded even when injected fetch ignores cancellation and is never retried', async () => {
  let requests = 0;
  const client = new OpenRouterClient({ apiKey: 'key', timeoutMs: 5, fetchImpl: async () => { requests++; return new Promise(() => {}); } });
  await assert.rejects(client.chat(args), error => error.code === 'TIMEOUT');
  assert.equal(requests, 1);
});

test('oversized, malformed, and provider-error responses cannot produce review evidence', async () => {
  const cases = [
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => new Response('not json'),
    () => json({ error: { message: 'provider detail secret-key' } }),
    () => json({ ...completion, choices: [{ error: { message: 'secret-key' } }] }),
    () => json({ ...completion, choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'unsafe' } }] } }] }),
  ];
  for (const response of cases) {
    const client = new OpenRouterClient({ apiKey: 'key', fetchImpl: async () => response() });
    await assert.rejects(client.chat(args), error => !error.message.includes('secret-key'));
  }
});

test('missing usage cost is explicit so callers reserve or block spending', async () => {
  const client = new OpenRouterClient({ apiKey: 'key', fetchImpl: async () => json({ ...completion, usage: { total_tokens: 30 } }) });
  const result = await client.chat(args);
  assert.equal(result.cost, null);
  assert.deepEqual(result.usage, { total_tokens: 30 });
});

test('empty catalogs and unsafe provider settings fail closed', async () => {
  const client = new OpenRouterClient({ apiKey: 'key', fetchImpl: async () => json({ data: [] }) });
  await assert.rejects(client.listModels(), /catalog is empty/);
  await assert.rejects(client.chat({ ...args, provider: { require_parameters: false } }), /require_parameters/);
});
