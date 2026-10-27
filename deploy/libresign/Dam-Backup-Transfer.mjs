/** Run inside the HR pod; signing credentials never leave the pod. */
import fs from 'node:fs/promises';
import {completeUploadWithRecovery} from './Dam-Upload-Recovery.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {signServiceJwtEdDSA} from '/app/src/lib/serviceJwt.js';
const companies=new Set(['40314ef4-0a81-4390-b631-b3ad3f21f523','14d8c7b1-194d-4e35-b058-b9cb9aa9fba2','61b7eb53-ab6e-413f-9d9a-1ecf4e071e73','8ff0533b-62f6-4be9-a78e-69adf49e00bc','8f4a526f-d45b-4da2-b772-d6682e849812']);
const [action,requestPath]=process.argv.slice(2);const req=JSON.parse(await fs.readFile(requestPath,'utf8'));
if(!companies.has(req.companyId)||!/^hr-signing-(backup|recovery-key):[a-zA-Z0-9:-]+$/.test(req.parentId))throw new Error('Invalid recovery scope');
const base=new URL(process.env.DAM_SERVICE_URL).origin;
const trustedR2='c0d732db6a999137ce6774dc169d7d08.r2.cloudflarestorage.com';
async function objectFetch(url,options){
 for(let attempt=0;attempt<5;attempt++){
  try {const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(120000)});if(r.status<500&&r.status!==429)return r;await r.body?.cancel();}
  catch(error){if(attempt===4)throw new Error('Trusted object store is temporarily unreachable',{cause:error});}
  await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
 }
 throw new Error('Trusted object store request failed');
}
const hash=x=>createHash('sha256').update(x).digest('hex');
const headers=(extra={})=>{
 const token=signServiceJwtEdDSA({tid:req.companyId,tenantId:req.companyId,parentType:'OTHER',parentId:req.parentId,purpose:'LIBRESIGN_DISASTER_RECOVERY',capabilityVerified:true,capabilityId:randomUUID(),capabilityExpiresAt:new Date(Date.now()+60000).toISOString(),operations:['VIEW_METADATA','VIEW_CONTENT','DOWNLOAD']});
 if(!token)throw new Error('HR service signer unavailable');return {'X-Service-Authorization':'Bearer '+token,'Content-Type':'application/json',...extra};
};
async function api(path,options={}){
 const r=await fetch(base+path,{...options,headers:headers(options.headers),redirect:'error',signal:AbortSignal.timeout(60000)});const body=await r.json();
 if(!r.ok)throw new Error('DAM request failed '+r.status+' '+(body.code||body.error?.code||''));return body;
}
function objectUrl(raw){const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||!(url.hostname===trustedR2||url.hostname.endsWith('.'+trustedR2)))throw new Error('Untrusted object URL');return url;}
function localPath(p){if(!p?.startsWith('/tmp/recruitment-dam-backup/')||p.includes('..'))throw new Error('Invalid local backup path');return p;}
async function metadata(id){for(let i=0;i<90;i++){const data=(await api('/api/assets/'+id)).data;if(data.accessStrategy!=='INHERITED'||data.parentType!=='OTHER'||data.parentId!==req.parentId||data.managedBy!=='erp-hr-backend'||data.tenantId!==req.companyId)throw new Error('Recovery asset policy mismatch');if(data.assetScan?.status==='CLEAN')return data;if(data.assetScan?.status!=='PENDING_SCAN')throw new Error('Recovery scan failed');await new Promise(r=>setTimeout(r,2000));}throw new Error('Recovery scan pending');}
async function download(id,expectedHash){const data=await metadata(id);const r=await objectFetch(objectUrl(data.url),{method:'GET'});if(!r.ok)throw new Error('Object retrieval failed '+r.status);const body=Buffer.from(await r.arrayBuffer());if(hash(body)!==expectedHash)throw new Error('Recovery checksum mismatch');return body;}
if(action==='upload'){
 const content=await fs.readFile(localPath(req.input));if(!content.length||content.length>80*1024*1024||hash(content)!==req.sha256)throw new Error('Invalid backup part');
 const filename=req.filename;if(!/^[a-zA-Z0-9_.-]+$/.test(filename))throw new Error('Invalid filename');
 let init,completing=false;
 const resume=req.completion;
 if(resume && (resume.companyId!==req.companyId || resume.parentId!==req.parentId || resume.sha256!==req.sha256 || resume.filename!==filename))throw new Error('Upload checkpoint scope mismatch');
 const etags=resume?.etags ?? [];
 try{
  if(!resume){
   init=(await api('/v1/uploads',{method:'POST',body:JSON.stringify({filename,size:content.length,mime:'application/octet-stream',sha256:req.sha256,accessStrategy:'INHERITED'})})).data;
   for(const part of init.parts){const start=(part.partNumber-1)*init.partSize;const r=await objectFetch(objectUrl(part.url),{method:'PUT',body:content.subarray(start,Math.min(start+init.partSize,content.length))});if(!r.ok||!r.headers.get('etag'))throw new Error('Object upload failed '+r.status);etags.push({partNumber:part.partNumber,etag:r.headers.get('etag')});}
  }
  const sessionId=resume?.sessionId ?? init.sessionId;
  const checkpoint={companyId:req.companyId,parentId:req.parentId,sha256:req.sha256,filename,sessionId,etags};
  await fs.writeFile('/tmp/recruitment-dam-backup/completing.json',JSON.stringify(checkpoint),{mode:0o600});
  completing=true;
  const done=await completeUploadWithRecovery({api,sessionId,etags,resume:Boolean(resume)});
  const assetId=done.asset.id;
  const receipt={companyId:req.companyId,parentId:req.parentId,assetId,filename,sha256:req.sha256,size:content.length};
  await fs.writeFile('/tmp/recruitment-dam-backup/uploaded.json',JSON.stringify(receipt),{mode:0o600});
  await download(assetId,req.sha256);
  await fs.rm('/tmp/recruitment-dam-backup/completing.json',{force:true});
  console.log(JSON.stringify({...receipt,scan:'CLEAN',retrievedAndVerified:true}));
 }catch(error){if(!completing && init?.sessionId)await api('/v1/uploads/'+init.sessionId,{method:'DELETE'}).catch(()=>{});throw error;}
}else if(action==='verify'){
 await download(req.assetId,req.sha256);console.log(JSON.stringify({...req,scan:'CLEAN',retrievedAndVerified:true}));
}else if(action==='retrieve'){
 const bytes=await download(req.assetId,req.sha256);await fs.writeFile(localPath(req.output),bytes,{mode:0o600,flag:'wx'});console.log(JSON.stringify({assetId:req.assetId,size:bytes.length,sha256:req.sha256,retrievedAndVerified:true}));
}else throw new Error('Unknown recovery operation');
