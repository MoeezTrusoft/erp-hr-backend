import {it,expect} from '@jest/globals';
import {buildPayslipFromInputs,payrollEligibleFilter} from '../../src/services/payrollService.js';
const run={periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30T23:59:59.999Z'),currencyCode:'PKR',countryCode:'PK'};
const pay=employee=>buildPayslipFromInputs({employee,employmentTerm:{baseSalary:'60000',payFrequency:'MONTHLY',currency:'PKR'},payrollRun:run});
it('uses joining date when hire date is missing for salary proration',()=>{expect(Number(pay({id:1,joining_date:'2026-10-02'}).grossAmount)).toBe(0);const partial=pay({id:1,joining_date:'2026-09-16'});expect(Number(partial.grossAmount)).toBe(60000);expect(Number(partial.netAmount)).toBe(30000);expect(Number(partial.totalDeductions)).toBe(30000);});
it('requires either a period overlap or a valid fallback joining date',()=>{const dateGuard=payrollEligibleFilter(run).AND.find(c=>c.OR?.some(x=>x.employmentPeriods?.none));expect(dateGuard.OR[1]).toEqual({employmentPeriods:{none:{}},OR:[{hire_date:{lte:run.periodEnd}},{hire_date:null,joining_date:{lte:run.periodEnd}},{hire_date:null,joining_date:null}]});});

it('Waqas: shows 55000 monthly gross, 36667 joining deduction, tax 50 and unchanged net 18283',()=>{
 const slip=buildPayslipFromInputs({employee:{id:566,employmentPeriods:[{startDate:'2026-09-21'}]},employmentTerm:{baseSalary:'55000',payFrequency:'MONTHLY',currency:'PKR'},payrollRun:run,taxRateRows:[{countryCode:'PK',bracketMin:50000,bracketMax:null,rate:0.01,effectiveFrom:'2026-01-01'}]});
 expect(Number(slip.grossAmount)).toBe(55000);expect(Number(slip.netAmount)).toBe(18283);expect(slip.payableDays).toBe(10);
 expect(slip.deductions.find(d=>d.code==='EMPLOYMENT_PRORATION')).toMatchObject({amount:'36667.0000',description:'Joining/leaving date deduction (20 days outside employment)'});
 expect(Number(slip.deductions.find(d=>d.code==='INCOME_TAX').amount)).toBe(50);
});
