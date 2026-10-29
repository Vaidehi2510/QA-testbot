#!/usr/bin/env node
const path=require('node:path');
const {readJson,writeJson,outsideProduct,ownedPath}=require('../autonomy/store');
const {parallelMap}=require('../parallel');
const {runNativeAudit,validateNativeSuite}=require('./audit');
function validateFleet(value,metadata){
  if(!value || Object.keys(value).some(k=>!['schemaVersion','maxParallel','devices'].includes(k)) || value.schemaVersion!==1 || !Number.isSafeInteger(value.maxParallel) || value.maxParallel<1 || value.maxParallel>8 || !Array.isArray(value.devices) || !value.devices.length || value.devices.length>32)throw new Error('Enroll one to 32 device suites and one to eight parallel slots');
  const devices=value.devices.map(s=>validateNativeSuite(s,metadata));if(new Set(devices.map(d=>d.deviceId)).size!==devices.length)throw new Error('Fleet devices must have distinct physical device IDs');return {...value,devices};
}
async function runFleet({fleet,metadata,outputDir,env=process.env,audit=runNativeAudit}){
  const config=validateFleet(fleet,metadata),output=path.resolve(outputDir);if(!metadata.productRoot)throw new Error('Fleet QA requires the read-only productRoot for workspace separation');await outsideProduct(output,metadata.productRoot);
  const allowed=new Set((env.QA_NATIVE_DEVICE_IDS || env.QA_NATIVE_DEVICE_ID || '').split(',').filter(Boolean));
  const fs=require('node:fs/promises');await fs.mkdir(output,{recursive:true,mode:0o700});
  const results=await parallelMap(config.devices,config.maxParallel,async suite=>{
    if(env.QA_NATIVE_ENABLED!=='true'||!allowed.has(suite.deviceId))return {deviceId:suite.deviceId,status:'blocked',reason:'This disposable device is not explicitly enabled on this runner.'};
    const directory=await ownedPath(output,`devices/${suite.deviceId}`,{directory:true});
    try{const evidence=await audit({suite,metadata,outputDir:directory,env:{...env,QA_NATIVE_DEVICE_ID:suite.deviceId},leaseRoot:path.join(__dirname,'../../.qa-local/device-leases')});return {deviceId:suite.deviceId,status:evidence.result.status,revisionVerified:evidence.revisionVerified,counts:evidence.result.counts,evidence:path.relative(output,directory)};}
    catch{return {deviceId:suite.deviceId,status:'blocked',reason:'Device suite could not establish a complete assessment. Inspect the enrolled device and local evidence.'};}
  });
  const report={schemaVersion:1,repository:metadata.repository,revision:metadata.revision,...require('../assessment').identity(metadata),maxParallel:config.maxParallel,results,status:results.every(r=>r.status==='passed'&&r.revisionVerified)?'passed':'blocked',completedAt:new Date().toISOString(),limitations:['Device infrastructure must be provisioned separately. Local leases coordinate workers sharing the bot workspace; they are not distributed locks across unrelated hosts.','A crashed or uncertain native session quarantines its device. Reset the disposable device before clearing its lease.']};await writeJson(output,'fleet-result.json',report);return report;
}
async function main(args=process.argv.slice(2)){
  const o={};for(let i=0;i<args.length;i+=2){if(!['--fleet','--metadata','--output'].includes(args[i])||!args[i+1]||o[args[i]])throw new Error('Use --fleet trusted-fleet.json --metadata metadata.json --output bot-output');o[args[i]]=path.resolve(args[i+1]);}
  if(Object.keys(o).length!==3)throw new Error('Fleet, metadata and output are required');const metadata=await readJson(o['--metadata']);if(!metadata.productRoot)throw new Error('Set metadata.productRoot');await outsideProduct(o['--fleet'],metadata.productRoot);await outsideProduct(o['--metadata'],metadata.productRoot);const r=await runFleet({fleet:await readJson(o['--fleet']),metadata,outputDir:o['--output']});console.log(JSON.stringify({status:r.status,devices:r.results.length,report:path.join(o['--output'],'fleet-result.json')}));if(r.status!=='passed')process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(require('../ai/context').redact(e.message));process.exitCode=1;});
module.exports={runFleet,validateFleet,main};
