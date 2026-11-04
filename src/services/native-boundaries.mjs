import {createHrIntentReader} from './hr-intent-reader.mjs';
import {createRbacIntentReceiver} from './rbac-intent-receiver.mjs';
// HR mount: POST /api/internal/system-account-provisioning/resolve, after
// internalServiceGuard and establishTenantContext, before unknown-route denial.
export function createHrResolveHandler(native){
 const read=createHrIntentReader(native);
 return async(req,res,next)=>{try{res.set('Cache-Control','no-store');res.json({success:true,data:await read(req)});}catch(error){next(error);}};
}
export function createNativeRbacReceiver({hrRequest,...native}){
 if(typeof hrRequest!=='function')throw Error('Native HR service client is required');
 return createRbacIntentReceiver({...native,loadStoredIntent:async(tenantId,input)=>{
  const response=await hrRequest('/internal/system-account-provisioning/resolve','POST',input,{},tenantId);
  if(response?.success!==true)throw Object.assign(new Error('HR intent resolution unavailable'),{status:503});
  return response.data;
 }});
}
