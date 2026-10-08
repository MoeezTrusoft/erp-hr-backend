import {describe,it,expect} from '@jest/globals';
import {manualAttendanceFactor,validatePayableDays,groupOfficePayroll} from '../../src/lib/monthlyPayrollAttendance.js';
import {buildPayslipFromInputs} from '../../src/services/payrollService.js';
const run={periodStart:new Date('2026-09-01T00:00:00Z'),periodEnd:new Date('2026-09-30T23:59:59.999Z'),currencyCode:'PKR',countryCode:'PK'};
const employee={id:1,attendanceInputMode:'MANUAL_MONTHLY',hire_date:new Date('2020-01-01')};
const build=(days,extra={})=>buildPayslipFromInputs({employee,employmentTerm:{baseSalary:'30000',currency:'PKR',payFrequency:'MONTHLY'},payrollRun:run,bridges:{manualAttendance:{month:'2026-09',payableDays:days},attendanceRows:[{date:run.periodStart,status:'ABSENT',day_credit:0}],lwpDays:5},ruleConfig:{absenceRecoveryEnabled:true},...extra});
describe('monthly payable days',()=>{
 it('prices 15 of 30 days once, without another absence or LWP deduction',()=>{const r=build(15);expect(Number(r.grossAmount)).toBe(15000);expect(Number(r.netAmount)).toBe(15000);});
 it('accepts zero days without reverting to full salary',()=>expect(Number(build(0).grossAmount)).toBe(0));
 it('supports half days',()=>expect(Number(build(29.5).grossAmount)).toBe(29500));
 it('fails closed if monthly input is absent',()=>expect(()=>build(30,{bridges:{}})).toThrow('missing'));
 it.each([-1,31,1.25,null,'',Infinity])('rejects invalid September days %s',v=>expect(()=>validatePayableDays('2026-09',v)).toThrow());
 it('uses leap-year month length',()=>{expect(validatePayableDays('2028-02',29)).toBe(29);expect(()=>validatePayableDays('2027-02',29)).toThrow();});
 it('rejects paid days outside employment',()=>expect(()=>manualAttendanceFactor(employee,run,{month:'2026-09',payableDays:16},500000n)).toThrow('employment days'));
 it('keeps device attendance behavior',()=>expect(manualAttendanceFactor({...employee,attendanceInputMode:'DEVICE'},run,null,500000n)).toBe(500000n));
 it('requires the input to match the payroll month',()=>expect(()=>manualAttendanceFactor(employee,run,{month:'2026-08',payableDays:30},1000000n)).toThrow('missing'));
 it('totals both offices without dropping unassigned historical payslips',()=>{
 const r=groupOfficePayroll([{payrollOffice:'HVC-PECHS-Office',grossAmount:'100',totalDeductions:'10',netAmount:'90'},{payrollOffice:'HVC-Headend-Staff',grossAmount:'200',totalDeductions:'20',netAmount:'180'},{grossAmount:'10',totalDeductions:'0',netAmount:'10'}]);
 expect(r.offices).toHaveLength(3);expect(r.totals).toEqual({employees:3,gross:310,deductions:30,net:280});
 });
});
