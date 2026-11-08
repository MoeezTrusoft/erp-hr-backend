import {describe,it,expect} from '@jest/globals';
import {assertPermission} from '../../src/lib/assertPermission.js';
// Audit S-05: an unmapped verb used to skip the check entirely.
describe('assertPermission fails closed',()=>{
  it('rejects an action name or unknown verb even for a fully granted actor',()=>{
    const all=['hr.payroll.read','hr.payroll.create','hr.payroll.update','hr.payroll.delete','hr.payroll.export'];
    for (const verb of ['CREATE','APPROVE','EDIT','',' GET','GET ',42,{},undefined,null]) {
      expect(()=>assertPermission(all,verb,'hr:payroll')).toThrow(/Insufficient permissions/);
      try { assertPermission(all,verb,'hr:payroll'); } catch (e) { expect(e.status).toBe(403); }
    }
  });
  it('still accepts every mapped HTTP verb when granted',()=>{
    const all=['hr.payroll.read','hr.payroll.create','hr.payroll.update','hr.payroll.delete','hr.payroll.export'];
    for (const verb of ['GET','post','PUT','PATCH','DELETE','EXPORT']) expect(()=>assertPermission(all,verb,'hr:payroll')).not.toThrow();
  });
});
