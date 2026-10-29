#!/usr/bin/env node
const path=require('node:path');
const crypto=require('node:crypto');
const {readJson,writeJson,outsideProduct}=require('../autonomy/store');
const {validateGoals}=require('../autonomy/schema');
const {validateWebSuite,browserLaunchOptions}=require('./audit');
const {redact}=require('../ai/context');
const selectorSafe=value=>typeof value==='string'&&value.length<=240&&/^(?:#[A-Za-z][A-Za-z0-9_-]*|\[data-testid="[A-Za-z0-9_-]+"\])$/.test(value);
function compileRecording(recording,goalInput,suiteInput,metadata){
  const goal=validateGoals({schemaVersion:1,goals:[goalInput]}).goals[0];
  const suite=validateWebSuite(suiteInput,metadata);
  if(!recording || recording.schemaVersion!==1 || recording.repository!==metadata.repository || recording.revision!==metadata.revision || !require('../assessment').sameIdentity(recording,metadata) || recording.origin!==suite.origin || recording.start!==goal.start || recording.revisionVerified!==true || !Array.isArray(recording.actions) || !recording.actions.length || recording.actions.length+goal.assertions.length>20)throw new Error('Recording must be verified, bounded and match this exact product, source, target and trusted goal');
  const steps=recording.actions.map(step=>{
    if(!step || Object.keys(step).some(k=>!['action','selector','inputId'].includes(k)) || !selectorSafe(step.selector) || redact(step.selector)!==step.selector || !['click','fill'].includes(step.action))throw new Error('Recording contains an unsupported action or locator');
    if(step.action==='fill'){if(!Object.hasOwn(goal.inputs,step.inputId))throw new Error(`Supply reviewed synthetic input: ${String(step.inputId).slice(0,80)}`);return {action:'fill',selector:step.selector,value:goal.inputs[step.inputId]};}
    if(step.inputId!==undefined)throw new Error('Click action has an unexpected input value');return {action:'click',selector:step.selector};
  });
  const result={...suiteInput,pages:[goal.start],journeys:[{name:goal.name,start:goal.start,steps:[...steps,...goal.assertions.map(({id,...a})=>a)]}]};
  validateWebSuite(result,metadata);return result;
}
/** Instrument an isolated QA browser, never the product repository or production users. */
async function startRecording({suite:input,metadata,goal:goalInput,headless=false,maxDurationMs=300000}){
  const suite=validateWebSuite(input,metadata),goal=validateGoals({schemaVersion:1,goals:[goalInput]}).goals[0];
  if(!suite.pages.includes(goal.start)||!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1000||maxDurationMs>600000)throw new Error('Choose an enrolled start page and a bounded recording duration');
  const browser=await require('playwright-core').chromium.launch({...browserLaunchOptions(process.env,'chromium'),headless});
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
  const actions=[],limitations=['Recording captures explicit actions on a disposable preview, not production-user sessions. Fill values are omitted; provide reviewed synthetic values in trusted goals.','Recorded actions are drafts. Replay them with trusted expected assertions before accepting any QA result.'];
  let verified=false,invalid=false,finished=false,timer;const page=await context.newPage();
  const record={schemaVersion:1,repository:metadata.repository,revision:metadata.revision,...require('../assessment').identity(metadata),origin:suite.origin,start:goal.start,actions,revisionVerified:false,limitations};
  try{
    await context.route('**/*',async route=>{
      const request=route.request();let url;try{url=new URL(request.url());}catch{return route.abort();}
      if(url.origin!==suite.origin || !suite.allowMutations && !['GET','HEAD','OPTIONS'].includes(request.method()))return route.abort();
      if(request.isNavigationRequest() && request.frame()===page.mainFrame()){
        verified=false;
        try{const response=await route.fetch({maxRedirects:0,timeout:15000});const h=response.headers();
          if(response.status()>=300 && response.status()<400){const location=new URL(h.location,url);if(location.origin!==suite.origin){invalid=true;return route.abort();}return route.fulfill({response});}
          if(h['x-qa-revision']!==metadata.revision || metadata.target && h['x-qa-artifact-sha256']!==metadata.target.artifactSha256){invalid=true;return route.abort();}
          verified=true;return route.fulfill({response});
        }catch{invalid=true;return route.abort();}
      }
      return route.continue();
    });
    await page.exposeBinding('__patchsentryRecord',({frame},event)=>{
      if(finished||!verified||invalid||frame!==page.mainFrame()||actions.length>=12)return;
      if(!event||!selectorSafe(event.selector)||redact(event.selector)!==event.selector){limitations.push('Some controls lack a safe stable id or data-testid and were omitted. Review the recording.');return;}
      if(event.action==='click'){if(/\b(?:delete|destroy|purchase|pay|submit)\b/i.test(event.selector)&&!suite.allowMutations){limitations.push('Potentially mutating click omitted; authorize disposable-preview mutations to record this journey.');return;}actions.push({action:'click',selector:event.selector});}
      else if(event.action==='fill' && /^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(event.inputId||'')){
        const last=actions.at(-1);if(last?.action==='fill'&&last.selector===event.selector)actions.pop();actions.push({action:'fill',selector:event.selector,inputId:event.inputId});
      }
    });
    await page.addInitScript(()=>{
      const selector=element=>{const testid=element.getAttribute('data-testid');if(testid&&/^[A-Za-z0-9_-]{1,100}$/.test(testid))return `[data-testid="${testid}"]`;if(/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(element.id))return '#'+element.id;return '';};
      document.addEventListener('click',e=>{if(!e.isTrusted)return;const el=e.target.closest('button,a,input[type=checkbox],input[type=radio],summary,[role=button]');if(el)window.__patchsentryRecord({action:'click',selector:selector(el)}).catch(()=>{});},true);
      document.addEventListener('change',e=>{const el=e.target;if(!e.isTrusted||!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || /password|hidden|file|email|tel/.test(el.type)||/password|token|secret|card|credit|auth/i.test(el.name+' '+el.id))return;window.__patchsentryRecord({action:'fill',selector:selector(el),inputId:el.getAttribute('data-qa-input')||el.name||el.id}).catch(()=>{});},true);
    });
    await page.goto(new URL(goal.start,suite.origin).href,{timeout:20000});
    if(!verified||invalid)throw new Error('Preview did not prove the exact recording source/artifact');
    let resolve;const done=new Promise(r=>resolve=r);
    const finish=async()=>{if(finished)return record;finished=true;clearTimeout(timer);record.revisionVerified=verified&&!invalid;record.completedAt=new Date().toISOString();record.limitations=[...new Set(limitations)];await browser.close();resolve(record);return record;};
    timer=setTimeout(()=>finish().catch(()=>resolve(record)),maxDurationMs);page.once('close',()=>finish().catch(()=>resolve(record)));return {page,finish,done,record};
  }catch(e){await browser.close();throw e;}
}
async function main(args=process.argv.slice(2)){
  const o={};for(let i=0;i<args.length;i+=2){if(!['--suite','--metadata','--goals','--goal','--output','--recording'].includes(args[i])||!args[i+1]||o[args[i]])throw new Error('Use --suite --metadata --goals --goal --output, optionally --recording to compile a saved draft');o[args[i]]=args[i+1];}
  for(const k of ['--suite','--metadata','--goals','--goal','--output'])if(!o[k])throw new Error(`Missing ${k}`);
  const metadata=await readJson(o['--metadata']);if(!metadata.productRoot)throw new Error('Set metadata.productRoot to keep recordings outside source');
  for(const k of ['--suite','--metadata','--goals','--output','--recording'])if(o[k])await outsideProduct(path.resolve(o[k]),metadata.productRoot);
  const suite=await readJson(o['--suite']),goal=validateGoals(await readJson(o['--goals'])).goals.find(g=>g.id===o['--goal']);if(!goal)throw new Error('Goal id not found');
  let recording;
  if(o['--recording'])recording=await readJson(o['--recording']);else{const session=await startRecording({suite,metadata,goal});console.error('Recording disposable-preview actions. Close the browser or press Ctrl+C to finish. Raw fill values are never saved.');const stop=()=>session.finish();process.once('SIGINT',stop);try{recording=await session.done;}finally{process.removeListener('SIGINT',stop);}}
  const fs=require('node:fs/promises');await fs.mkdir(o['--output'],{recursive:true,mode:0o700});await writeJson(o['--output'],'recording.json',recording);
  const compiled=compileRecording(recording,goal,suite,metadata);await writeJson(o['--output'],'recorded-suite.json',compiled);console.log(JSON.stringify({status:'draft',recordingSha256:crypto.createHash('sha256').update(JSON.stringify(recording)).digest('hex'),suite:path.join(o['--output'],'recorded-suite.json'),next:'Review the draft and execute qa:web with this suite. Recording alone never passes a QA check.'}));
}
if(require.main===module)main().catch(e=>{console.error(redact(e.message));process.exitCode=1;});
module.exports={startRecording,compileRecording,main};
