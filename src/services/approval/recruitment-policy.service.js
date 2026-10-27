import { chainFor, emitRequisitionSubmittedEvent } from '../requisitionApprovalChain.service.js';
import { assertChainCanComplete } from '../../lib/requisitionApprovalChain.js';
import { requiredStagesForOffer } from '../offerApproval.service.js';
import { assertRequisitionTransition, assertRequisitionAdvanceAllowed, recordRequisitionTransition } from '../requisitionWorkflow.service.js';
import { assertFinanceValidityAtSubmit } from '../financeValidity.service.js';
import { enqueueHrDomainEvent } from '../hrDomainEvent.service.js';
import { requisitionDecisionEvent } from '../hrEvents.js';
import { isRecruitmentFlagEnabled } from '../../lib/recruitmentFlags.js';

const deny = (message, status = 409) => { throw Object.assign(new Error(message), { status, code: 'HR-5101' }); };
export const roleSets = {
  HIRING_MANAGER: ['HIRING_MANAGER', 'LINE_MANAGER', 'DEPARTMENT_MANAGER', 'MANAGER'],
  HR_HEAD: ['HR_HEAD', 'HR_ADMIN', 'HR_MANAGER'],
  FINANCE: ['FINANCE', 'FINANCE_MANAGER', 'FINANCE_ADMIN'],
};
export function policyActions(env, row) {
  const policy = row.recruitmentPolicy;
  if (!policy || ['APPROVED', 'REJECTED', 'WITHDRAWN', 'INITIATOR'].includes(row.stage)) return [];
  const step = policy.steps[policy.decisions.length];
  if (!step || env.identityCodes?.has?.(row.employeeCode) || row.employeeCode === env.who.employee_code) return [];
  const roles = (env.ctx.user.roles || []).map(r => String(r).toUpperCase());
  const role = String(step.role || '').toUpperCase();
  if (step.approverId && Number(step.approverId) !== env.who.id) return [];
  if (!step.approverId && !(roleSets[role] || [role]).some(r => roles.includes(r))) return [];
  if (step.requiresDistinctApprover !== false && policy.decisions.some(d => d.actorId === env.who.id)) return [];
  const grant = policyGrant(step);
  return env.ctx.permissions?.includes('hr.approvals.' + grant) ? ['APPROVE', 'REJECT', 'REVERT'] : [];
}
export function policyGrant(step) {
  const role = String(step?.role || '').toUpperCase();
  return role === 'HIRING_MANAGER' ? 'manager' : role === 'HR_HEAD' ? 'verify' : 'approve';
}
export function policyQueueFields(policy) {
  const step = policy?.steps[policy.decisions.length];
  return { policyRole: step?.role?.toUpperCase() ?? null, policyApproverId: step?.approverId ?? null, policyPermission: step ? policyGrant(step) : null };
}
export function policyQueueWhere(env) {
  const roles = (env.ctx.user.roles || []).map(r => String(r).toUpperCase());
  const allowedRoles = [...new Set([...roles, ...Object.entries(roleSets).filter(([, aliases]) => aliases.some(r => roles.includes(r))).map(([role]) => role)])];
  return { stage: 'MANAGEMENT', policyPermission: { in: ['manager','verify','approve'].filter(p => env.ctx.permissions?.includes('hr.approvals.' + p)) }, employeeCode: { notIn: env.identityCodes }, OR: [{ policyApproverId: env.who.id }, { policyApproverId: null, policyRole: { in: allowedRoles } }] };
}
export async function resolveRecruitmentPolicy(tx, env, kind, source) {
  if (!['REQUISITION', 'OFFER'].includes(kind)) return null;
  if (!isRecruitmentFlagEnabled(kind === 'REQUISITION' ? 'workflow' : 'offerHandoff')) deny('Recruitment workflow is disabled', 503);
  let steps;
  if (kind === 'REQUISITION') {
    assertRequisitionTransition(source.row.status, 'PENDING_APPROVAL', { requisition: source.row });
    await assertRequisitionAdvanceAllowed(env.tenantId, source.row, 'PENDING_APPROVAL');
    const finance = await assertFinanceValidityAtSubmit(env.tenantId, source.row, source.row.budgetApprovalSnapshot);
    if (finance) await tx.jobRequisition.update({ where: { id: source.row.id }, data: { budgetApprovalSnapshot: finance } });
    steps = await chainFor({ ...source.row, approvalChainSnapshot: null }, { db: tx, tenantId: env.tenantId });
    assertChainCanComplete(steps, source.row);
  } else {
    steps = (await requiredStagesForOffer({ offerId: source.row.id, tenantId: env.tenantId, db: tx })).steps.map(s => ({
      ...s, role: s.role || ({ hiringManager: 'HIRING_MANAGER', hrHead: 'HR_HEAD', finance: 'FINANCE' })[s.stage], requiresDistinctApprover: true,
    }));
  }
  return steps.length ? { steps, decisions: [] } : null;
}
export async function recruitmentSubmitted(tx, env, source) {
  await recordRequisitionTransition(tx, { tenantId: env.tenantId, requisitionId: source.row.id, fromStatus: source.row.status, toStatus: 'PENDING_APPROVAL', actorId: env.who.id, source: 'approval-centre' });
  await emitRequisitionSubmittedEvent(tx, { tenantId: env.tenantId, requisition: source.row, actorId: env.who.id });
}
export async function mirrorRecruitmentStep(tx, env, row, action, reason) {
  const policy = row.recruitmentPolicy;
  const step = policy.steps[policy.decisions.length];
  const decision = { actorId: env.who.id, actorCode: env.who.employee_code, stepOrder: step.stepOrder, action, reason, decidedAt: env.now.toISOString() };
  const next = { steps: policy.steps, decisions: [...policy.decisions, decision] };
  if (row.kind === 'REQUISITION') {
    await tx.requisitionApproval.create({ data: { tenantId: env.tenantId, requisitionId: Number(row.sourceRef), approverId: env.who.id, status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', comments: reason, decidedAt: env.now, stepOrder: step.stepOrder, role: step.role } });
    if (!policy.decisions.length) await tx.jobRequisition.update({ where: { id: Number(row.sourceRef) }, data: { approvalChainSnapshot: policy.steps } });
  } else {
    await tx.offerApproval.upsert({ where: { offerId_stage: { offerId: Number(row.sourceRef), stage: step.stage } }, create: { tenantId: env.tenantId, offerId: Number(row.sourceRef), stage: step.stage, approverId: env.who.id, decision: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason }, update: { approverId: env.who.id, decision: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason, decidedAt: env.now } });
  }
  return next;
}
export async function recruitmentDecided(tx, env, source, status, reason) {
  await recordRequisitionTransition(tx, { tenantId: env.tenantId, requisitionId: source.row.id, fromStatus: source.row.status, toStatus: status, reason, actorId: env.who.id, source: 'approval-centre' });
  await enqueueHrDomainEvent(tx, requisitionDecisionEvent({ ...source.row, tenantId: env.tenantId }, { actorId: env.who.id }, { decision: status, decidedById: env.who.id, requestedById: source.row.requestedById }));
}
