import {it,expect} from '@jest/globals';
import {buildPayslipFromInputs,payrollEligibleFilter} from '../../src/services/payrollService.js';
const run={periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30T23:59:59.999Z'),currencyCode:'PKR',countryCode:'PK'};
const pay=employee=>buildPayslipFromInputs({employee,employmentTerm:{baseSalary:'60000',payFrequency:'MONTHLY',currency:'PKR'},payrollRun:run});
it('uses joining date when hire date is missing for salary proration',()=>{expect(Number(pay({id:1,joining_date:'2026-10-02'}).grossAmount)).toBe(0);expect(Number(pay({id:1,joining_date:'2026-09-16'}).grossAmount)).toBe(30000);});
it('requires either a period overlap or a valid fallback joining date',()=>{const dateGuard=payrollEligibleFilter(run).AND.find(c=>c.OR?.some(x=>x.employmentPeriods?.none));expect(dateGuard.OR[1]).toEqual({employmentPeriods:{none:{}},OR:[{hire_date:{lte:run.periodEnd}},{hire_date:null,joining_date:{lte:run.periodEnd}},{hire_date:null,joining_date:null}]});});
