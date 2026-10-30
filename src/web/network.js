// Resolve and pin each connection once. Checking DNS and then connecting by name
// would leave a rebinding window. Private-network access is an explicit runner
// enrollment; hosted QA always uses public-only mode.
const dns = require('node:dns');
const {isIP} = require('node:net');
const http = require('node:http'), https = require('node:https');
function publicAddress(ip) {
  if(isIP(ip)===4){const p=ip.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&(p[1]===168||p[1]===0||p[1]===2)||p[0]===198&&(p[1]===18||p[1]===19||p[1]===51)||p[0]===203&&p[1]===0&&p[2]===113);}
  return isIP(ip)===6 && /^[23][0-9a-f]{3}:/i.test(ip)&&!/^200[12]:|^3fff:/i.test(ip);
}
function publicLookup(resolve=dns.lookup){
  return (host,options,callback)=>{
    resolve(host,{all:true,verbatim:true},(error,rows)=>{
      if(error)return callback(error);
      if(!rows?.length||rows.some(r=>!publicAddress(r.address)))return callback(new Error('QA destination resolved outside the public network policy'));
      const selected=rows.find(r=>!options.family||r.family===options.family);
      if(!selected)return callback(new Error('QA destination has no permitted address family'));
      callback(null,...(options.all?[[selected]]:[selected.address,selected.family]));
    });
  };
}
// Only used for bounded same-origin GET assertions; cookies are never forwarded
// to redirects. The request's Host/SNI remain the approved hostname.
async function publicFetch(value,options={}){
 const url=new URL(value),host=url.hostname.replace(/^\[|\]$/g,'');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||isIP(host)&&!publicAddress(host))throw Error('QA destination is outside the public network policy');
 return new Promise((resolve,reject)=>{
  const request=(url.protocol==='https:'?https:http).request(url,{method:options.method||'GET',headers:options.headers,signal:options.signal,lookup:publicLookup(),agent:false},response=>{
    if(response.statusCode>=300&&response.statusCode<400){response.destroy();reject(Error('API redirects are not authorized'));return;}
    const chunks=[];let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>64000){response.destroy(Error('API evidence exceeds 64KB'));return;}chunks.push(chunk);});
    response.on('error',reject);response.on('end',()=>{const headers=new Headers();for(const [name,v]of Object.entries(response.headers)){if(v!==undefined)headers.set(name,Array.isArray(v)?v.join(', '):v);}const status=response.statusCode;resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));});
  });request.on('error',reject);request.end();
 });
}
module.exports={publicAddress,publicLookup,publicFetch};
