const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runRelease, gateDecision } = require('../src/release/run');
const { parseJUnit } = require('../src/release/junit');
const { inspectArtifact, importedJUnit, digest } = require('../src/release/artifact');
const { executeBaseline } = require('../src/autonomy/baseline');
const { validateTarget } = require('../src/assessment');
const { validateUnitTests, stageUnitTests } = require('../src/release/unit-tests');
const { validatePortalPolicy, validateJob } = require('../src/autonomy/portal');
const { executePlan } = require('../src/executor');
const quiet = () => {};
const xml = '<testsuites tests="2" failures="0" errors="0" skipped="0"><testsuite name="windows-smoke" tests="2"><testcase classname="app" name="launch"/><testcase classname="app" name="save"/></testsuite></testsuites>';
const git = (repo, ...args) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-C',repo,...args], { encoding:'utf8', env:{ ...process.env, GIT_CONFIG_NOSYSTEM:'1' } }).trim();
async function fixture(t, platform = 'windows') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'qa-release-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'product'); await fs.mkdir(repo); git(repo,'init','-q','-b','main');
  await fs.writeFile(path.join(repo,'shipping.cjs'),'exports.fee = total => total >= 100 ? 0 : 8;\n');
  git(repo,'add','.'); git(repo,'-c','user.name=QA Fixture','-c','user.email=qa@example.test','commit','-qm','Synthetic product');
  const revision=git(repo,'rev-parse','HEAD'), artifactPath=path.join(root,'product-build.zip'); await fs.writeFile(artifactPath,'synthetic immutable build bytes');
  const artifactSha256=digest(await fs.readFile(artifactPath));
  const target={kind:'release',name:'v1.0.0',platform,artifactSha256};
  const manifest={schemaVersion:1,repository:'fixture/product',revision,artifactPath,artifactSha256,platform,buildId:'build-42',version:'v1.0.0'};
  const manifestPath=path.join(root,`${artifactSha256}.json`); await fs.writeFile(manifestPath,JSON.stringify(manifest));
  const reportPath=path.join(root,'ci-results.xml'), attestationPath=path.join(root,'ci-results.json'); await fs.writeFile(reportPath,xml);
  const attestation={schemaVersion:1,repository:'fixture/product',revision,artifactSha256,platform,runnerId:'platform-smoke',reportSha256:digest(xml)}; await fs.writeFile(attestationPath,JSON.stringify(attestation));
  const config={ai:{enabled:false},runners:[{id:'platform-smoke',type:'junit-report',baseline:true,platforms:[platform],reportPath,attestationPath}]};
  const configPath=path.join(root,'config.json'); await fs.writeFile(configPath,JSON.stringify(config));
  const options={repo,repository:'fixture/product',base:revision,head:revision,target,manifest:manifestPath,config:configPath,'output-dir':path.join(root,'bot-releases')};
  return {root,repo,revision,target,manifest,manifestPath,artifactPath,reportPath,attestationPath,attestation,config,configPath,options};
}

test('JUnit import derives positive outcomes and rejects contradictory, empty, duplicate, hostile and incomplete XML', () => {
  assert.deepEqual(parseJUnit(xml),{valid:true,tests:2,passed:2,failed:0,skipped:0,cancelled:0});
  const mixed='<testsuite tests="4" failures="1" errors="1" skipped="1"><testcase name="pass"/><testcase name="fail"><failure>assertion</failure></testcase><testcase name="error"><error>setup</error></testcase><testcase name="skip"><skipped/></testcase></testsuite>';
  assert.deepEqual(parseJUnit(mixed),{valid:true,tests:4,passed:1,failed:2,skipped:1,cancelled:0});
  for(const value of ['', '<testsuite tests="0"/>', xml.replace('tests="2"','tests="9"'), xml.replace('name="save"','name="launch"'), '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite/>', xml.slice(0,-4), '<testsuite><testcase name="a"><failure/><skipped/></testcase></testsuite>', '<testsuite><testcase name="a" status="unknown"/></testsuite>', '<testsuite>'.repeat(30)+'<testcase name="a"/>'+'</testsuite>'.repeat(30)]) assert.equal(parseJUnit(value).valid,false,value.slice(0,80));
});

