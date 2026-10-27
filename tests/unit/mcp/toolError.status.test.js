import { jest, describe, it, expect } from '@jest/globals';
jest.unstable_mockModule('../../../src/lib/logger.js',()=>({default:{debug:jest.fn(),error:jest.fn()}}));
const { withToolError, withResourceError }=await import('../../../src/mcp/utils/toolError.js');
const { AppError }=await import('../../../src/utils/AppError.js');
describe.each([403,404,409,412,500])('MCP typed error status %s',status=>{
 it('tool error uses numeric HTTP status and safe message',async()=>{const r=await withToolError(async()=>{throw new AppError('fixture-detail',status);})({});const body=JSON.parse(r.content[0].text);expect(body.status).toBe(status);expect(r.isError).toBe(true);if(status===500)expect(body.error).not.toContain('fixture-detail');});
 it('resource error has the same numeric status',async()=>{const r=await withResourceError(async()=>{throw new AppError('fixture-detail',status);})(new URL('hr://onboarding/fixture'));const body=JSON.parse(r.contents[0].text);expect(body.status).toBe(status);expect(r.isError).toBe(true);if(status===500)expect(body.error).not.toContain('fixture-detail');});
});
it('legacy numeric status errors remain compatible',async()=>{const r=await withToolError(async()=>{throw Object.assign(new Error('Forbidden'),{status:403});})({});expect(JSON.parse(r.content[0].text).status).toBe(403);});
