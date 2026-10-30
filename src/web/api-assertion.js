function validateApiAssertion(step){
  if(typeof step.path!=='string'||step.path.length>300||!step.path.startsWith('/')||step.path.startsWith('//')||/[\\\x00-\x20#]/.test(step.path)||decodeURIComponent(step.path).split(/[/?]/).includes('..')||!Number.isInteger(step.status)||step.status<100||step.status>599)throw Error('API assertion requires an explicit same-origin path and expected status');
  if(['selector','role','name','text','count','exact','value'].some(k=>step[k]!==undefined))throw Error('API assertions cannot contain element actions or input values');
  if((step.jsonPointer!==undefined)!==Object.hasOwn(step,'expectedValue'))throw Error('API data assertions need both a JSON pointer and expected scalar value');
  if(step.jsonPointer!==undefined&&(typeof step.jsonPointer!=='string'||step.jsonPointer.length>300||!/^\/(?:[^~]|~[01])*$|^$/.test(step.jsonPointer)||!(step.expectedValue===null||typeof step.expectedValue==='boolean'||typeof step.expectedValue==='string'&&step.expectedValue.length<=500||typeof step.expectedValue==='number'&&Number.isFinite(step.expectedValue))))throw Error('Use a bounded JSON pointer and a scalar expected value');
  return step;
}
async function assertApiResponse({step,suite,metadata,context,fetchImpl=fetch}){
  validateApiAssertion(step);const url=new URL(step.path,suite.url);if(url.origin!==suite.origin)throw Error('API assertion left the approved preview origin');
  const cookies=await context.cookies(url.href),cookie=cookies.map(c=>c.name+'='+c.value).join('; ');
  const response=await fetchImpl(url.href,{method:'GET',headers:{accept:'application/json',...(cookie?{cookie}:{})},redirect:'error',signal:AbortSignal.timeout(suite.timeoutMs)});
  if(response.status!==step.status){await response.body?.cancel();throw Error('API status did not match the approved expected status');}
  if(response.headers.get(suite.revisionHeader)?.trim()!==metadata.revision||metadata.target&&response.headers.get('x-qa-artifact-sha256')?.trim()!==metadata.target.artifactSha256){await response.body?.cancel();throw Error('API deployment identity is missing or does not match this assessment');}
  if(step.jsonPointer===undefined){await response.body?.cancel();return;}
  const reader=response.body?.getReader();if(!reader)throw Error('API JSON evidence is missing');const chunks=[];let n=0;try{for(;;){const p=await reader.read();if(p.done)break;n+=p.value.length;if(n>64000){await reader.cancel();throw Error('API JSON evidence exceeds 64KB');}chunks.push(Buffer.from(p.value));}}finally{reader.releaseLock();}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('API evidence is not valid JSON');}
  for(const segment of step.jsonPointer===''?[]:step.jsonPointer.slice(1).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~'))){if(!value||typeof value!=='object'||!Object.hasOwn(value,segment))throw Error('The expected resulting data field is missing');value=value[segment];}
  if(value!==step.expectedValue)throw Error('The resulting API data did not match the approved expected value');
}
module.exports={validateApiAssertion,assertApiResponse};