test('artifact manifests bind exact source, bytes, platform and build/version names without product writes', async t => {
  const f=await fixture(t); const identity=await inspectArtifact({...f.options,manifestPath:f.manifestPath,revision:f.revision}); assert.equal(identity.artifactSha256,f.target.artifactSha256);
  await assert.rejects(inspectArtifact({...f.options,manifestPath:f.manifestPath,revision:'b'.repeat(40)}),/manifest/);
  await assert.rejects(inspectArtifact({...f.options,manifestPath:f.manifestPath,revision:f.revision,target:{...f.target,name:'v2'}}),/manifest/);
  await assert.rejects(inspectArtifact({...f.options,manifestPath:f.manifestPath,revision:f.revision,target:{...f.target,platform:'linux'}}),/manifest/);
  await fs.writeFile(f.artifactPath,'changed build bytes'); await assert.rejects(inspectArtifact({...f.options,manifestPath:f.manifestPath,revision:f.revision}),/bytes/);
  await fs.rm(f.artifactPath); await fs.symlink(path.join(f.repo,'shipping.cjs'),f.artifactPath); await assert.rejects(inspectArtifact({...f.options,manifestPath:f.manifestPath,revision:f.revision}));
  assert.equal(git(f.repo,'status','--porcelain'),'');
});

test('real attested CI imports support a complete release without any PR and never reuse evidence for a different artifact', async t => {
  const f=await fixture(t); let executions=0;
  const baselineRunner=async input=>{ executions++; assert.equal(input.prNumber,undefined); assert.deepEqual(input.target,f.target); return executeBaseline(input); };
  const run=await runRelease({options:f.options,baselineRunner,log:quiet});
  assert.equal(run.pr,undefined); assert.deepEqual(run.target,f.target); assert.equal(run.release.gate.eligible,true,JSON.stringify(run.results));
  assert.match(run.results.find(r=>r.checkId==='runner-platform-smoke').details,/Imported CI JUnit/);
  assert.equal((await runRelease({options:f.options,baselineRunner,log:quiet})).key,run.key); assert.equal(executions,1);
  assert.equal(gateDecision(run,{repository:f.options.repository,revision:f.revision,target:{...f.target,artifactSha256:'e'.repeat(64)}}).eligible,false);
  assert.equal(gateDecision(run,{repository:f.options.repository,revision:f.revision,target:f.target,nowMs:Date.parse(run.completedAt)+3600001}).eligible,false);
  assert.equal(gateDecision({...run,outcome:{status:'passed'},results:[]},{repository:f.options.repository,revision:f.revision,target:f.target}).eligible,false);
  const cliArgs=['src/release/cli.js','gate','--repo',f.repo,'--repository',f.options.repository,'--report',run.report.path,'--manifest',f.manifestPath,'--revision',f.revision,'--kind','release','--name',f.target.name,'--platform',f.target.platform,'--artifact-sha256',f.target.artifactSha256,'--config',f.configPath];
  assert.equal(JSON.parse(execFileSync(process.execPath,cliArgs,{encoding:'utf8'})).eligible,true);
  await fs.writeFile(f.reportPath,xml+'\n');
  assert.throws(()=>execFileSync(process.execPath,cliArgs,{encoding:'utf8',stdio:['ignore','pipe','pipe']}),e=>e.status===1);
  assert.equal(git(f.repo,'status','--porcelain'),'');
});

