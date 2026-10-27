/** Reconcile uncertain completion without creating another asset or aborting a completed upload. */
export async function completeUploadWithRecovery({api,sessionId,etags,resume=false,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
 if(typeof sessionId!=="string" || !/^[0-9a-f-]{36}$/i.test(sessionId) || !Array.isArray(etags) || !etags.length) throw new Error("Invalid upload completion checkpoint");
 const complete=()=>api('/v1/uploads/'+sessionId+'/complete',{method:'POST',body:JSON.stringify({etags})}).then(x=>x.data);
 if(!resume) {
  try {return await complete();} catch { /* The durable checkpoint owns the uncertain outcome. */ }
 }
 for(let attempt=0;attempt<5;attempt++) {
  if(attempt)await sleep(2000*(attempt+1));
  let status;try {status=(await api('/v1/uploads/'+sessionId)).data;} catch {continue;}
  if(status.status==='completed' && status.asset?.id)return status;
  if(status.status==='aborted')throw new Error('DAM upload was aborted; checkpoint retained');
  if(status.status==='uploaded') {
   // DAM has durably recorded that R2 is assembled; this replays only asset creation.
   try {return await complete();} catch {continue;}
  }
  // A pending session may still be completing at R2. Never start a second completion.
 }
 throw new Error('DAM completion remains uncertain; checkpoint retained for reconciliation');
}
