// Attendance rule changes by approval (ATTENDANCE_RULE_CHANGE). HR files; the company's published ATTENDANCE route
// approves; only the final approval changes anything:
//   PUBLISH_SETUP    publishes the reviewed draft (policy, deduction rules, approval levels) as a release
//   GRACE_RULE       saves a grace period for a company, department, team, shift or employee from a date
//   GRACE_MEMBERSHIP puts an employee in a team or department for grace purposes from a date
// Each writes inside the approval's own transaction and re-queues attendance evaluation from the effective date,
// so an approved rule can never commit without its re-evaluation.
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { badSetup, dateKey } from '../lib/attendanceDates.js';
import { legacySubmit } from './approval/legacy.js';
import { buildAttendanceSetup, publishAttendanceSetup } from './attendanceSetup.service.js';
import { applyGraceRule, applyGraceMembership, assertRulesPeriodEditable } from './attendanceRules.service.js';

const ACTIONS = ['PUBLISH_SETUP', 'GRACE_RULE', 'GRACE_MEMBERSHIP'];
const PLUMBING = new Set(['id', 'tenantId', 'status', 'version', 'createdAt', 'updatedAt', 'created_at', 'updated_at']);
const words = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
const show = (v) => (v === null || v === undefined || v === '' ? 'not set' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const changesBetween = (before, after, label) => {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (PLUMBING.has(key)) continue;
    const a = before?.[key];
    const b = after?.[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(`${label}${words(key)}: ${show(a)} → ${show(b)}`);
  }
  return out;
};

/** What publishing would change against the release in force, in lines an approver can read. */
export async function describeSetupChanges(tenantId, tx, from) {
  const config = await buildAttendanceSetup(tenantId, tx);
  const effective = await tx.attendanceSetupRelease.findFirst({
    where: { tenantId, effectiveFrom: { lte: new Date(`${dateKey(from)}T00:00:00Z`) } },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });
  const old = effective?.config ?? {};
  const lines = changesBetween(old.policy, config.policy, 'Policy: ');
  const prior = new Map((old.deductionRules ?? []).map((r) => [r.ruleKey, r]));
  for (const rule of config.deductionRules ?? []) lines.push(...changesBetween(prior.get(rule.ruleKey), rule, `${words(rule.ruleKey)}: `));
  if (JSON.stringify(old.approvalLevels ?? null) !== JSON.stringify(config.approvalLevels ?? null)) lines.push('Approval levels changed');
  return lines;
}

async function file({ tenantId, requestedById, action, payload, reason, before }) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  if (!ACTIONS.includes(action)) throw badSetup('Unknown attendance rule action');
  const actor = Number(requestedById);
  if (!Number.isInteger(actor) || actor < 1) throw badSetup('Sign in with an employee account to request a rule change', 403);
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw badSetup('Give a reason for the rule change (at least 3 characters)');

  const row = await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:attendance-rule-change`}))`;
      const pending = await tx.attendanceRuleChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, select: { action: true, payload: true } });
      if (action === 'PUBLISH_SETUP' && pending.some((p) => p.action === 'PUBLISH_SETUP'))
        throw badSetup('A setup publication is already waiting for approval', 409);
      if (action !== 'PUBLISH_SETUP') {
        const same = (p) => p.action === action && p.payload?.scopeKey === payload.scopeKey && p.payload?.scope === payload.scope && p.payload?.employeeId === payload.employeeId;
        if (pending.some(same)) throw badSetup('This grace setting already has a change waiting for approval', 409);
      }
      // Refuse an impossible request now (readiness, payroll lock, stale draft, bad values), not at the last level.
      const prepared = await before?.(tx);
      return tx.attendanceRuleChangeRequest.create({
        data: { id: randomUUID(), tenantId, action, payload: { ...payload, ...(prepared ?? {}) }, reason: why, requestedById: actor },
      });
    },
    { tenantId },
  );
  try {
    await legacySubmit('ATTENDANCE_RULE_CHANGE', row.id, why, { onBehalf: true });
  } catch (error) {
    await prisma.attendanceRuleChangeRequest.deleteMany({ where: { id: row.id, tenantId, status: 'PENDING' } });
    throw error;
  }
  return { pendingApproval: true, requestId: row.id, action, status: 'PENDING', message: 'Sent for approval. The rules change when the approval route approves it.' };
}

export const requestAttendanceSetupPublish = ({ tenantId, requestedById, from, to, reason, previewToken }) =>
  file({
    tenantId, requestedById, action: 'PUBLISH_SETUP', reason,
    payload: { from: dateKey(from), to: dateKey(to), previewToken },
    before: async (tx) => {
      await publishAttendanceSetup({ tenantId, from, to, reason, previewToken, tx, dryRun: true });
      return { changes: await describeSetupChanges(tenantId, tx, from) };
    },
  });