test('platform labels, skipped tests and generic unit evidence alone cannot approve a product release', async t => {
  const f=await fixture(t); f.config.runners[0].platforms=['linux']; await fs.writeFile(f.configPath,JSON.stringify(f.config));
  const run=await runRelease({options:f.options,log:quiet}); assert.equal(run.release.gate.eligible,false); assert.equal(run.results.find(r=>r.checkId==='release-platform').status,'blocked');
  const generic=await runRelease({options:{...f.options,'rerun-token':'generic'},baselineRunner:async()=>({results:[{checkId:'runner-platform-smoke',status:'passed',revision:f.revision,counts:{tests:0,passed:0,failed:0,skipped:0,cancelled:0}}]}),log:quiet});
  assert.equal(generic.release.gate.eligible,false);
  const stale=await fs.readFile(f.reportPath,'utf8'); await fs.writeFile(f.reportPath,stale.replace('<testcase classname="app" name="save"/>','<testcase classname="app" name="save"><skipped/></testcase>'));
  await assert.rejects(importedJUnit({runner:f.config.runners[0],metadata:{repository:f.options.repository,revision:f.revision,target:f.target},productRoot:f.repo}),/attestation/);
});

test('website bridge executes a full-version assessment without a PR and binds retries to imported CI evidence', async t => {
  const f = await fixture(t);
  const { DEFAULT_AI_CONFIG } = require('../src/ai/settings');
  const { runPortal } = require('../src/autonomy/portal');
  f.config.ai = { ...DEFAULT_AI_CONFIG, enabled: true, model: 'vendor/fixture', roles: ['planner'] };
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const input = { schemaVersion: 1, id: crypto.randomUUID(), repository: f.options.repository, revision: f.revision, target: f.target, base: 'main', settings: { backend: 'openrouter', model: 'vendor/fixture', roleModels: {}, roles: ['planner'], maxCostUsd: 1, maxCallsPerRun: 4, allowImages: false }, testingProfile: { previewUrlTemplate: '', pages: ['/'], browsers: [], maxPages: 1, discoverPages: false, goals: { schemaVersion: 1, goals: [] } } };
  const policy = { schemaVersion: 1, repository: f.options.repository, repoCheckout: f.repo, base: 'main', configPath: f.configPath, regressionDir: path.join(f.root, 'regressions'), allowedPlatforms: ['windows'], releaseManifestDir: f.root, executeBaseline: true, allowedPreviewOrigins: [], allowedBrowsers: [], allowedBackends: ['openrouter'], maxPages: 1, maxGoals: 8, maxAssertions: 30, maxCostUsd: 1, maxCallsPerRun: 4, allowImages: false, timeoutMs: 300000 };
  let executions = 0;
  const options = { job: input, policy, policyPath: path.join(f.root, 'policy.json'), outputDir: path.join(f.root, 'portal-output'), runAutonomous: async ({ options }) => { executions++; assert.equal(options.pr, undefined); return runRelease({ options, client: {}, team: async () => ({ status: 'completed', findings: [], questions: [], roles: ['planner'], budget: { calls: 0 }, cost: 0 }), log: quiet }); } };
  const report = await runPortal(options);
  assert.deepEqual(report.target, f.target); assert.equal(report.pr, undefined);
  assert.ok(report.checks.length >= 6); assert.ok(report.checks.every(c => c.status === 'passed'), JSON.stringify(report.checks));
  await fs.writeFile(f.reportPath, xml + '\n');
  await assert.rejects(runPortal(options), /reserved budget/); assert.equal(executions, 1);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('artifact changes during testing and interrupted baseline attempts remain blocked', async t => {
  const f=await fixture(t); let calls=0;
  const run=await runRelease({options:f.options,baselineRunner:async input=>{ calls++; const result=await executeBaseline(input); await fs.writeFile(f.artifactPath,'concurrent rebuild'); return result; },log:quiet});
  assert.equal(calls,1); assert.equal(run.release.gate.eligible,false); assert.equal(run.results.find(r=>r.checkId==='release-artifact-stability').status,'blocked');
  let paid=0; const invalid=await runRelease({options:{...f.options,'rerun-token':'wrong-artifact'},baselineRunner:async()=>{paid++;throw new Error('must not execute');},log:quiet}); assert.equal(paid,0); assert.equal(invalid.release.gate.eligible,false);
});

test('JUnit evidence cannot cross a source revision, artifact, platform, suite or product boundary', async t=>{
  const f=await fixture(t), metadata={repository:f.options.repository,revision:f.revision,target:f.target};
  for(const change of [{revision:'d'.repeat(40)},{repository:'other/product'},{artifactSha256:'a'.repeat(64)},{platform:'linux'},{runnerId:'other'},{reportSha256:'f'.repeat(64)}]) {await fs.writeFile(f.attestationPath,JSON.stringify({...f.attestation,...change}));await assert.rejects(importedJUnit({runner:f.config.runners[0],metadata,productRoot:f.repo}),/attestation/);}
});

test('authored tests require local enrollment, hashes and separate stable staging across retries', async t=>{
  const f=await fixture(t); const source="const test=require('node:test'); test('one',()=>{});";
  const tests=[{id:crypto.randomUUID(),name:'One',source,sha256:digest(source)}]; const directory=path.join(f.root,'job'); await fs.mkdir(directory);
  assert.throws(()=>validateUnitTests([{...tests[0],source:source+' '}]),/SHA/);
  await assert.rejects(stageUnitTests({tests,policy:{},config:f.config,directory,repo:f.repo}),/enrollment/);
  const input={tests,policy:{allowWorkspaceTests:true,executeBaseline:true},config:f.config,directory,repo:f.repo};
  const staged=await stageUnitTests(input), retry=await stageUnitTests(input); assert.deepEqual(staged,retry); assert.equal(staged.runners.at(-1).type,'workspace-node-test');
  assert.equal(git(f.repo,'status','--porcelain'),'');
});

test('authored Node tests run in an offline read-only container with no integration secrets', {skip:!process.env.QA_WORKSPACE_TEST_IMAGE,timeout:60000}, async t=>{
  const f=await fixture(t,'api');
  const source=`const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');\ntest('boundary and isolation',()=>{ const root=process.env.QA_PRODUCT_ROOT; const app=require(path.join(root,'shipping.cjs')); assert.equal(app.fee(100),0); assert.equal(process.env.GITHUB_TOKEN,undefined); assert.equal(process.env.OPENROUTER_API_KEY,undefined); assert.throws(()=>fs.writeFileSync(path.join(root,'shipping.cjs'),'changed')); });`;
  const tests=[{id:crypto.randomUUID(),name:'Boundary',source,sha256:digest(source)}]; const directory=path.join(f.root,'authored'); await fs.mkdir(directory);
  const config=await stageUnitTests({tests,policy:{allowWorkspaceTests:true,executeBaseline:true},config:{execution:{image:process.env.QA_WORKSPACE_TEST_IMAGE},runners:[]},directory,repo:f.repo});
  const runner=config.runners[0]; const results=await executeBaseline({repo:f.repo,repository:f.options.repository,revision:f.revision,target:f.target,runId:'authored-fixture',config,checks:[{id:'authored',method:'automated',runner:runner.id,required:true}],outputDir:path.join(f.root,'evidence')});
  assert.equal(results.results[0].status,'passed',JSON.stringify(results)); assert.equal(results.results[0].counts.tests,1); assert.equal(git(f.repo,'status','--porcelain'),'');
  await fs.writeFile(path.join(f.repo,'shipping.cjs'),'exports.fee = total => total > 100 ? 0 : 8;\n'); git(f.repo,'add','.'); git(f.repo,'-c','user.name=QA Fixture','-c','user.email=qa@example.test','commit','-qm','Synthetic boundary defect');
  const failed=await executeBaseline({repo:f.repo,repository:f.options.repository,revision:git(f.repo,'rev-parse','HEAD'),target:f.target,runId:'broken-fixture',config,checks:[{id:'authored',method:'automated',runner:runner.id,required:true}],outputDir:path.join(f.root,'broken-evidence')});
  assert.equal(failed.results[0].status,'failed'); assert.equal(failed.results[0].counts.failed,1); assert.equal(git(f.repo,'status','--porcelain'),'');
});

test('real three-browser release QA rejects a different built artifact even at the same source revision', {skip:process.env.QA_AUTONOMY_BROWSER_TEST!=='1',timeout:180000}, async t=>{
  const http=require('node:http'); const { localProfileModel }=require('../src/ai/settings');
  const f=await fixture(t,'web'); let servedArtifact='d'.repeat(64); let calls=0;
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html','x-qa-revision':f.revision,'x-qa-artifact-sha256':servedArtifact});res.end('<!doctype html><html lang="en"><head><title>Release fixture</title></head><body><main><h1>Release fixture</h1><p role="status" id="status">Ready for release</p></main></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`, suite=path.join(f.root,'suite.json'), goals=path.join(f.root,'goals.json');
  await fs.writeFile(suite,JSON.stringify({targetEnvironment:'preview',url,pages:['/'],browsers:['chromium','firefox','webkit'],viewports:[{name:'desktop',width:900,height:700}]}));
  await fs.writeFile(goals,JSON.stringify({schemaVersion:1,goals:[{id:'home',name:'Release welcome',start:'/',requirement:'The release welcome state is visible.',inputs:{},assertions:[{id:'welcome',action:'expectText',selector:'#status',text:'Ready for release'}]}]}));
  const profile={id:'fixture:release',contextLength:100000,tools:true,vision:false};
  f.config.ai={enabled:true,backend:'local',local:{baseUrl:'http://127.0.0.1:11434/v1',models:[profile]},model:profile.id,roles:['planner'],maxToolRounds:0,maxCallsPerRun:4,maxCostUsd:0,maxOutputTokens:1000}; await fs.writeFile(f.configPath,JSON.stringify(f.config));
  const client={listModels:async()=>[{...localProfileModel(profile),pricing:{prompt:0,completion:0,request:0}}],chat:async()=>{calls++;return{model:profile.id,cost:0,usage:{},finishReason:'stop',message:{role:'assistant',content:JSON.stringify({candidates:[{goalId:'home',steps:[{action:'assert',assertionId:'welcome'}]}],limitations:[]})}};}};
  const options={...f.options,suite,goals};
  const wrong=await runRelease({options,client,log:quiet}); assert.equal(wrong.release.gate.eligible,false); assert.equal(calls,0,'Unverified build must not trigger inference');
  servedArtifact=f.target.artifactSha256;
  const passing=await runRelease({options:{...options,'rerun-token':'verified-build'},client,log:quiet});
  assert.equal(passing.release.gate.eligible,true,JSON.stringify(passing.results)); assert.equal(passing.pr,undefined); assert.equal(calls,1);
  const gate=['src/release/cli.js','gate','--repo',f.repo,'--repository',f.options.repository,'--report',passing.report.path,'--manifest',f.manifestPath,'--revision',f.revision,'--kind','release','--name',f.target.name,'--platform','web','--artifact-sha256',f.target.artifactSha256,'--config',f.configPath,'--suite',suite,'--goals',goals];
  assert.equal(JSON.parse(execFileSync(process.execPath,gate,{encoding:'utf8'})).eligible,true);
  const changed=JSON.parse(await fs.readFile(goals,'utf8')); changed.goals[0].assertions[0].text='A different requirement'; await fs.writeFile(goals,JSON.stringify(changed));
  assert.throws(()=>execFileSync(process.execPath,gate,{encoding:'utf8',stdio:['ignore','pipe','pipe']}),e=>e.status===1);
  assert.equal(git(f.repo,'status','--porcelain'),'');
});
