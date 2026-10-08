import {describe,it,expect,jest} from '@jest/globals';
import {buildPayrollRegister} from '../../src/lib/payrollRegister.js';
const run={id:19,currencyCode:'PKR',periodStart:new Date('2026-09-01'),status:'COMPLETED'};
const slip={id:1,employee:{employee_name:'Example',job_title:'Engineer',businessUnit:{name:'Engineering'}},payrollOffice:'PECHS',payableDays:null,grossAmount:'115.25',totalDeductions:'15.25',netAmount:'100',earnings:[{amount:'80',description:'Base salary for September',earningType:{code:'BASIC'}},{amount:'10',earningType:{code:'BONUS'}},{amount:'20',earningType:{code:'COMMISSION'}},{amount:'5.25',earningType:{code:'HOUSE'}}],deductions:[{amount:'5',description:'Income Tax'},{amount:'4',description:'Salary advance'},{amount:'3',description:'Loan repayment'},{amount:'3.25',description:'Absence recovery'}]};
describe('payroll register',()=>{
 it('keeps every earning and deduction in a reconciled template column',()=>{const m=buildPayrollRegister({run,payslips:[slip]});expect(m.totals).toEqual({basic:8000n,bonus:1000n,commission:2000n,otherEarnings:525n,gross:11525n,tax:500n,advance:400n,loan:300n,otherDeductions:325n,deductions:1525n,net:10000n});expect(m.offices[0].departments[0].rows[0].paidDays).toBe('-');});
 it('groups by office then department and preserves recorded half-days',()=>{const m=buildPayrollRegister({run,payslips:[slip,{...slip,id:2,payrollOffice:'Headend',payableDays:'29.5',employee:{employee_name:'Other',additional_fields:{payrollDepartment:'Office Staff'}}}]});expect(m.offices).toHaveLength(2);expect(m.offices[1].departments[0].name).toBe('Office Staff');expect(m.offices[1].departments[0].rows[0].paidDays).toBe('29.5');expect(m.totals.net).toBe(20000n);});
 it('refuses misleading totals if persisted line items disagree',()=>expect(()=>buildPayrollRegister({run,payslips:[{...slip,grossAmount:'999'}]})).toThrow('reconcile'));
 it('does not mistake non-taxable allowance names for income withholding',()=>{const m=buildPayrollRegister({run,payslips:[{...slip,deductions:[{amount:'15.25',description:'Other deduction'}]}]});expect(m.totals.tax).toBe(0n);});
});

const {payrollRegisterProfile}=await import('../../src/lib/payrollRegisterProfiles.js');
it.each([
 ['8f4a526f-d45b-4da2-b772-d6682e849812','Khurram Gul','Irfan Abdi'],
 ['14d8c7b1-194d-4e35-b058-b9cb9aa9fba2','Khurram Gul','Irfan Abdi'],
 ['8ff0533b-62f6-4be9-a78e-69adf49e00bc','Khurram Gul','Irfan Abdi'],
 ['40314ef4-0a81-4390-b631-b3ad3f21f523','Samar Abbas','Irfan Abdi'],
 ['61b7eb53-ab6e-413f-9d9a-1ecf4e071e73','Hasan Abbas','Imran Abdi'],
])('prints the specified tenant signatories for %s',(tenant,authorized,approved)=>{
 expect(payrollRegisterProfile(tenant).signatories.map(s=>s.name)).toEqual(['Afsha Khan',authorized,approved]);
 expect(payrollRegisterProfile(tenant).signatories.map(s=>s.label)).toEqual(['PREPARED BY','AUTHORIZED BY','APPROVED BY']);
});
it('does not match a company display label as a tenant identity',()=>expect(payrollRegisterProfile('HomeVision')).toBeNull());

it('retains historical payroll rows when the employee is no longer accessible in this tenant',()=>{const m=buildPayrollRegister({run,payslips:[{...slip,employeeId:549,employee:null,payableDays:30}]});expect(m.count).toBe(1);expect(m.offices[0].departments[0].rows[0]).toMatchObject({name:'Employee #549 (record unavailable)',paidDays:'30'});expect(m.totals.net).toBe(10000n);});
