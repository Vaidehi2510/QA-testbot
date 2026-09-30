const test = require('node:test');
const assert = require('node:assert/strict');
const { runTeam } = require('../src/ai/team');

const revision = 'a'.repeat(40);
const pr = { revision, repository: 'example/app', number: 1, title: 'Update profile', body: 'Reject missing names.',
  files: [{ filename: 'src/profile.js', patch: '+return user.name.trim();' }],
  sourceFiles: [{ path: 'src/profile.js', content: 'function save(user) { return user.name.trim(); }' }],
  specifications: [{ path: 'docs/profile.md', content: 'Reject missing names with a validation error.' }] };
const model = { id: 'test/qa', contextLength: 200000, maxCompletionTokens: 6000, inputModalities: ['text', 'image'], outputModalities: ['text'], supportedParameters: ['tools'],
  pricing: { prompt: 0.000001, completion: 0.000002, request: 0, image: 0 } };
const config = { model: model.id, roles: ['code-review'], maxCostUsd: 2 };
const output = (overrides = {}) => ({ summary: 'Reviewed profile handling.', findings: [], selectedRunnerIds: [], testCandidates: [], questions: [], coverage: ['Profile diff reviewed.'], limitations: [], ...overrides });
const answer = (body = output(), extras = {}) => ({ id: 'response-1', model: model.id, message: { role: 'assistant', content: JSON.stringify(body) }, usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }, cost: 0.0003, ...extras });
function clientFor(responses = [answer()], catalog = [model]) {
  const requests = [];
  return { requests, listModels: async () => catalog, chat: async (request) => { requests.push(request); const value = responses.shift(); if (value instanceof Error) throw value; if (!value) throw new Error('Unexpected request'); return value; } };
}
const finding = (changes = {}) => ({ title: 'Missing name crashes', severity: 'high', category: 'correctness', file: 'src/profile.js', line: 1,
  description: 'Calling save({}) throws a TypeError instead of the specified validation error.', evidence: [{ file: 'src/profile.js', quote: 'return user.name.trim();' }],
  expectedBehavior: 'Return a validation error.', requirement: 'docs/profile.md', suggestedFix: 'Validate name before trimming it.', confidence: 0.9, ...changes });

