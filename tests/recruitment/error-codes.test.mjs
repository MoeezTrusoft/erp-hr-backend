import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeError,buildErrorEnvelope } from '../../src/middlewares/error.middleware.js';
import { toJsonRpcError } from '../../src/mcp/utils/mcpErrorMap.js';
test('REST and MCP expose the same numeric recruitment family and original reason',()=>{
 for(const [reason,code] of [
  ['HR-RECRUITMENT-HIRING-FREEZE','HR-5100'],['HR-RECRUITMENT-APPLICATIONS-CLOSED','HR-5200'],
  ['HR-RECRUITMENT-SCREENING-ADVANCE-REQUIRED','HR-5300'],['HR-RECRUITMENT-SCORECARD-LOCKED','HR-5400'],
  ['HR-RECRUITMENT-OFFER-NOT-SENT','HR-5500'],['HR-RECRUITMENT-INVITATION-TRANSITION-INVALID','HR-5600'],
  ['HR-RECRUITMENT-LEGAL-HOLD-BLOCKS-ANONYMIZATION','HR-5700'],['HR-PORTAL-NOT-FOUND','HR-5800'],
 ]){
  const err=Object.assign(new Error('Action blocked'),{code:reason,status:409});
  assert.deepEqual(buildErrorEnvelope(normalizeError(err)).error,{code,reason,message:'Action blocked'});
  assert.equal(toJsonRpcError(err).data.reason,reason);
  assert.equal(toJsonRpcError(err).code,-32001);
 }
 assert.equal(toJsonRpcError(Object.assign(new Error('No grant'),{code:'HR-6002',status:403})).code,-32003);
 const internal=normalizeError(Object.assign(new Error('Secret connection string'),{code:'HR-AI-PLANE-UNAVAILABLE',status:503}));
 assert.equal(internal.code,'HR-5900');
 assert.equal(internal.message.includes('Secret'),false);
});
