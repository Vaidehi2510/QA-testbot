const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {parallelMap}=require('../src/parallel');
const {deviceLease}=require('../src/native/lease');
const {assessmentMessage,SlackAdapter}=require('../src/slack');
const {startRecording,compileRecording}=require('../src/web/record');
const {executePlan}=require('../src/executor');
test('bounded parallel workers overlap independent work while preserving input order and explicit limits',async()=>{
 let active=0,max=0;const result=await parallelMap([3,1,2,4],2,async n=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,n*10));active--;return n*2;});assert.deepEqual(result,[6,2,4,8]);assert.equal(max,2);await assert.rejects(parallelMap([1],9,()=>{}),/one to eight/);
});
test('parallel executor runs real independent test processes and keeps ordered complete evidence',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-parallel-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const cwd=path.join(root,'product');await fs.mkdir(cwd);
 for(const name of ['one','two'])await fs.writeFile(path.join(cwd,`${name}.test.cjs`),`require('node:test')('${name}',async()=>{console.log('START:'+Date.now());await new Promise(r=>setTimeout(r,800));console.log('END:'+Date.now());});`);
 const run=await executePlan({cwd,outputDir:path.join(root,'results'),allowLocal:true,isolation:'process',metadata:{repository:'fixture/product',revision:'a'.repeat(40),prNumber:1,attempt:1,runId:'parallel-fixture',fixture:true},plan:{checks:['one','two'].map(id=>({id,runner:id,method:'automated',required:true}))},config:{execution:{maxParallel:2},runners:['one','two'].map(id=>({id,type:'node-test',files:[`${id}.test.cjs`]}))}});
 assert.deepEqual(run.results.map(r=>r.checkId),['one','two']);assert.ok(run.results.every(r=>r.status==='passed'&&r.counts.tests===1));
 const intervals=await Promise.all(run.results.map(async r=>{const log=await fs.readFile(path.join(root,'results',r.evidence[0].path),'utf8');return {start:Number(/START:(\d+)/.exec(log)[1]),end:Number(/END:(\d+)/.exec(log)[1])};}));assert.ok(Math.max(...intervals.map(i=>i.start))<Math.min(...intervals.map(i=>i.end)),'Actual test process intervals overlap');
});
test('device leases prevent concurrent claims and retain quarantine until deliberate reset',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-device-lease-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const first=await deviceLease({root,deviceId:'android-01'});await assert.rejects(deviceLease({root,deviceId:'android-01'}),/leased or quarantined/);const other=await deviceLease({root,deviceId:'android-02'});await other.release();await first.release();await (await deviceLease({root,deviceId:'android-01'})).release();
});
test('Slack assessment updates include actual build/version identities and safely escaped people/results, with real threading payloads',async()=>{
 const message=assessmentMessage({event:'completed',repository:'org/product',revision:'a'.repeat(40),target:{kind:'release',name:'v2.0 <!channel>',platform:'windows',artifactSha256:'d'.repeat(64)},requestedBy:'QA owner',people:{releasedBy:'release-author'},result:'failed',score:50,checks:{passed:1,total:2},findings:1,model:'local:qa'});assert.match(message,/Release v2.0/);assert.match(message,/Released by: release-author/);assert.match(message,/QA result: \*failed\*/);assert.ok(!message.includes('<!channel>'));assert.match(message,/Artifact SHA-256/);
 let payload;const adapter=new SlackAdapter({botToken:'fixture',channelId:'C0123456789',dryRun:false,fetchImpl:async(_,o)=>{payload=JSON.parse(o.body);return {ok:true,json:async()=>({ok:true,ts:'2.123',channel:'C0123456789'})};}});await adapter.send(message,{key:'job:done',threadTs:'1.123'});assert.equal(payload.thread_ts,'1.123');assert.equal(payload.parse,'none');
});
test('recorded action drafts cannot invent expected results, cross products or execute arbitrary actions',()=>{
 const metadata={repository:'fixture/product',revision:'a'.repeat(40),prNumber:1},suite={targetEnvironment:'preview',url:'https://preview.example',pages:['/'],browsers:['chromium']},goal={id:'home',name:'Welcome',start:'/',requirement:'A welcome appears',inputs:{username:'synthetic'},assertions:[{id:'welcome',action:'expectText',selector:'#status',text:'Complete'}]};
 const recording={schemaVersion:1,...metadata,origin:'https://preview.example',start:'/',revisionVerified:true,actions:[{action:'fill',selector:'#username',inputId:'username'},{action:'click',selector:'#continue'}]};const result=compileRecording(recording,goal,suite,metadata);assert.equal(result.journeys[0].steps[0].value,'synthetic');assert.equal(result.journeys[0].steps.at(-1).text,'Complete');
 for(const change of [{revision:'b'.repeat(40)},{revisionVerified:false},{origin:'https://other.example'},{actions:[{action:'evaluate',selector:'#continue',code:'process.exit()'}]},{actions:[{action:'fill',selector:'#username',inputId:'password'}]}])assert.throws(()=>compileRecording({...recording,...change},goal,suite,metadata));
});
test('real isolated browser records actions without raw input values and replays against explicit assertions', {skip:process.env.QA_AUTONOMY_BROWSER_TEST!=='1',timeout:60000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-recording-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const metadata={repository:'fixture/product',revision:'a'.repeat(40),prNumber:1};let broken=false;
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html','x-qa-revision':metadata.revision});res.end(`<!doctype html><html lang="en"><head><title>QA recording</title></head><body><main><h1>Recording fixture</h1><label for="username">Synthetic name</label><input id="username" name="username"><label for="password">Password</label><input type="password" id="password"><button id="continue" onclick="document.getElementById('status').textContent='${broken?'Broken':'Complete'}'">Continue</button><p id="status">Ready</p></main></body></html>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const suite={targetEnvironment:'preview',url:`http://127.0.0.1:${server.address().port}`,pages:['/'],browsers:['chromium'],viewports:[{name:'desktop',width:900,height:700}]};const goal={id:'continue',name:'Continue journey',start:'/',requirement:'Continue must show completion.',inputs:{username:'synthetic-user'},assertions:[{id:'complete',action:'expectText',selector:'#status',text:'Complete'}]};
 const session=await startRecording({suite,metadata,goal,headless:true,maxDurationMs:30000});await session.page.locator('#username').fill('DO-NOT-SAVE-THIS-RAW-VALUE');await session.page.locator('#username').press('Tab');await session.page.locator('#password').fill('never-save-password');await session.page.locator('#continue').click();await session.page.waitForTimeout(100);const recording=await session.finish();assert.equal(recording.actions.length,2);assert.doesNotMatch(JSON.stringify(recording),/DO-NOT-SAVE|never-save-password/);
 const replay=compileRecording(recording,goal,suite,metadata),{runWebAudit}=require('../src/web/audit');let evidence=await runWebAudit({suite:replay,metadata,outputDir:path.join(root,'passing')});assert.equal(evidence.result.status,'passed',JSON.stringify(evidence.observations));broken=true;evidence=await runWebAudit({suite:replay,metadata,outputDir:path.join(root,'broken')});assert.equal(evidence.result.status,'failed',JSON.stringify(evidence.observations));
});
