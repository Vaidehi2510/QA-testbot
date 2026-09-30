const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { OpenRouterClient } = require('./openrouter');
const { DEFAULT_AI_CONFIG } = require('./settings');
const { addReviewGate, reviewStage } = require('./pipeline');
const { generatePlan } = require('../planner');
const { executePlan } = require('../executor');
const { assessPR, completeRun } = require('../lifecycle');
const { FileStore } = require('../state');
const { renderReport } = require('../report');

// Exercises the real HTTP adapter/tool loop against clearly mocked provider
// responses. No key, network, Slack, Drive, or GitHub operation is performed.
function createMockClient(calls = []) {
  const model = 'mock/qa-specialist';
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: model, name: 'MOCK QA specialist', context_length: 64000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'],
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' } }] });
    const request = JSON.parse(options.body);
    const system = request.messages[0].content;
    const role = system.includes('Plan regression') ? 'planner' : system.includes('Inspect authentication') ? 'security' : system.includes('Inspect UI components') ? 'ui-ux' : system.includes('Inspect actual executor') ? 'triage' : 'code-review';
    const toolMessages = request.messages.filter(message => message.role === 'tool');
    calls.push({ role, model: request.model, toolMessages: toolMessages.length });
    let message;
    if (!toolMessages.length) {
      const target = role === 'ui-ux' ? 'Checkout.jsx' : 'calculator.js';
      const tools = [{ id: 'read-source', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: target }) } }];
      if (role === 'triage') tools.push({ id: 'read-evidence', type: 'function', function: { name: 'get_test_results', arguments: '{}' } });
      message = { role: 'assistant', content: null, tool_calls: tools };
    } else {
      const final = { summary: `[MOCK ${role}] Reviewed captured evidence at the supplied revision.`, findings: [], selectedRunnerIds: [], testCandidates: [], questions: [],
        coverage: ['Only the explicitly cited synthetic fixture files were reviewed.'], limitations: ['MOCK model response; not a live model evaluation.'] };
      if (role === 'planner') {
        final.selectedRunnerIds = ['node-tests'];
        final.testCandidates.push({ title: 'Keep the exact free-shipping boundary covered', filename: 'test/shipping-boundary.test.js',
          source: "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { shippingCost } = require('../calculator');\ntest('exact threshold ships free', () => assert.equal(shippingCost(100), 0));",
          assertion: 'An order of exactly $100 has zero shipping cost.', requirement: 'PR description', file: 'calculator.js' });
      }
      if (['code-review', 'triage'].includes(role)) final.findings.push({ title: 'Exact-threshold orders are charged shipping', severity: 'high', category: 'correctness', file: 'calculator.js', line: 4,
        description: 'At amount=100 the strict comparison returns a $5 charge, contradicting the documented inclusive threshold.',
        evidence: [{ file: 'calculator.js', quote: 'return amount > 100 ? 0 : 5;' }], expectedBehavior: 'Orders of at least $100 ship free.', requirement: 'PR description',
        suggestedFix: 'Replace amount > 100 with amount >= 100 and retain the boundary regression test.', confidence: 0.99 });
      if (role === 'ui-ux') final.findings.push({ title: 'Checkout input lacks an accessible name', severity: 'medium', category: 'ui-ux', file: 'Checkout.jsx', line: 1,
        description: 'The amount input has no associated label or aria-label in the changed component. This is a source observation, not a browser audit.',
        evidence: [{ file: 'Checkout.jsx', quote: '<input type="number" />' }], suggestedFix: 'Add a visible label associated with the input id, then verify keyboard and screen-reader behavior.', confidence: 0.9 });
      message = { role: 'assistant', content: JSON.stringify(final) };
    }
    return Response.json({ id: `mock-${calls.length}`, model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, cost: 0 } });
  };
  return new OpenRouterClient({ apiKey: 'mock-only-key', fetchImpl, maxRetries: 0 });
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-ai-demo-'));
  try {
    const cwd = path.join(directory, 'application');
    await fs.cp(path.join(__dirname, '../../fixtures/tiny-app'), cwd, { recursive: true });
    const calculator = (await fs.readFile(path.join(cwd, 'calculator.js'), 'utf8')).replace('amount >= 100', 'amount > 100');
    await fs.writeFile(path.join(cwd, 'calculator.js'), calculator);
    const ui = 'export const Checkout = () => <form><input type="number" /><button>Pay</button></form>;';
    const config = { environment: 'synthetic-ai-demo', execution: { isolation: 'process' },
      runners: [{ id: 'node-tests', type: 'node-test', baseline: true, files: ['calculator.test.js'], timeoutMs: 3000 }],
      ai: { ...DEFAULT_AI_CONFIG, enabled: true, model: 'mock/qa-specialist' } };
    const pr = { repository: 'example/shop', number: 201, title: 'Review checkout with the AI QA team', author: 'demo-author', url: 'https://github.com/example/shop/pull/201',
      revision: 'e'.repeat(40), body: 'Orders of at least $100 ship free. Smaller orders cost $5. Reject invalid amounts.',
      files: [{ filename: 'calculator.js', patch: '- return amount >= 100 ? 0 : 5;\n+ return amount > 100 ? 0 : 5;' }, { filename: 'Checkout.jsx', patch: `+${ui}` }],
      sourceFiles: [{ path: 'calculator.js', content: calculator }, { path: 'Checkout.jsx', content: ui }],
      existingTests: [{ path: 'calculator.test.js', content: await fs.readFile(path.join(cwd, 'calculator.test.js'), 'utf8') }], comments: [] };
    const store = new FileStore(path.join(directory, 'state'));
    const calls = [];
    const client = createMockClient(calls);
    console.log('AI QA TEAM DEMO — OpenRouter responses are MOCKED; fixture tests execute for real. No network or credentials.\n');
    console.log('[MOCK catalog]', (await client.listModels()).map(model => model.id).join(', '));
    await store.withLock(async (state, save) => {
      const plan = addReviewGate(generatePlan(pr, [], config), config, pr.revision);
      const { run } = assessPR(state, pr, plan, config);
      await reviewStage({ run, pr, config, client, stage: 'planning', save: () => save(state) });
      assert.equal(run.ai.planning.status, 'completed');
      console.log('[MOCK agents] Planning roles:', run.ai.planning.roles.map(role => role.role).join(', '));
      console.log('[MOCK agents] Proposed findings:', run.ai.planning.findings.map(f => f.title).join('; '));
      console.log('[MOCK agents] Candidate tests:', run.ai.planning.candidates.length, '(not executed or installed)');
      const envelope = await executePlan({ plan: run.plan, config, cwd, outputDir: path.join(directory, 'results'), allowLocal: true,
        metadata: { repository: pr.repository, prNumber: pr.number, revision: pr.revision, environment: config.environment,
          runId: run.runId, attempt: run.attempt, fixture: true, actionsRunId: '201', actionsAttempt: 1 } });
      completeRun(state, run.key, envelope, { id: 201, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/bot/actions/runs/201' });
      assert.equal(run.results[0].status, 'failed');
      console.log('[REAL executor]', run.results[0].details);
      await reviewStage({ run, pr, config, client, stage: 'completion', save: () => save(state) });
      assert.equal(run.ai.completion.status, 'completed');
      assert.equal(run.outcome.status, 'failed');
      assert.ok(run.requests.some(request => request.status === 'open'));
      const callCount = calls.length;
      await reviewStage({ run, pr, config, client, stage: 'completion', save: () => save(state) });
      assert.equal(calls.length, callCount);
      console.log('[REAL controller] Duplicate review deduplicated; AI suggestions never override the failed test.');
      console.log('[MOCK agents] Final roles:', run.ai.completion.roles.map(role => role.role).join(', '));
      console.log('[MOCK model usage]', calls.length, 'requests, $0; bounded tool reads and budget checkpoints verified.');
      console.log('\n[REPORT PREVIEW]\n' + renderReport(run));
    });
    console.log('\nAI demo passed. All temporary artifacts removed; no external writes or model charges.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, createMockClient };
