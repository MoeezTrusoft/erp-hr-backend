import {describe,it,expect} from '@jest/globals';
import {calculatePayrollPaidDays,resolvePayrollPaidDays} from '../../src/lib/payrollPaidDays.js';
import {buildPayslipFromInputs} from '../../src/services/payrollService.js';
const run={periodStart:new Date('2026-09-01T00:00:00Z'),periodEnd:new Date('2026-09-30T23:59:59.999Z'),currencyCode:'PKR',countryCode:'PK'};
const calc=(deductions=[],prorationFactor=1,payrollRun=run)=>calculatePayrollPaidDays({payrollRun,prorationFactor,deductions});
describe('paid days from recorded payroll',()=>{
 it('counts calendar days including paid rest days',()=>expect(calc()).toBe(30));
 it('subtracts fractional absences, LWP and attendance penalties only',()=>expect(calc([{code:'ABSENCE_RECOVERY',description:'Absence recovery (1.5 days unexcused)'},{code:'LWP_RECOVERY',description:'LWP Recovery (2 days)'},{code:'ATTENDANCE_DEDUCTION',description:'Attendance: LATE (6 occurrences = 2 days)'},{code:'INCOME_TAX',description:'Income Tax'},{code:'LOAN_REPAYMENT',description:'Loan repayment'}])).toBe(24.5));
 it('reads the management override once',()=>expect(calc([{code:'MANAGEMENT_ATTENDANCE_DEDUCTION',description:'Attendance 2026-09-03: management override 0.5 day(s); replaces automatic attendance deductions'}])).toBe(29.5));
 it('uses pooled days, not the number of violations',()=>expect(calc([{deductionType:{code:'ATTENDANCE_DEDUCTION'},description:'Attendance deductions (2 days pooled & floored)'}])).toBe(28));
 it('preserves employment proration without losing fractional days to factor precision',()=>expect(calc([],0.612903,{...run,periodStart:new Date('2026-08-01'),periodEnd:new Date('2026-08-31T23:59:59.999Z')})).toBe(19));
 it('retains zero and caps overdeductions at zero',()=>{expect(calc([],0)).toBe(0);expect(calc([{code:'ABSENCE_RECOVERY',description:'Absence recovery (32 days unexcused)'}])).toBe(0);});
 it('does not invent days for missing proration or unrecognised deduction evidence',()=>{expect(calc([],null)).toBeNull();expect(calc([{code:'ABSENCE_RECOVERY',description:'Unquantified deduction'}])).toBeNull();});
 it('rejects stale audit amounts and preserves an existing explicit zero',()=>{
  const payslip={id:1,grossAmount:'100',totalDeductions:'0',netAmount:'100',deductions:[]};
  const audit={payslipId:1,newValues:{grossAmount:'100',totalDeductions:'0',netAmount:'100',prorationFactor:1}};
  expect(resolvePayrollPaidDays({payrollRun:run,payslip,audit})).toBe(30);
  expect(resolvePayrollPaidDays({payrollRun:run,payslip:{...payslip,netAmount:'99'},audit})).toBeNull();
  expect(resolvePayrollPaidDays({payrollRun:run,payslip:{...payslip,payableDays:0}})).toBe(0);
 });
 it('calculates device paid days with the same absence decision that sets salary deductions',()=>{
  const r=buildPayslipFromInputs({employee:{id:1,tenant_id:'other',attendanceInputMode:'MANUAL_MONTHLY'},employmentTerm:{baseSalary:'30000',currency:'PKR',payFrequency:'MONTHLY'},payrollRun:run,bridges:{manualAttendance:{month:'2026-09',payableDays:30},attendanceRows:[{date:run.periodStart,status:'ABSENT',day_credit:0}]},ruleConfig:{absenceRecoveryEnabled:true}});
  expect(r.payableDays).toBe(29);expect(Number(r.netAmount)).toBe(29000);
 });
});
