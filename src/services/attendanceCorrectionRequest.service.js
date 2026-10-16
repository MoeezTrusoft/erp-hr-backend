import prisma from '../lib/prisma.js';
import { getCtx } from '../mcp/context.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { actor } from './separation/base.js';
import { dateOnly } from '../lib/attendanceDates.js';
import { assertAttendancePeriodOpen, lockAttendancePeriod } from './attendancePeriod.service.js';
import { hash, requireApproval } from './approval/adapters.js';
import { replayTenant } from '../lib/attendanceReplay.js';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const fields = ['date', 'sessionKey', 'checkIn', 'checkOut', 'reason', 'evidence', 'reasonCategory', 'evidenceDate'];
const payload = row => Object.fromEntries(fields.map(k => [k, k === 'date' ? String(row.date instanceof Date ? row.date.toISOString() : row.date).slice(0, 10) : row[k] ?? null]));

// Drafts belong to the verified employee. Saving never changes attendance.
export async function saveCorrectionRequest(input, db = prisma) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId || !ctx.permissions?.includes('hr.approvals.self')) fail('A verified employee account and request permission are required', 403);
  const tenantId = ctx.user.tenantId;
  return tenantTransaction(db, async tx => {
    const who = await actor(tx, ctx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':attendance-correction:' + who.id + ':' + input.date},0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':approval-source:ATTENDANCE_CORRECTION:' + input.id},0))`;
    await tx.$queryRaw`SELECT id FROM "HrApprovalRequest" WHERE "tenantId"=${tenantId}::uuid AND kind='ATTENDANCE_CORRECTION' AND "sourceRef"=${input.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM attendance_correction_requests WHERE "tenantId"=${tenantId}::uuid AND id=${input.id}::uuid FOR UPDATE`;
    await lockAttendancePeriod(tx, tenantId, true);
    await assertAttendancePeriodOpen(tx, tenantId, input.date, input.date);
    const prior = await tx.attendanceCorrectionRequest.findFirst({ where: { tenantId, id: input.id } });
    if (prior && prior.employeeId !== who.id) fail('Request not found', 404);
    const approval = prior && await tx.hrApprovalRequest.findFirst({ where: { tenantId, kind: 'ATTENDANCE_CORRECTION', sourceRef: prior.id } });
    const unchanged = prior && hash(payload(prior)) === hash(payload(input));
    if (unchanged && (prior.version !== input.version || (approval && approval.stage !== 'INITIATOR'))) return { ...prior, employeeCode: who.employee_code, approvalVersion: approval?.version || 0 };
    if (prior && (prior.version !== input.version || (approval && approval.stage !== 'INITIATOR'))) fail('Request changed or is under review. Refresh before editing.');
    if (prior && (payload(prior).date !== input.date || prior.sessionKey !== input.sessionKey)) fail('A correction keeps its original work date and shift. Create a separate request for another day.');
    if (!prior && input.version !== 0) fail('Draft not found', 404);
    const active = await tx.attendanceCorrectionRequest.findFirst({ where: { tenantId, employeeId: who.id, date: dateOnly(input.date), sessionKey: input.sessionKey, status: 'PENDING', id: { not: input.id } } });
    if (active) fail('A correction draft or request already exists for this shift. Open it from My requests.');
    const sessions = await replayTenant({ tenantId, employeeIds: [who.id], from: input.date, to: input.date, db: tx, includeEmpty: true });
    const session = sessions.find(s => s.sessionKey === input.sessionKey);
    if (!session?.shift?.start || !session.setupSnapshot?.working) fail('Choose a published scheduled session');
    if (input.evidenceDate) dateOnly(input.evidenceDate);
    if (input.reasonCategory && !['MISSED_PUNCH','READER_FAILURE','DELAYED_CAPTURE','OTHER'].includes(input.reasonCategory)) fail('Select a valid reason category',422);
    if ((input.checkIn && session.verdict.checkIn) || (input.checkOut && session.verdict.checkOut)) fail('A recorded punch cannot be replaced by a missing-time request');
    const attendance = await tx.attendance.findFirst({ where: { tenantId, employeeId: who.id, date: dateOnly(input.date) } });
    const data = { ...payload(input), date: dateOnly(input.date), evaluationVersion: attendance?.evaluationVersion || 0 };
    const { applyMissingTime } = await import('./attendanceRules.service.js');
    if (input.checkIn || input.checkOut) await applyMissingTime({ ...data, reason:input.reason?.trim() || 'Incomplete draft validation', date: input.date, employeeId: who.id, version: data.evaluationVersion, validateOnly: true, user: { tenantId, employeeId: who.id, userId: who.employee_code, roles: ['HR Manager'] } }, tx);
    const saved = prior
      ? await tx.attendanceCorrectionRequest.update({ where: { id: prior.id }, data: { ...data, version: { increment: 1 } } })
      : await tx.attendanceCorrectionRequest.create({ data: { ...data, id: input.id, tenantId, employeeId: who.id, version: 1 } });
    await tx.attendanceRuleAudit.create({ data: { tenantId, employeeId: who.id, action: 'CORRECTION_DRAFT_SAVED', actorId: who.employee_code, data: { requestRef: saved.id, version: saved.version, before: prior ? payload(prior) : null, after: payload(saved) } } });
    return { ...saved, employeeCode: who.employee_code, approvalVersion: approval?.version || 0 };
  }, { tenantId, txOptions: { timeout: 60000 } });
}

export async function myCorrectionRequests({ date }, db = prisma) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId || !ctx.permissions?.includes('hr.approvals.self')) fail('A verified employee account is required', 403);
  const tenantId = ctx.user.tenantId;
  return tenantTransaction(db, async tx => {
    const who = await actor(tx, ctx);
    const items = await tx.attendanceCorrectionRequest.findMany({ where: { tenantId, employeeId: who.id, date: dateOnly(date), status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    for (const item of items) {
      const approval = await tx.hrApprovalRequest.findFirst({ where: { tenantId, kind: 'ATTENDANCE_CORRECTION', sourceRef: item.id } });
      item.canEdit = !approval || approval.stage === 'INITIATOR';
      item.approvalVersion = approval?.version || 0;
      item.approvalStage = approval?.stage || 'DRAFT';
      item.approvalRef = approval?.id || null;
      item.employeeCode = who.employee_code;
    }
    return { items };
  }, { tenantId });
}

export async function finalizeCorrectionRequest(tx, env, row, approved) {
  await requireApproval(tx, env.tenantId, 'ATTENDANCE_CORRECTION', row.id, approved);
  if (approved) {
    await lockAttendancePeriod(tx, env.tenantId, true);
    const { applyMissingTime } = await import('./attendanceRules.service.js');
    await applyMissingTime({ user: { tenantId: env.tenantId, employeeId: env.who.id, userId: env.who.employee_code, roles: ['HR Manager'] }, employeeId: row.employeeId, date: row.date.toISOString().slice(0, 10), sessionKey: row.sessionKey, version: row.evaluationVersion, checkIn: row.checkIn, checkOut: row.checkOut, reason: `${row.reason}\nEvidence: ${row.evidence}\nApproved correction: ${row.id}` }, tx);
  }
  await tx.attendanceCorrectionRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}