export const requestGraceRule = ({ tenantId, requestedById, scope, scopeKey, effectiveFrom, checkInMinutes, checkOutMinutes, version, reason }) =>
  file({
    tenantId, requestedById, action: 'GRACE_RULE', reason,
    payload: { scope, scopeKey: scope === 'COMPANY' ? '*' : String(scopeKey).trim(), effectiveFrom: dateKey(effectiveFrom), checkInMinutes: checkInMinutes ?? null, checkOutMinutes: checkOutMinutes ?? null, version },
    before: async (tx) => {
      await assertRulesPeriodEditable(tx, tenantId, effectiveFrom);
      if (!['COMPANY', 'DEPARTMENT', 'TEAM', 'EMPLOYEE', 'SHIFT'].includes(scope) || !String(scopeKey ?? '').trim()) throw badSetup('Scope and key are required');
      for (const value of [checkInMinutes, checkOutMinutes])
        if (value != null && (!Number.isInteger(value) || value < 0 || value > 1440)) throw badSetup('Grace must be whole minutes from 0 to 1440, or blank to inherit');
      if (scope === 'EMPLOYEE' && !(await tx.employee.findFirst({ where: { id: Number(scopeKey), tenant_id: tenantId }, select: { id: true } }))) throw badSetup('Employee not found', 404);
      const old = await tx.attendanceGraceRule.findFirst({ where: { tenantId, scope, scopeKey: scope === 'COMPANY' ? '*' : String(scopeKey).trim(), effectiveFrom: new Date(`${dateKey(effectiveFrom)}T00:00:00Z`) } });
      if ((old?.version ?? -1) !== version) throw badSetup('Grace settings changed; refresh before saving', 409);
      return { before: old ? { checkInMinutes: old.checkInMinutes, checkOutMinutes: old.checkOutMinutes } : null };
    },
  });

export const requestGraceMembership = ({ tenantId, requestedById, employeeId, effectiveFrom, teamKey, departmentKey, version, reason }) =>
  file({
    tenantId, requestedById, action: 'GRACE_MEMBERSHIP', reason,
    payload: { employeeId: Number(employeeId), effectiveFrom: dateKey(effectiveFrom), teamKey: teamKey?.trim() || null, departmentKey: departmentKey?.trim() || null, version },
    before: async (tx) => {
      await assertRulesPeriodEditable(tx, tenantId, effectiveFrom);
      if (!(await tx.employee.findFirst({ where: { id: Number(employeeId), tenant_id: tenantId }, select: { id: true } }))) throw badSetup('Employee not found', 404);
      const old = await tx.attendanceGraceMembership.findFirst({ where: { tenantId, employeeId: Number(employeeId), effectiveFrom: new Date(`${dateKey(effectiveFrom)}T00:00:00Z`) } });
      if ((old?.version ?? -1) !== version) throw badSetup('Membership changed; refresh before saving', 409);
      return { before: old ? { teamKey: old.teamKey, departmentKey: old.departmentKey } : null };
    },
  });

// The approving transaction's identity for the writers that audit "who": the person who asked.
const asker = (env, row) => ({ tenantId: env.tenantId, employeeId: row.requestedById, userId: env.ctx?.user?.userId ?? row.requestedById });

/** Final approval: write inside the approval transaction, then record the decision on the request. */
export async function finalizeAttendanceRuleChange(tx, env, row, approved) {
  if (approved) {
    const p = row.payload ?? {};
    if (row.action === 'PUBLISH_SETUP') {
      try {
        await publishAttendanceSetup({
          tenantId: env.tenantId, from: p.from, to: p.to, reason: row.reason, previewToken: p.previewToken,
          publishedById: row.requestedById, tx,
        });
      } catch (error) {
        if (/changed since preview/i.test(error?.message ?? ''))
          throw badSetup('The draft rules changed after this request was filed. Reject it and file a new request.', 409);
        throw error;
      }
    } else if (row.action === 'GRACE_RULE') {
      await applyGraceRule(tx, asker(env, row), { ...p, reason: row.reason });
    } else if (row.action === 'GRACE_MEMBERSHIP') {
      await applyGraceMembership(tx, asker(env, row), { ...p, reason: row.reason });
    }
    await tx.payrollAuditLog.create({
      data: {
        tenantId: env.tenantId, action: 'ATTENDANCE_RULE_CHANGE_APPLIED',
        details: `Attendance rule change applied (${row.action}): ${row.reason}`,
        oldValues: null, newValues: { requestId: row.id, action: row.action, effectiveFrom: p.effectiveFrom ?? p.from ?? null },
      },
    });
  }
  await tx.attendanceRuleChangeRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}

/** Rule changes still waiting for the route, so the setup screens can show them. */
export async function listPendingRuleChanges({ tenantId }) {
  const rows = await prisma.attendanceRuleChangeRequest.findMany({ where: { tenantId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const people = await prisma.employee.findMany({
    where: { tenant_id: tenantId, id: { in: [...new Set(rows.map((r) => r.requestedById))] } },
    select: { id: true, employee_name: true, first_name: true, last_name: true },
  });
  const name = new Map(people.map((p) => [p.id, p.employee_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null]));
  return rows.map((r) => ({
    id: r.id, action: r.action, payload: r.payload, reason: r.reason,
    requestedByName: name.get(r.requestedById) ?? null, createdAt: r.createdAt,
  }));
}
