import {describe,it,expect} from '@jest/globals';
import {assertPermission} from '../../src/lib/assertPermission.js';
describe('attendance export is separately authorized',()=>{
  it('rejects a read-only or administrator-labelled actor and accepts the explicit grant',()=>{
    expect(()=>assertPermission(['hr.attendance.read'],'EXPORT','hr:attendance',false)).toThrow(/EXPORT/);
    expect(()=>assertPermission(['hr.attendance.read'],'EXPORT','hr:attendance',true)).toThrow(/EXPORT/);
    expect(()=>assertPermission(['hr.attendance.export'],'EXPORT','hr:attendance',false)).not.toThrow();
  });
});
