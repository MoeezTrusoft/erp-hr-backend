import {createHash,timingSafeEqual} from 'node:crypto';
export const reject=()=>{throw Object.assign(new Error('Provisioning intent authorization denied'),{status:403});};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const fingerprint=payload=>createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
export const sameDigest=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
export async function verifiedService(request,verifyServiceRequest,expectedService){
 if(typeof expectedService!=='string'||!expectedService.trim())throw new Error('Expected service identity must be configured');
 const outcome=await verifyServiceRequest(request),c=outcome?.context;
 if(!outcome?.ok||c?.service!==expectedService||!isUuid(c.tenantId))reject();
 return c;
}
export const isUuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x)&&x!=='00000000-0000-0000-0000-000000000000';
export function selector(input){
 if(!input||Object.keys(input).some(k=>!['employeeId','key','fingerprint'].includes(k)))reject();
 const employeeId=Number(input.employeeId);
 if(!Number.isSafeInteger(employeeId)||employeeId<=0||employeeId>2147483647||!isUuid(input.key)||!sameDigest(input.fingerprint,input.fingerprint))reject();
 return {employeeId,key:input.key,fingerprint:input.fingerprint};
}
