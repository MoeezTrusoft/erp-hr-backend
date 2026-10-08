import * as money from './money.js';
const name=e=>e.employee_name||[e.first_name,e.last_name].filter(Boolean).join(' ');
const keys=['basic','otherEarnings','bonus','commission','gross','tax','advance','loan','otherDeductions','deductions','net'];
const empty=()=>Object.fromEntries(keys.map(k=>[k,0n]));
export function buildPayrollRegister({run,payslips,companyName='',signatories=[]}){
 const currency=run.currencyCode||'PKR',minor=v=>money.decimalToMinor(String(v??0),currency);
 const offices=new Map(),totals=empty();
 for(const slip of payslips){
  const employee=slip.employee||{employee_name:`Employee #${slip.employeeId} (record unavailable)`},amounts=empty();
  for(const line of slip.earnings){
   const code=String(line.earningType?.code||'').toUpperCase(),desc=String(line.description||line.earningType?.name||'');
   const key=/^base salary\b/i.test(desc)?'basic':/bonus/i.test(code+' '+desc)?'bonus':/comm(ission)?\b/i.test(code+' '+desc)?'commission':/allowance|employer|overtime|benefit/i.test(desc)?'otherEarnings':['BASIC','BASE_SALARY','SALARY'].includes(code)?'basic':'otherEarnings';
   amounts[key]+=minor(line.amount);
  }
  for(const line of slip.deductions){
   const text=[line.description,line.deductionType?.code,line.deductionType?.name].filter(Boolean).join(' ');
   const key=/income.?tax|withholding|\bWHT\b|\bTAX\b/i.test(text)?'tax':/advance/i.test(text)?'advance':/loan/i.test(text)?'loan':'otherDeductions';
   amounts[key]+=minor(line.amount);
  }
  amounts.gross=minor(slip.grossAmount);amounts.deductions=minor(slip.totalDeductions);amounts.net=minor(slip.netAmount);
  if(amounts.basic+amounts.bonus+amounts.commission+amounts.otherEarnings!==amounts.gross || amounts.tax+amounts.advance+amounts.loan+amounts.otherDeductions!==amounts.deductions || amounts.gross-amounts.deductions!==amounts.net)throw new Error(`Payslip ${slip.id} line items do not reconcile with recorded totals`);
  const office=slip.payrollOffice||'Unassigned office';
  const department=employee.businessUnit?.name||employee.additional_fields?.payrollDepartment||'Department not recorded';
  if(!offices.has(office))offices.set(office,{name:office,departments:new Map(),totals:empty(),count:0});
  const o=offices.get(office);if(!o.departments.has(department))o.departments.set(department,{name:department,rows:[],totals:empty()});
  const d=o.departments.get(department);
  d.rows.push({name:name(employee),position:employee.job_title||'-',paidDays:slip.payableDays==null?'-':String(slip.payableDays),...amounts});
  for(const k of keys){d.totals[k]+=amounts[k];o.totals[k]+=amounts[k];totals[k]+=amounts[k];}o.count++;
 }
 return {run,currency,companyName,signatories,totals,count:payslips.length,offices:[...offices.values()].map(o=>({...o,departments:[...o.departments.values()]}))};
}
export {keys as registerAmountKeys};