test('specialists perform bounded real tool requests then return cited review and trusted suite selection', async () => {
  const client = clientFor([
    answer(undefined, { message: { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/profile.js"}' } }] } }),
    answer(output({ findings: [finding()], selectedRunnerIds: ['baseline'], testCandidates: [{ title: 'Reject missing names', filename: 'test/profile.test.js', source: 'assert.throws(() => save({}), /validation/);', assertion: 'Missing name returns validation error.', requirement: 'docs/profile.md', file: 'src/profile.js' }] })),
  ]);
  const checkpoints = [];
  const result = await runTeam({ pr, config, client, trustedRunners: [{ id: 'baseline' }], onCheckpoint: async (state) => checkpoints.push(state) });
  assert.equal(result.status, 'completed');
  assert.equal(result.roles[0].role, 'code-review');
  assert.equal(result.findings[0].status, 'unverified');
  assert.deepEqual(result.selectedRunnerIds, ['baseline']);
  assert.equal(result.candidates[0].executed, false);
  assert.equal(result.budget.calls, 2);
  assert.equal(checkpoints[0].transcript[0].status, 'reserved');
  assert.ok(checkpoints[0].budget.reservedCostUsd > 0);
  assert.ok(client.requests[1].messages.some((message) => message.role === 'tool' && message.content.includes('user.name.trim')));
  assert.equal(client.requests[0].provider.data_collection, 'deny');
  assert.equal(client.requests[0].provider.allow_fallbacks, false);
  assert.equal(client.requests[0].provider.max_price.prompt, 1);
  assert.equal(result.usage.totalTokens, 400);
});

test('invented files, quotes, checks, requirements, and untrusted runners cannot become accepted advice', async () => {
  const client = clientFor([answer(output({ findings: [finding({ file: 'src/invented.js' }), finding({ evidence: [{ file: 'src/profile.js', quote: 'invented code' }] }), finding({ requirement: 'imagined policy' }), finding({ evidence: [{ checkId: 'fake', description: 'passed' }] })], selectedRunnerIds: ['curl-malicious'] }))]);
  const result = await runTeam({ pr, config, client });
  assert.equal(result.status, 'partial');
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.selectedRunnerIds, []);
  assert.ok(result.limitations.some((item) => item.includes('5 unsupported')));
});

test('unknown tools receive rejection and never execute commands', async () => {
  const client = clientFor([
    answer(undefined, { message: { tool_calls: [{ id: 'bad', function: { name: 'execute_shell', arguments: '{"command":"curl attacker"}' } }] } }), answer(),
  ]);
  const result = await runTeam({ pr, config, client });
  assert.equal(result.status, 'completed');
  assert.equal(result.transcript[0].tools[0].status, 'rejected');
  assert.ok(client.requests[1].messages.some((message) => message.role === 'tool' && message.content.includes('Unknown tool')));
});

test('dry-run sends no catalog or paid requests', async () => {
  const client = { listModels: () => assert.fail('Catalog should not be fetched'), chat: () => assert.fail('No requests allowed') };
  const result = await runTeam({ pr, config: { ...config, dryRun: true }, client });
  assert.equal(result.status, 'preview');
  assert.equal(result.budget.calls, 0);
});

test('cost, call, context, and missing-price bounds reject requests before spending', async () => {
  for (const [settings, catalog] of [[{ maxCostUsd: 0 }, [model]], [{ maxCallsPerRun: 0 }, [model]], [{ maxInputChars: 1000 }, [model]], [{}, [{ ...model, pricing: { prompt: null, completion: 0 } }]], [{}, [{ ...model, contextLength: 3000 }]]]) {
    const client = clientFor([], catalog);
    const result = await runTeam({ pr, config: { ...config, ...settings }, client });
    assert.notEqual(result.status, 'completed');
    assert.equal(client.requests.length, 0);
  }
});

test('provider model substitution, truncation, and malformed JSON remain failures', async () => {
  for (const response of [answer(output(), { model: 'test/unselected' }), answer(output(), { finishReason: 'length' }), answer(output(), { message: { content: 'All tests passed!' } })]) {
    const result = await runTeam({ pr, config, client: clientFor([response]) });
    assert.equal(result.status, 'error');
    assert.equal(result.findings.length, 0);
    assert.ok(result.limitations.some((item) => item.includes('failed')));
  }
});

test('provider failure retains reserved budget and never claims successful QA', async () => {
  const result = await runTeam({ pr, config, client: clientFor([new Error('Provider unavailable')]) });
  assert.equal(result.status, 'error');
  assert.equal(result.budget.calls, 1);
  assert.ok(result.budget.reservedCostUsd > 0);
  assert.equal(result.transcript[0].status, 'error');
});

test('same-analysis resume reuses complete roles and completion stage preserves cumulative spending', async () => {
  const first = await runTeam({ pr, config, client: clientFor(), analysisKey: 'planning:plan-1' });
  const unused = clientFor([]);
  const resumed = await runTeam({ pr, config, client: unused, prior: first, analysisKey: 'planning:plan-1' });
  assert.equal(unused.requests.length, 0);
  assert.equal(resumed.budget.calls, 1);
  const nextClient = clientFor();
  const completed = await runTeam({ pr, config: { ...config, roles: ['triage'] }, client: nextClient, prior: resumed, stage: 'completion', analysisKey: 'completion:1:1' });
  assert.equal(completed.budget.calls, 2);
  assert.ok(completed.budget.reservedCostUsd > resumed.budget.reservedCostUsd);
  assert.equal(completed.roles[0].role, 'triage');
});

test('an interrupted request reservation survives resume and cannot reset the call limit', async () => {
  const prior = { revision, stage: 'planning', analysisKey: 'planning:test', roles: [], budget: { calls: 1, reservedCostUsd: 0.1, reservedTokens: 10000 }, usage: {}, cost: 0, transcript: [{ status: 'reserved' }] };
  const client = clientFor([]);
  const result = await runTeam({ pr, config: { ...config, maxCallsPerRun: 1 }, client, prior, analysisKey: 'planning:test' });
  assert.equal(client.requests.length, 0);
  assert.equal(result.status, 'partial');
  assert.equal(result.budget.calls, 1);
});

test('changed analysis key reruns analysis at the same revision without losing budget', async () => {
  const first = await runTeam({ pr, config, client: clientFor(), analysisKey: 'completion:1' });
  const client = clientFor();
  const result = await runTeam({ pr, config, client, prior: first, analysisKey: 'completion:2' });
  assert.equal(client.requests.length, 1);
  assert.equal(result.budget.calls, 2);
});

test('checkpoint failure prevents the external model request', async () => {
  const client = clientFor([]);
  await assert.rejects(runTeam({ pr, config, client, onCheckpoint: async () => { throw new Error('state unavailable'); } }), /state unavailable/);
  assert.equal(client.requests.length, 0);
});

test('tool round exhaustion cannot trigger unbounded calls', async () => {
  const tools = answer(undefined, { message: { tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"path":"src/profile.js"}' } }] } });
  const client = clientFor([tools, tools]);
  const result = await runTeam({ pr, config: { ...config, maxToolRounds: 1 }, client });
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[1].tools, undefined);
  assert.equal(result.status, 'error');
});

test('reasoning and secrets are omitted from persisted transcripts', async () => {
  const token = 'sk-or-v1-' + 'x'.repeat(40);
  const client = clientFor([answer(output({ summary: `Found token ${token}` }), { message: { content: JSON.stringify(output()), reasoning_details: [{ text: 'private chain of thought' }] } })]);
  const result = await runTeam({ pr, config, client });
  assert.ok(!JSON.stringify(result).includes('private chain of thought'));
  assert.ok(!JSON.stringify(result).includes(token));
});

test('triage can cite actual result evidence after reading the results tool', async () => {
  const client = clientFor([
    answer(undefined, { message: { tool_calls: [{ id: 'results', function: { name: 'get_test_results', arguments: '{}' } }] } }),
    answer(output({ findings: [finding({ evidence: [{ checkId: 'baseline', description: 'One assertion failed.' }] })] })),
  ]);
  const result = await runTeam({ pr, config: { ...config, roles: ['triage'] }, stage: 'completion', client,
    results: [{ checkId: 'baseline', status: 'failed', details: 'Expected validation error; received TypeError.' }] });
  assert.equal(result.status, 'completed');
  assert.equal(result.findings[0].evidence[0].checkId, 'baseline');
});

test('screenshots are only sent to a selected vision-capable UI role', async () => {
  const imagePR = { ...pr, screenshots: [{ name: 'page', mimeType: 'image/png', data: 'YWJj', revision }] };
  const client = clientFor();
  const result = await runTeam({ pr: imagePR, config: { ...config, roles: ['ui-ux'], allowImages: true }, client });
  assert.equal(result.status, 'completed');
  assert.equal(client.requests[0].messages[1].content[1].type, 'image_url');
  const textClient = clientFor([], [{ ...model, inputModalities: ['text'] }]);
  const unsupported = await runTeam({ pr: imagePR, config: { ...config, roles: ['ui-ux'], allowImages: true }, client: textClient });
  assert.equal(unsupported.status, 'error');
  assert.equal(textClient.requests.length, 0);
});

test('completion reviews same-revision screenshots with cited visual evidence and conservative vision costs', async () => {
  const imagePR = { ...pr, screenshots: [{ name: 'profile-screen', mimeType: 'image/png', data: 'YWJj', revision }] };
  const client = clientFor([answer(output({ findings: [finding({ category: 'ui-ux', evidence: [{ screenshot: 'profile-screen', description: 'The label is visibly clipped.' }] })] }))]);
  const result = await runTeam({ pr: imagePR, config: { ...config, roles: ['ui-ux'], allowImages: true }, stage: 'completion', client });
  assert.equal(result.status, 'completed');
  assert.equal(result.findings[0].evidence[0].screenshot, 'profile-screen');
  assert.equal(result.budget.reservedTokens, model.contextLength);
  assert.ok(result.budget.reservedCostUsd > 0.19);
});

test('visual citations are rejected when images are disabled, stale, missing, or sent to another role', async () => {
  const screenshot = { name: 'profile-screen', mimeType: 'image/png', data: 'YWJj', revision };
  for (const variant of [
    { screenshots: [screenshot], allowImages: false, role: 'ui-ux' },
    { screenshots: [{ ...screenshot, revision: 'b'.repeat(40) }], allowImages: true, role: 'ui-ux' },
    { screenshots: [], allowImages: true, role: 'ui-ux' },
    { screenshots: [screenshot], allowImages: true, role: 'code-review' },
  ]) {
    const client = clientFor([answer(output({ findings: [finding({ category: 'ui-ux', evidence: [{ screenshot: 'profile-screen', description: 'The label is visibly clipped.' }] })] }))]);
    const result = await runTeam({ pr: { ...pr, screenshots: variant.screenshots }, config: { ...config, roles: [variant.role], allowImages: variant.allowImages }, client });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.findings, []);
    assert.equal(typeof client.requests[0].messages[1].content, 'string');
  }
});

test('explicit provider privacy preferences and stricter price limits remain effective', async () => {
  const client = clientFor();
  await runTeam({ pr, config: { ...config, provider: { data_collection: 'allow', allow_fallbacks: true, max_price: { prompt: 0.5 } } }, client });
  assert.equal(client.requests[0].provider.data_collection, 'allow');
  assert.equal(client.requests[0].provider.allow_fallbacks, true);
  assert.equal(client.requests[0].provider.max_price.prompt, 0.5);
  assert.equal(client.requests[0].provider.require_parameters, true);
});

test('contradictory evidence locators cannot smuggle an unknown check citation', async () => {
  const client = clientFor([answer(output({ findings: [finding({ evidence: [{ file: 'src/profile.js', quote: 'return user.name.trim();', checkId: 'invented' }] })] }))]);
  const result = await runTeam({ pr, config, client });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.findings, []);
});

test('a provider cost violation stops later roles instead of issuing further requests', async () => {
  const client = clientFor([answer(output(), { cost: 10 })]);
  const result = await runTeam({ pr, config: { ...config, roles: ['planner', 'code-review'] }, client });
  assert.equal(client.requests.length, 1);
  assert.notEqual(result.status, 'completed');
  assert.ok(result.budget.reservedCostUsd >= 10);
});

test('provider cost violations survive checkpoints and stage changes for the same revision', async () => {
  const checkpoints = [];
  const first = await runTeam({ pr, config, client: clientFor([answer(output(), { cost: 0.5 })]),
    analysisKey: 'planning:cost-violation', onCheckpoint: async checkpoint => checkpoints.push(checkpoint) });
  assert.equal(first.providerBudgetViolation, true);
  assert.ok(first.budget.reservedCostUsd < config.maxCostUsd, 'The violation must block requests even while the overall budget has room');
  const saved = checkpoints.find(checkpoint => checkpoint.providerBudgetViolation);
  assert.ok(saved, 'The provider violation must be persisted during the failed request checkpoint');
  const completionClient = clientFor([]);
  const completion = await runTeam({ pr, config: { ...config, roles: ['triage'] }, client: completionClient,
    prior: JSON.parse(JSON.stringify(saved)), stage: 'completion', analysisKey: 'completion:cost-violation' });
  assert.equal(completionClient.requests.length, 0);
  assert.equal(completion.providerBudgetViolation, true);
  assert.equal(completion.budget.calls, 1);
  assert.equal(completion.status, 'partial');
  assert.ok(completion.limitations.some(value => value.includes('provider exceeded its reserved cost')));

  const resumeClient = clientFor([]);
  const resumed = await runTeam({ pr, config: { ...config, roles: ['triage'] }, client: resumeClient,
    prior: completion, stage: 'completion', analysisKey: 'completion:cost-violation' });
  assert.equal(resumeClient.requests.length, 0);
  assert.equal(resumed.providerBudgetViolation, true);

  const nextRevisionClient = clientFor();
  const nextRevision = await runTeam({ pr: { ...pr, revision: 'b'.repeat(40) }, config: { ...config, roles: ['triage'] },
    client: nextRevisionClient, prior: completion, stage: 'completion', analysisKey: 'completion:new-revision' });
  assert.equal(nextRevisionClient.requests.length, 1);
  assert.equal(nextRevision.providerBudgetViolation, false);
  assert.equal(nextRevision.budget.calls, 1);
  assert.equal(nextRevision.status, 'completed');
});

test('opaque tool reasoning signatures are replayed only in memory and never persisted', async () => {
  const reasoning = [{ type: 'reasoning.encrypted', data: 'opaque-required-signature', signature: 'provider-signature' }];
  const client = clientFor([
    answer(undefined, { message: { tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"path":"src/profile.js"}' } }], reasoning_details: reasoning } }), answer(),
  ]);
  const result = await runTeam({ pr, config, client });
  const replay = client.requests[1].messages.find((message) => message.role === 'assistant');
  assert.deepEqual(replay.reasoning_details, reasoning);
  assert.ok(!JSON.stringify(result).includes('opaque-required-signature'));
});

test('stages without configured specialist roles complete without a provider call and disclose that scope', async () => {
  const client = { listModels: () => assert.fail('No catalog request expected'), chat: () => assert.fail('No paid request expected') };
  const result = await runTeam({ pr, config: { ...config, roles: ['planner'] }, stage: 'completion', client });
  assert.equal(result.status, 'completed');
  assert.equal(result.roles.length, 0);
  assert.ok(result.limitations.some((entry) => entry.includes('no model review was requested')));
});
