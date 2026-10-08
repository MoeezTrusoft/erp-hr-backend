import { resolvePayrollPaidDays } from '../lib/payrollPaidDays.js';
import {payrollRegisterProfile} from '../lib/payrollRegisterProfiles.js';
import PDFDocument from 'pdfkit';
import prisma from '../lib/prisma.js';
import * as money from '../lib/money.js';
import {buildPayrollRegister,registerAmountKeys} from '../lib/payrollRegister.js';
export async function loadPayrollRegister({tenantId,runId,companyName,signatories}){
 if(!Number.isInteger(runId)||runId<1)throw Object.assign(new Error('Select a payroll run'),{status:400});
 const run=await prisma.payrollRun.findFirst({where:{tenantId,id:runId}});
 if(!run)throw Object.assign(new Error('Payroll run not found'),{status:404});
 const payslips=await prisma.payrollPayslip.findMany({where:{tenantId,payrollRunId:runId},include:{employee:{select:{employee_name:true,first_name:true,last_name:true,job_title:true,businessUnit:{select:{name:true}},additional_fields:true}},earnings:{include:{earningType:true}},deductions:{include:{deductionType:true}}},orderBy:{employeeId:'asc'}});
 if(!payslips.length)throw Object.assign(new Error('Process the payroll run before exporting its register'),{status:409});
 const missingDayIds=payslips.filter(p=>p.payableDays==null).map(p=>p.id);
 const dayAudits=missingDayIds.length ? await prisma.payrollAuditLog.findMany({where:{tenantId,payrollRunId:runId,payslipId:{in:missingDayIds},action:{in:['PAYSLIP_CREATED','PAYSLIP_REPROCESSED']}},orderBy:[{created_at:'desc'},{id:'desc'}],distinct:['payslipId'],select:{payslipId:true,newValues:true}}) : [];
 const auditsBySlip=new Map(dayAudits.map(a=>[a.payslipId,a]));
 for(const slip of payslips) slip.payableDays=resolvePayrollPaidDays({payrollRun:run,payslip:slip,audit:auditsBySlip.get(slip.id)});
 const profile=payrollRegisterProfile(tenantId);
 const seats=profile ? [] : await prisma.attendanceApprovalLevel.findMany({where:{tenantId,rowStatus:'ACTIVE',role:{in:['HR','MANAGEMENT']}},include:{approver:{select:{employee_name:true}}}});
 const defaults=[{name:seats.find(s=>s.role==='HR')?.approver?.employee_name||'',title:'HR Manager'},{name:'',title:'Accounts Manager'},{name:'',title:'Chief Financial Officer'},{name:seats.find(s=>s.role==='MANAGEMENT')?.approver?.employee_name||'',title:'Chief Executive Officer'}];
 return buildPayrollRegister({run,payslips,companyName:profile?.companyName||companyName,signatories:profile?.signatories||signatories||defaults});
}
export function renderPayrollRegister(model){
 return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',layout:'landscape',margin:24,bufferPages:true,info:{Title:`${model.companyName||'Payroll'} - Payroll register`,Author:'TruSoft ERP'}}),chunks=[];
 doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 const M=24,W=doc.page.width-2*M,BOTTOM=doc.page.height-36,teal='#007873',pale='#e6f3f2',grid='#263b3b';
 const widths=[24,124,96,36,50,52,36,38,56,48,40,40,40,56,64].map(w=>w*W/800),x=[M];widths.forEach(w=>x.push(x.at(-1)+w));
 let y=0;
 const text=(s,xx,yy,w,h,{bold=false,align='left',color='#132e2f',size=7.5}={})=>{doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(color).text(String(s??''),xx+4,yy+4,{width:w-8,height:h-6,align,lineBreak:true,ellipsis:true});};
 const box=(xx,yy,w,h,fill)=>{doc.rect(xx,yy,w,h).fillAndStroke(fill,grid);};
 const fmt=v=>{if(v===0n)return '-';const raw=money.minorToDecimal(v,model.currency);const [whole,fraction]=String(raw).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction&&Number(fraction)?'.'+fraction.replace(/0+$/,''):'');};
 const period=new Date(model.run.periodStart).toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
 function header(){
  y=24;text(`${model.companyName||'Payroll'} - ${period}`,M,y,W,23,{bold:true,color:teal,size:14});y+=24;
  text(`Run #${model.run.id} | ${model.currency} | ${model.run.status} | ${model.count} employees | Blank signatures are not approval records`,M,y,W,16,{size:7});y+=19;
  for(let i=0;i<15;i++){const span=[0,1,2,3,14].includes(i);box(x[i],y,widths[i],span?38:19,teal);if(span)text(['#','Employee Name','Position','Paid\nDays'][i]||'Net Pay',x[i],y+5,widths[i],33,{bold:true,align:'center',color:'white',size:7.5});}
  box(x[4],y,x[9]-x[4],19,teal);text('Earnings',x[4],y,x[9]-x[4],19,{bold:true,align:'center',color:'white'});
  box(x[9],y,x[14]-x[9],19,teal);text('Deductions',x[9],y,x[14]-x[9],19,{bold:true,align:'center',color:'white'});
  ['Basic','Allowances','Bonus','Comm','Gross','WHT','Adv.','Loan','Other','Total'].forEach((label,j)=>{const i=j+4;box(x[i],y+19,widths[i],19,teal);text(label,x[i],y+19,widths[i],19,{bold:true,align:'center',color:'white'});});y+=38;
 }
 function ensure(h){if(y+h>BOTTOM){doc.addPage();header();}}
 function band(label,fill=pale){ensure(23);box(M,y,W,23,fill);text(label,M,y,W,23,{bold:true,size:9});y+=23;}
 function total(label,a,fill='#e3e9e8'){ensure(23);box(M,y,x[4]-M,23,fill);text(label,M,y,x[4]-M,23,{bold:true,align:'right'});registerAmountKeys.forEach((k,j)=>{box(x[j+4],y,widths[j+4],23,fill);text(fmt(a[k]),x[j+4],y,widths[j+4],23,{bold:true,align:'right',size:7});});y+=23;}
 header();
 model.offices.forEach((office,oi)=>{
  if(oi){doc.addPage();header();}
  band(office.name,'#cde7e5');
  for(const dept of office.departments){
   ensure(68);band(dept.name);
   dept.rows.forEach((r,index)=>{
    const rowHeight=Math.max(22,Math.ceil(doc.font('Helvetica').fontSize(7.1).heightOfString(r.name,{width:widths[1]-8}))+8,Math.ceil(doc.heightOfString(r.position,{width:widths[2]-8}))+8);
    if(y+rowHeight+(index===dept.rows.length-1?23:0)>BOTTOM){doc.addPage();header();band(`${office.name} / ${dept.name} (continued)`);}
    const vals=[index+1,r.name,r.position,r.paidDays,...registerAmountKeys.map(k=>fmt(r[k]))];
    vals.forEach((v,i)=>{box(x[i],y,widths[i],rowHeight,'#ffffff');text(v,x[i],y,widths[i],rowHeight,{align:i<3?'left':i===3?'center':'right',size:7.1,bold:[8,13,14].includes(i)});});y+=rowHeight;
   });total('Department Totals',dept.totals);
  }total(`${office.name} Totals`,office.totals,'#cde7e5');y+=12;
 });
 ensure(190);band('Consolidated office summary');
 total('Payroll Totals - All offices',model.totals,'#cde7e5');y+=17;
 const labels=model.signatories.map((s,i)=>s.label||['PREPARED BY','VERIFIED BY','AUTHORIZED BY','APPROVED BY'][i]),gap=9,sw=(W-(labels.length-1)*gap)/labels.length;
 labels.forEach((label,i)=>{const xx=M+i*(sw+gap),s=model.signatories[i]||{};box(xx,y,sw,96,'#ffffff');box(xx,y,sw,24,pale);text(label,xx,y+3,sw,22,{bold:true,align:'center',color:teal});text(s.name||'',xx+5,y+32,sw-10,20,{bold:true,size:8});text(s.title||'',xx+5,y+52,sw-10,16,{size:7});doc.moveTo(xx+9,y+79).lineTo(xx+sw/2-6,y+79).stroke().moveTo(xx+sw/2+6,y+79).lineTo(xx+sw-9,y+79).stroke();text('DATE',xx+5,y+80,sw/2,14,{size:5});text('SIGNATURE',xx+sw/2+2,y+80,sw/2-5,14,{size:5});});y+=105;
 text('Paid days reflect payroll proration and recorded attendance/leave deductions; "-" means insufficient payroll evidence. Department and position use employee records.',M,y,W,25,{size:6.5});
 const pages=doc.bufferedPageRange();for(let p=0;p<pages.count;p++){doc.switchToPage(p);const oldBottom=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.font('Helvetica').fontSize(7).fillColor('#536b6b').text(`Confidential payroll | Run #${model.run.id} | Page ${p+1} of ${pages.count}`,M,doc.page.height-22,{width:W,align:'right',lineBreak:false});doc.page.margins.bottom=oldBottom;}
 doc.end();
 });
}
export async function exportPayrollPdf(args){const model=await loadPayrollRegister(args),pdf=await renderPayrollRegister(model);return {format:'pdf',encoding:'base64',mimeType:'application/pdf',filename:`payroll-${model.run.periodStart.toISOString().slice(0,7)}-run-${model.run.id}.pdf`,content:pdf.toString('base64')};}
