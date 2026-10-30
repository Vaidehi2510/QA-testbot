const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {exportPortalEvidence}=require('../src/autonomy/portal-evidence');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
test('visual export binds candidate bytes to the actual report revision and check, rejecting corrupt candidates',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'qa-visual-export-')));
 try{
  const regression=path.join(root,'regression'),runRoot=path.join(regression,'run'),output=path.join(root,'output'),checkId='web-primary',browser=path.join(runRoot,'browser',hash(Buffer.from(JSON.stringify(checkId))));
  await fs.mkdir(path.join(browser,'visual'),{recursive:true});await fs.mkdir(output);await fs.writeFile(path.join(runRoot,'report.json'),'{}');
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6r9sAAAAASUVORK5CYII=','base64'),identity={repository:'fixture/product',checkId,browser:'chromium',width:390,height:844},key=hash(Buffer.from(JSON.stringify(identity))),sha256=hash(bytes),revision='a'.repeat(40),metadata={schemaVersion:1,key,identity,sha256,revision,revisionVerified:true,repository:identity.repository,image:key+'.png',previousDigest:null};
  await fs.writeFile(path.join(browser,'visual',metadata.image),bytes);await fs.writeFile(path.join(browser,'visual','good.json'),JSON.stringify(metadata));await fs.writeFile(path.join(browser,'visual','wrong.json'),JSON.stringify({...metadata,revision:'b'.repeat(40)}));
  const report={recordId:'d'.repeat(64),revision,repository:identity.repository,checks:[{id:checkId,name:'Web',status:'blocked'}]},run={report:{path:path.join(runRoot,'report.json')},autonomy:{browser:{[checkId]:{revisionVerified:true,visualResults:[{candidatePath:'visual/good.json'},{candidatePath:'visual/wrong.json'}]}}}};
  const result=await exportPortalEvidence({run,report,output,regressionDir:regression});assert.equal(result.visualCandidates.length,1);const exported=result.visualCandidates[0];assert.equal(exported.metadata.revision,revision);assert.equal(hash(await fs.readFile(path.join(output,exported.path))),sha256);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
