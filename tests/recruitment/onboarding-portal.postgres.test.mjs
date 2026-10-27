import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/hr_task_assessment_test' || url.username !== 'recruitment_test_user') throw new Error('Use the isolated non-owner recruitment test database');
process.env.DATABASE_URL=url.href; process.env.NODE_ENV='test';
process.env.HR_C4_ENCRYPTION_KEY=Buffer.alloc(32,17).toString('base64');
const { default: prisma }=await import('../../src/lib/prisma.js');
const { mcpCtx }=await import('../../src/mcp/context.js');
const { tenantTransaction }=await import('../../src/lib/rlsTenant.js');
const svc=await import('../../src/services/onboardingPortalScreen.service.js');
const { ONBOARDING_FEEDBACK_QUESTIONS }=await import('../../src/lib/onboardingTaxonomy.js');
const { registerOnboardingPortalScreenTools }=await import('../../src/mcp/tools/onboardingPortalScreenTools.js');
const handlers=new Map(); registerOnboardingPortalScreenTools({tool:(n,...args)=>handlers.set(n,args.at(-1))});
const tenant=randomUUID(), foreign=randomUUID(), people={};
const tx=(fn,t=tenant)=>mcpCtx.run({user:{tenantId:t}},()=>tenantTransaction(prisma,fn,{tenantId:t}));
const ctx=(name='self', permissions=['hr.self.read'])=>({actorVerified:true,user:{tenantId:tenant,userId:people[name].userId,employeeId:people[name].id,roles:[name==='hr'?'HR_ADMIN':'EMPLOYEE']},permissions});
const as=(fn,name='self',permissions)=>mcpCtx.run(ctx(name,permissions),fn);
const all=['hr.onboarding.read','hr.onboarding.create','hr.onboarding.update','hr.onboarding.delete'];
const call=async(n,args={})=>{const r=await handlers.get(n)(args);if(r.isError) throw new Error(JSON.stringify(r));return JSON.parse(r.content[0].text);};
const answers=ONBOARDING_FEEDBACK_QUESTIONS.map(q=>({questionId:q.id,answer:q.options[0]}));
let checklist, otherChecklist, ownTask, hrTask, assignedTask, otherTask;
test('onboarding self service enforces linked employee ownership and responsible tasks', {timeout:90000},async t=>{
 await tx(async db=>{
  for(const name of ['self','other','hr']) people[name]=await db.employee.create({data:{tenant_id:tenant,employee_code:'ONB-'+randomUUID().toUpperCase(),userId:randomInt(100000,1000000000),employeeCategory:'EMPLOYEE',first_name:name,status:'Active',employement_status:'Active'}});
  checklist=await db.onboardingChecklist.create({data:{tenantId:tenant,employeeId:people.self.id,startDate:new Date()}});
  otherChecklist=await db.onboardingChecklist.create({data:{tenantId:tenant,employeeId:people.other.id,startDate:new Date()}});
  ownTask=await db.onboardingTask.create({data:{tenantId:tenant,checklistId:checklist.id,title:'Read handbook',assigneeType:'NEW_HIRE'}});
  hrTask=await db.onboardingTask.create({data:{tenantId:tenant,checklistId:checklist.id,title:'Prepare account',assigneeType:'IT',assigneeId:people.hr.id}});
  assignedTask=await db.onboardingTask.create({data:{tenantId:tenant,checklistId:checklist.id,title:'Collect kit',assigneeType:'HR',assigneeId:people.self.id}});
  otherTask=await db.onboardingTask.create({data:{tenantId:tenant,checklistId:otherChecklist.id,title:'Other person task',assigneeType:'NEW_HIRE'}});
  await db.onboardingSession.create({data:{tenantId:tenant,checklistId:checklist.id,title:'Orientation',sessionDate:new Date(),fromTime:'09:00',toTime:'10:00'}});
 });
 await t.test('self read works through MCP with only self permission and returns real schedule',async()=>{
  const p=await as(()=>call('hr_onboarding_portal_get'));
  assert.equal(p.employee.id,people.self.id);assert.equal(p.sessions[0].title,'Orientation');assert.equal(p.canSubmitFeedback,true);
  assert.equal(p.tasks.find(x=>x.id===ownTask.id).canComplete,true);assert.equal(p.tasks.find(x=>x.id===hrTask.id).canComplete,false);
 });
 await t.test('foreign checklist, employee and task IDs reveal no foreign data',async()=>{
  for(const args of [{checklistId:otherChecklist.id},{employeeId:people.other.id}]) await assert.rejects(as(()=>svc.getOnboardingPortal({tenantId:tenant,...args})),e=>e.statusCode===404||e.status===404);
  await assert.rejects(as(()=>svc.completePortalTask({tenantId:tenant,taskId:otherTask.id})),/not found/);
  await assert.rejects(as(()=>svc.getFeedbackQuestions({tenantId:tenant,checklistId:otherChecklist.id})),/not found/);
 });
 await t.test('completion is responsible-only and repeat completion preserves timestamp',async()=>{
  const p=await as(()=>call('hr_onboarding_portal_task_complete',{taskId:ownTask.id}));
  const again=await as(()=>svc.completePortalTask({tenantId:tenant,taskId:ownTask.id}));assert.equal(new Date(p.completedAt).getTime(),again.completedAt.getTime());
  await assert.rejects(as(()=>svc.completePortalTask({tenantId:tenant,taskId:hrTask.id})),/responsible/);
  await as(()=>svc.completePortalTask({tenantId:tenant,taskId:assignedTask.id}));
  const reopened=await as(()=>svc.completePortalTask({tenantId:tenant,taskId:ownTask.id,done:false}));assert.equal(reopened.completedAt,null);assert.equal(reopened.done,false);
 });
 await t.test('self cannot create, reassign or delete tasks, or send HR reminders',async()=>{
  for(const fn of [()=>svc.createPortalTask({tenantId:tenant,checklistId:checklist.id,title:'x'}),()=>svc.updatePortalTask({tenantId:tenant,taskId:ownTask.id,responsibleId:people.self.id}),()=>svc.deletePortalTask({tenantId:tenant,taskId:ownTask.id}),()=>svc.sendTaskReminder({tenantId:tenant,taskId:hrTask.id})]) await assert.rejects(as(fn),/permission/i);
 });
 await t.test('verified user binding overrides a forged employee claim and inactive accounts fail',async()=>{
  const forged=ctx();forged.user.employeeId=people.other.id;
  const p=await mcpCtx.run(forged,()=>svc.getOnboardingPortal({tenantId:tenant}));assert.equal(p.employee.id,people.self.id);
  await tx(db=>db.employee.update({where:{id:people.self.id},data:{status:'Inactive'}}));
  await assert.rejects(as(()=>svc.getOnboardingPortal({tenantId:tenant})),/active linked/);
  await tx(db=>db.employee.update({where:{id:people.self.id},data:{status:'Active'}}));
 });
 await t.test('unverified, cross-tenant and admin-without-grants are denied',async()=>{
  const unverified={...ctx(),actorVerified:false};await assert.rejects(mcpCtx.run(unverified,()=>svc.getOnboardingPortal({tenantId:tenant})),/Verified/);
  await assert.rejects(as(()=>svc.getOnboardingPortal({tenantId:foreign})),/Verified/);
  const admin=ctx('hr',[]);admin.user.isAdmin=true;await assert.rejects(mcpCtx.run(admin,()=>svc.getOnboardingPortal({tenantId:tenant})),/permission/i);
  await assert.rejects(as(()=>svc.getOnboardingPortal({tenantId:tenant}),'self',all),/permission/i);
 });
 await t.test('HR can inspect and manage assigned work but cannot impersonate new hire feedback',async()=>{
  const p=await as(()=>svc.getOnboardingPortal({tenantId:tenant,checklistId:checklist.id}),'hr',all);assert.equal(p.canSubmitFeedback,false);assert.ok(p.tasks.every(t=>t.canComplete));
  await as(()=>svc.completePortalTask({tenantId:tenant,taskId:hrTask.id}),'hr',all);
  await assert.rejects(as(()=>svc.submitPortalFeedback({tenantId:tenant,checklistId:checklist.id,answers}),'hr',all),/not found/);
 });
 await t.test('feedback requires all canonical answers and concurrent own updates create one row',async()=>{
  await assert.rejects(as(()=>svc.submitPortalFeedback({tenantId:tenant,checklistId:checklist.id,answers:answers.slice(1)})),/every/);
  await assert.rejects(as(()=>svc.submitPortalFeedback({tenantId:tenant,checklistId:checklist.id,answers:[...answers,answers[0]]})),/duplicate/);
  await Promise.all([1,2].map(n=>as(()=>svc.submitPortalFeedback({tenantId:tenant,checklistId:checklist.id,answers,comments:'Own feedback '+n}))));
  const rows=await tx(db=>db.onboardingFeedback.findMany({where:{tenantId:tenant,checklistId:checklist.id}}));assert.equal(rows.length,1);assert.equal(rows[0].employeeId,people.self.id);
  const q=await as(()=>call('hr_onboarding_portal_feedback_questions',{checklistId:checklist.id}));assert.equal(q.submitted,true);assert.equal(q.responses.length,answers.length);
 });
 await t.test('changes persist minimal transactional events without feedback text',async()=>{
  const events=await tx(db=>db.outboxEvent.findMany({where:{tenantId:tenant,eventName:{startsWith:'hr.onboarding.'}}}));
  assert.equal(events.filter(e=>e.eventName==='hr.onboarding.task_changed.v1').length,4);
  assert.equal(events.filter(e=>e.eventName==='hr.onboarding.feedback_submitted.v1').length,2);
  for(const e of events){assert.equal(e.payload.payload.comments,undefined);assert.equal(e.payload.payload.responses,undefined);assert.ok(e.payload.payload.actorId);}
 });
 await t.test('foreign-tenant assignee cannot be attached by HR',async()=>{
  let outsider;await tx(async db=>{outsider=await db.employee.create({data:{tenant_id:foreign,employee_code:'ONB-'+randomUUID().toUpperCase(),userId:randomInt(100000,1000000000),employeeCategory:'EMPLOYEE',first_name:'Foreign',status:'Active'}});},foreign);
  await assert.rejects(as(()=>svc.updatePortalTask({tenantId:tenant,taskId:ownTask.id,responsibleId:outsider.id}),'hr',all),/not found/);
  await tx(db=>db.employee.delete({where:{id:outsider.id}}),foreign);
 });
 await tx(async db=>{await db.$executeRawUnsafe('DELETE FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid',tenant);await db.onboardingChecklist.deleteMany({where:{tenantId:tenant}});await db.employee.deleteMany({where:{tenant_id:tenant}});});
});
test.after(()=>prisma.$disconnect());
