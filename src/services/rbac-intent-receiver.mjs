import {reject,selector,sameDigest,fingerprint,verifiedService} from './intent-contract.mjs';
// loadStoredIntent must be an authenticated HR service client bound by the
// composition root, never a request-body proof or a caller-selected URL.
export function createRbacIntentReceiver({verifyServiceRequest,expectedService,loadStoredIntent,authorizeCurrentActorTx,readEmployeeTx}){
 for(const fn of [verifyServiceRequest,loadStoredIntent,authorizeCurrentActorTx,readEmployeeTx])if(typeof fn!=='function')throw Error('Missing native receiver binding');
 return async function prepare(request,payload,metadata){
  const principal=await verifiedService(request,verifyServiceRequest,expectedService);
  const input=selector({employeeId:payload?.hrEmployeeId,key:metadata?.key,fingerprint:metadata?.fingerprint});
  // Snapshot immutable JSON: mutation after prepare cannot change what is authorized.
  // Native worker appends a fresh unreachable bootstrap password per attempt.
  // Only that transport-only secret is excluded from the stored business intent.
  const submitted=structuredClone(payload);delete submitted.password;
  if(!sameDigest(fingerprint(submitted),input.fingerprint))reject();
  const proof=await loadStoredIntent(principal.tenantId,input);
  if(!proof||proof.tenantId!==principal.tenantId||proof.employeeId!==input.employeeId||proof.key!==input.key||
   !sameDigest(proof.fingerprint,input.fingerprint)||proof.email!==submitted.email||
   !Number.isSafeInteger(proof.actorUserId)||proof.actorUserId<=0||String(principal.userId)!==String(proof.actorUserId))reject();
  // Intended call site: existing native createInTransaction callback AND its
  // replay authorization path. Existing idempotency storage remains unchanged.
  return {actorUserId:proof.actorUserId,tenantId:proof.tenantId,payload:structuredClone(submitted),
   async authorizeTx(tx,{replayedUserId=null}={}){
    await authorizeCurrentActorTx(tx,{actorUserId:proof.actorUserId,tenantId:proof.tenantId,payload:structuredClone(submitted)});
    const e=await readEmployeeTx(tx,{tenantId:proof.tenantId,employeeId:proof.employeeId});
    if(!e||e.id!==proof.employeeId||e.tenant_id!==proof.tenantId||e.employement_status!=='Active'||e.separatedAt!=null||
      !Object.hasOwn(e,'userId')||(e.userId!==null&&(e.userId!==replayedUserId||!Number.isSafeInteger(replayedUserId)||replayedUserId<=0)))reject();
    // Native creation/replay must separately enforce that an existing HR user
    // link agrees with the created/replayed identity; this is not a takeover grant.
    return {employee:e,verifiedLoginEmail:proof.email,actorUserId:proof.actorUserId};
   },
  };
 };
}
