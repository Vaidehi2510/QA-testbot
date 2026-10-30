const test=require('node:test'),assert=require('node:assert/strict');
const {publicAddress,publicLookup,publicFetch}=require('../src/web/network');
const {createPreviewProxy}=require('../src/web/proxy');
const http=require('node:http');
test('public-only connections reject metadata, alternate IP forms, mixed DNS answers and IPv6 transition networks',async()=>{
 for(const value of ['127.0.0.1','169.254.169.254','10.1.1.1','100.100.100.200','192.168.1.1','::1','::ffff:127.0.0.1','fd00:ec2::254','2001:db8::1','2002:7f00:1::','3fff::1'])assert.equal(publicAddress(value),false,value);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 const mixed=publicLookup((host,opts,cb)=>cb(null,[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
 await assert.rejects(new Promise((resolve,reject)=>mixed('preview.example',{},(e,a)=>e?reject(e):resolve(a))),/public network/);
 let calls=0;const pin=publicLookup((host,opts,cb)=>{calls++;cb(null,[{address:'8.8.8.8',family:4}]);});
 assert.deepEqual(await new Promise((resolve,reject)=>pin('preview.example',{all:true},(e,a)=>e?reject(e):resolve(a))),[{address:'8.8.8.8',family:4}]);assert.equal(calls,1);
 for(const host of ['127.1','2130706433','0x7f000001','[::ffff:127.0.0.1]'])await assert.rejects(publicFetch('http://'+host+'/'),/public network/);
});
test('an allowed private origin is still blocked by the public-only browser proxy',async()=>{
 const proxy=await createPreviewProxy({allowedOrigins:['http://127.0.0.1'],publicNetworkOnly:true,allowMutations:false,timeoutMs:1000});
 try{const status=await new Promise((resolve,reject)=>{const req=http.request(proxy.server,{path:'http://127.0.0.1/',method:'GET'},r=>{r.resume();resolve(r.statusCode);});req.on('error',reject);req.end();});assert.equal(status,403);assert.equal(proxy.blocked,1);}finally{await proxy.close();}
});
test('exported execution summaries redact detected credentials before writing evidence bytes',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ps-redaction-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const {exportPortalEvidence}=require('../src/autonomy/portal-evidence');const token='sk-or-v1-'+'x'.repeat(40);
 const result=await exportPortalEvidence({run:{},report:{recordId:'a'.repeat(64),revision:'b'.repeat(40),checks:[{id:'fixture',name:'Fixture',status:'failed',details:'Provider error Bearer '+token}]},output:dir,regressionDir:dir});
 const bytes=await fs.readFile(path.join(dir,result.files[0].path),'utf8');assert.ok(!bytes.includes(token));assert.match(bytes,/REDACTED/);
});
