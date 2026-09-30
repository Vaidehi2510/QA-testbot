// Real fixture tests; mocked external integrations. No credentials or network.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { executePlan } = require('./executor');
const { FileStore } = require('./state');
const { reconcile } = require('./run');
const { DriveAdapter } = require('./drive');
const { renderReport } = require('./report');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-bot-demo-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Demo unexpectedly attempted network access'); };
  try {
    const source = path.join(directory, 'good');
    const broken = path.join(directory, 'broken');
    await fs.cp(path.join(__dirname, '..', 'fixtures', 'tiny-app'), source, { recursive: true });
    await fs.cp(source, broken, { recursive: true });
    const file = path.join(broken, 'calculator.js');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('amount >= 100', 'amount > 100'));
    const config = { environment: 'synthetic-fixture', runners: [{ id: 'node-tests', type: 'node-test', baseline: true,
      files: ['calculator.test.js'], timeoutMs: 3000, expected: 'Orders >=100 ship free; smaller orders cost $5; invalid amounts reject.' }],
      execution: { isolation: 'process' }, decisionReviewers: ['feature-owner'], featureOwners: { General: ['feature-owner'] }, qaGroupId: 'SQADEMO' };
    const people = [{ github: 'feature-owner', slackId: 'UOWNERDEMO', verified: true }];
    const base = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'mock', 'sample-prs.json'), 'utf8'))[0];
    const store = new FileStore(path.join(directory, 'state'));
    const envelopes = new Map();
    const preview = new DriveAdapter({ dryRun: true });
    const integrations = {
      putRequest: async key => console.log(`[MOCK GitHub] durable request ${key.slice(0, 12)}`),
      dispatch: async () => ({ status: 'sent', mocked: true }),
      plan: async run => { console.log(`[MOCK GitHub] plan #${run.pr.number}: ${run.plan.checks.map(c => `${c.id} (${c.method})`).join(', ')}`); return { status: 'sent' }; },
      status: async run => { console.log(`[MOCK GitHub] revision ${run.revision.slice(0, 8)} status: ${run.outcome.status}`); return { status: 'sent' }; },
      readResults: async workflow => envelopes.get(workflow.id),
      slack: { send: async text => { console.log(`\n[MOCK Slack — no message sent]\n${text}\n`); return { status: 'sent', mocked: true }; } },
      drive: { upsertReport: async (run, options) => {
        const result = await preview.upsertReport(run, options);
        console.log(`[MOCK Drive — no upload] ${result.path}`);
        await fs.writeFile(path.join(directory, `${run.key}.md`), renderReport(run));
        return { status: 'uploaded', url: `https://drive.google.com/file/d/MOCK-${run.pr.number}/view`, mocked: true };
      } },
    };
    let actionsId = 1;
    async function sync(prs, workflows = []) {
      return store.withLock((state, save) => reconcile({ state, save, config, rules: [], people, prs, workflows, integrations }));
    }
    async function scenario(pr, cwd) {
      let state = await sync([pr]);
      const run = state.runs[state.prs[`${pr.repository}#${pr.number}`].currentRunKey];
      const id = actionsId++;
      const envelope = await executePlan({ plan: run.plan, config, cwd, outputDir: path.join(directory, `evidence-${id}`),
        metadata: { ...run.request.metadata, fixture: true, actionsRunId: String(id), actionsAttempt: 1 }, allowLocal: true });
      envelopes.set(id, envelope);
      const workflow = { id, run_attempt: 1, event: 'workflow_dispatch', path: '.github/workflows/qa-execute.yml',
        display_title: `QA execution ${run.key}`, status: 'completed', conclusion: 'success', html_url: `https://github.com/example/qa-bot/actions/runs/${id}` };
      state = await sync([pr], [workflow]);
      return state.runs[run.key];
    }
    console.log('QA bot demo: REAL isolated fixture processes; all GitHub, Slack, and Drive operations are MOCKED.\n');
    console.log('1. Successful automated run, no routine human sign-off');
    const passed = await scenario(base, source);
    assert.equal(passed.outcome.status, 'passed');
    console.log('\n2. Intentionally introduced defect: >=100 becomes >100');
    const failed = await scenario({ ...base, number: 102, title: 'Introduce a shipping-boundary defect', url: base.url.replace('101', '102'), revision: 'b'.repeat(40) }, broken);
    assert.equal(failed.outcome.status, 'failed');
    console.log(`[REAL failure evidence]\n${failed.results[0].evidence[0].excerpt.split('\n').filter(line => /not ok|expected:|actual:|error:/.test(line)).join('\n')}`);
    console.log('\n3. Targeted question while independent automated checks pass');
    const humanPr = { ...base, number: 103, title: 'Clarify the shipping requirement', url: base.url.replace('101', '103'), revision: 'c'.repeat(40),
      body: `${base.body}\nOpen question: should the $100 threshold include discounts?` };
    const human = await scenario(humanPr, source);
    assert.equal(human.outcome.status, 'awaiting_human');
    const check = human.plan.checks.find(c => c.method === 'human');
    const response = { id: 500, user: 'feature-owner', createdAt: new Date(Date.now() + 1000).toISOString(),
      body: `/qa-tested check:${check.id} revision:${human.revision} result:pass reason:The $100 threshold uses the post-discount subtotal; verified synthetic cases and accepted this requirement.` };
    console.log(`[MOCK authorized GitHub response] ${response.body}`);
    const answered = await sync([{ ...humanPr, comments: [response] }]);
    const resolved = answered.runs[human.key];
    assert.equal(resolved.outcome.status, 'passed');
    console.log('\n4. Google Drive report preview\n');
    console.log(renderReport(resolved));
    console.log('\n5. New commit with identical filenames invalidates prior QA');
    const newRevision = { ...humanPr, revision: 'd'.repeat(40) };
    const afterCommit = await sync([newRevision]);
    const current = afterCommit.runs[afterCommit.prs[`${base.repository}#103`].currentRunKey];
    assert.equal(current.outcome.status, 'blocked');
    assert.equal(current.decisions.length, 0);
    assert.ok(afterCommit.runs[human.key].decisions[0].invalidatedAt);
    console.log(`[REAL state] New revision ${current.revision}: ${current.outcome.status}; old results and invalidated decision retained in history.`);
    console.log('\nDemo checks passed. Temporary synthetic data, evidence, and state are cleaned up. No external writes occurred.');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
