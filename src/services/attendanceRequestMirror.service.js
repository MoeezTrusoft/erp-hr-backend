// MULTI-COMPANY-MIRROR-01 (plan §2 R1–R5, batch B-B) — an employee registered in
// two companies raises an attendance resolution request ONCE; the request is
// then raised in their other companies automatically, but ONLY when the two
// companies agree on the person, the device enrolment and the shift. Where they
// differ (Akash: HomeVision 07:30–15:00 on TTQ5261300360/200 vs JOC 16:00–16:30
// on A8LN181960262/9012, and JOC grace 15 / half-day 1440) each company stays
// independent — the operator's explicit rule.
//
// Detection is untouched: this only shares the *answer*. The target company
// must already have its own ACTIVE, unraised rules-v2 case of the same type on
// the same day; the mirror never invents evidence.
//
// Identity is `Employee.personId` (the Phase A anchor), never a login: Afsha has
// two RBAC logins on one employee record. Issue 420 — Habib 588 (Homenet) and
// 589 (HomeVision) had never been backfilled, so the pair was invisible to the
// mirror even though both records carry the same name and the same enrolment
// (`TTQ5261300360/309`). Two null-anchored records are now paired on that
// shared in-force enrolment plus an identical name, which is the strongest
// evidence available without the anchor.
//
// A login is still needed to FILE a request: the approval service resolves its
// actor through `Employee.userId`. A login-less sibling is therefore filed on
// the employee's behalf by that company's own HR (the named VERIFY approver of
// its published route), exactly as HR files for anyone without a login.
import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { payrollRegisterProfile } from "../lib/payrollRegisterProfiles.js";
import { mcpCtx } from "../lib/requestContext.js";
import { dateKey, dateOnly } from "../lib/attendanceDates.js";
import {
  assertAttendancePeriodOpen,
  attendanceTransaction,
} from "./attendancePeriod.service.js";
import { reconcileRulePayroll } from "./attendanceRulePayroll.service.js";
import { applyEvaluatedShifts } from "./attendanceWriter.service.js";

const KIND = "ATTENDANCE";
const RULES_VERSION = 2;
const INACTIVE = /inactive|terminated|exited|offboard|separated/i;
const MIRROR_CLAUSE = (from, to) =>
  `Raised in ${from} and mirrored to ${to} automatically (same person, device and shift).`;

const minute = (value) =>
  value == null ? null : Math.floor(new Date(value).getTime() / 60_000);

const patternOf = (schedule) => {
  const pattern = schedule?.schedule_pattern ?? null;
  if (!pattern || typeof pattern !== "object") return null;
  const shift =
    pattern.shift && typeof pattern.shift === "object" ? pattern.shift : {};
  return {
    from: shift.from ?? null,
    to: shift.to ?? null,
    crossesMidnight: Boolean(shift.crossesMidnight),
    offDays: Array.isArray(pattern.offDays)
      ? [...pattern.offDays].map(Number).sort((a, b) => a - b)
      : [],
  };
};

// A schedule reaches this module in two shapes: the pattern itself (the unit
// matrix below) and the WorkSchedule row that carries it in `schedule_pattern`
// (the live path). Normalise both here; reading `offDays` off the row threw on
// the first real raise (October 2026 backfill), after the dry run — which uses
// its own SQL — had already reported the pair as mirrorable.
const asPattern = (value) => {
  if (!value || typeof value !== "object") return null;
  return "schedule_pattern" in value ? patternOf(value) : value;
};

const samePattern = (a, b) => {
  const one = asPattern(a);
  const two = asPattern(b);
  if (!one || !two) return false;
  if (!Array.isArray(one.offDays) || !Array.isArray(two.offDays)) return false;
  return (
    one.from === two.from &&
    one.to === two.to &&
    one.crossesMidnight === two.crossesMidnight &&
    one.offDays.length === two.offDays.length &&
    one.offDays.every((day, index) => day === two.offDays[index])
  );
};

// A person can be enrolled on several devices that are ALL in force in one
// company — Shah Hasan has PECHS 9014 and Dalmia 9013 in both BOC and JOC — so
// "the biometric device is common" means the two in-force sets share a
// device, never that one arbitrary "latest" row matches. Comparing a single
// enrolment made the verdict depend on row order (found by the October dry run).
const enrolmentKey = (e) => `${e?.sn ?? ""}|${e?.deviceUserId ?? ""}`;
const enrolmentList = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const sharedEnrolment = (a, b) => {
  const keys = new Set(enrolmentList(a).map(enrolmentKey));
  return enrolmentList(b).some((e) => keys.has(enrolmentKey(e)));
};

// Pure comparison of one sibling record against the origin. Exported so the
// matrix can be unit-tested without a database (plan §5).
export function compareSibling({
  origin,
  sibling,
  targetCase,
  originEnrolment,
  targetEnrolment,
  originSchedule,
  targetSchedule,
  routePublished,
  alreadyRaised,
}) {
  if (!sibling) return { verdict: "skip", reason: "no record in that company" };
  if (sibling.id === origin.employeeId)
    return { verdict: "skip", reason: "same employee record" };
  if (sibling.inactive)
    return { verdict: "skip", reason: "not active that day" };
  // Issue 420 — a record with no login is still mirrorable: that company's HR
  // files it on the employee's behalf. Only when no HR account exists there
  // either is there nobody who could sign the request.
  if (!sibling.hasAccount && !sibling.hrActor)
    return {
      verdict: "skip",
      reason: "no login and no HR to raise it for them in that company",
    };
  if (!targetCase) return { verdict: "skip", reason: "no equivalent case" };
  if (alreadyRaised) return { verdict: "skip", reason: "already raised there" };
  if (!routePublished)
    return { verdict: "skip", reason: "approval route not published" };
  if (!sharedEnrolment(originEnrolment, targetEnrolment))
    return { verdict: "skip", reason: "device differs" };
  if (!samePattern(originSchedule, targetSchedule))
    return { verdict: "skip", reason: "shift differs" };
  if (
    minute(origin.expectedTime) !== minute(targetCase.expectedTime) ||
    minute(origin.actualTime) !== minute(targetCase.actualTime)
  )
    return { verdict: "skip", reason: "evidence differs" };
  return {
    verdict: "mirror",
    reason: "same person, device, shift and case",
    onBehalf: !sibling.hasAccount,
    hrActor: sibling.hasAccount ? null : sibling.hrActor,
  };
}

// "Syed  Habib Hussain Zaidi" and "syed habib hussain zaidi" are one person.
const normalizeName = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Issue 420 — sibling records to consider when the origin has no personId.
// Deliberately narrow: the pair must share an in-force enrolment (same device
// serial AND the same device user id, which is one biometric on that machine),
// carry the same name, and NEITHER may already be linked to a person. A record
// that is linked to someone else is never adopted.
// The pairing rule itself, exported for the matrix test: same name, neither
// record linked to a person, and the shared enrolment is in force for the day.
export function isUnlinkedTwin({ originEmployee, sibling, keys, enrolment }) {
  if (!sibling || sibling.id === originEmployee.id) return false;
  if (!sibling.tenant_id || sibling.tenant_id === originEmployee.tenant_id)
    return false;
  if (sibling.personId) return false;
  if (!keys.has(enrolmentKey(enrolment))) return false;
  const name = normalizeName(originEmployee.employee_name);
  return Boolean(name) && normalizeName(sibling.employee_name) === name;
}

async function siblingsByEnrolment(db, tenantId, originEmployee, day) {
  const mine = await enrolmentsInForce(db, tenantId, originEmployee.id, day);
  const keys = new Set(mine.map(enrolmentKey).filter((key) => !key.startsWith("|")));
  if (!keys.size) return [];
  const sns = [...new Set(mine.map((e) => e.sn).filter(Boolean))];
  const deviceUserIds = [
    ...new Set(mine.map((e) => e.deviceUserId).filter(Boolean)),
  ];
  if (!sns.length || !deviceUserIds.length) return [];
  const rows = await db.employeeDeviceEnrolment.findMany({
    where: {
      tenantId: { not: tenantId },
      sn: { in: sns },
      deviceUserId: { in: deviceUserIds },
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
    },
    select: {
      sn: true,
      deviceUserId: true,
      employee: {
        select: {
          id: true,
          tenant_id: true,
          userId: true,
          personId: true,
          status: true,
          employement_status: true,
          employee_name: true,
        },
      },
    },
    take: 100,
  });
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const sibling = row.employee;
    if (!sibling || seen.has(sibling.id)) continue;
    if (!isUnlinkedTwin({ originEmployee, sibling, keys, enrolment: row }))
      continue;
    seen.add(sibling.id);
    out.push(sibling);
  }
  return out;
}

// The actor who files a login-less employee's request: the named VERIFY
// approver of that company's published attendance route, when that person has a
// login. Nothing is invented — this is the same HR who verifies such requests.
async function resolveHrActor(db, tenantId, levels) {
  const list = Array.isArray(levels) ? levels : [];
  const verify =
    list.find((l) => l?.action === "VERIFY" && !l?.paused && l?.required) ??
    list.find((l) => l?.action === "VERIFY" && !l?.paused) ??
    null;
  const ids = (verify?.approverIds ?? []).map(Number).filter((id) => id > 0);
  if (!ids.length) return null;
  const hr = await db.employee.findFirst({
    where: {
      tenant_id: tenantId,
      id: { in: ids },
      userId: { not: null },
    },
    select: { id: true, userId: true },
  });
  return hr?.userId ? { employeeId: hr.id, userId: hr.userId } : null;
}

// Every sibling record of the same human, with the evidence the comparison
// needs. Runs in a SYSTEM context because it spans tenants; the writes below
// always run in the TARGET tenant's own context, never with a bypass.
async function collectSiblings({ tenantId, anomalyId }, db = prisma) {
  const origin = await db.attendanceAnomaly.findFirst({
    where: { tenantId, id: anomalyId },
  });
  if (!origin) return { origin: null, targets: [] };
  const originEmployee = await db.employee.findFirst({
    where: { id: origin.employeeId },
    select: {
      id: true,
      tenant_id: true,
      personId: true,
      employee_name: true,
      status: true,
      employement_status: true,
    },
  });
  if (!originEmployee) return { origin, targets: [] };

  const day = dateOnly(origin.date);
  const rows = originEmployee.personId
    ? await db.employee.findMany({
        where: {
          personId: originEmployee.personId,
          id: { not: origin.employeeId },
        },
        select: {
          id: true,
          tenant_id: true,
          userId: true,
          status: true,
          employement_status: true,
          employee_name: true,
        },
        orderBy: { id: "asc" },
      })
    : await siblingsByEnrolment(db, tenantId, originEmployee, day);
  // No anchor and no shared enrolment: the records are simply not known to be
  // one person, and the caller is told so rather than mirroring blind.
  if (!originEmployee.personId && !rows.length)
    return {
      origin,
      originEmployee,
      targets: [],
      skipped: [{ reason: "not linked as the same person" }],
    };

  const targets = [];
  for (const sibling of rows) {
    if (!sibling.tenant_id || sibling.tenant_id === tenantId) continue;
    const [
      cases,
      originEnrolment,
      targetEnrolment,
      originSchedule,
      targetSchedule,
      route,
    ] = await Promise.all([
      db.attendanceAnomaly.findMany({
        where: {
          tenantId: sibling.tenant_id,
          employeeId: sibling.id,
          date: day,
          type: origin.type,
          rulesVersion: RULES_VERSION,
          evidenceState: "ACTIVE",
          status: "PENDING",
        },
        orderBy: { id: "asc" },
      }),        enrolmentsInForce(db, tenantId, origin.employeeId, day),
        enrolmentsInForce(db, sibling.tenant_id, sibling.id, day),
      scheduleInForce(db, tenantId, origin.employeeId, day),
      scheduleInForce(db, sibling.tenant_id, sibling.id, day),
      db.approvalMatrix.findFirst({
        where: { tenantId: sibling.tenant_id, kind: KIND, status: "PUBLISHED" },
        select: { id: true, levels: true },
      }),
    ]);
    // Edge case 9: the §384 defect left duplicate ACTIVE cases of one type on
    // one day. Mirror into the oldest only, never into both.
    const targetCase = cases[0] ?? null;
    const alreadyRaised = targetCase
      ? Boolean(
          await db.hrApprovalRequest.findFirst({
            where: {
              tenantId: sibling.tenant_id,
              kind: KIND,
              sourceRef: `${targetCase.id}@${targetCase.factHash ?? ""}`,
            },
            select: { id: true },
          }),
        )
      : false;
    const verdict = compareSibling({
      origin,
      sibling: {
        id: sibling.id,
        hasAccount: sibling.userId != null,
        // Only looked up for a record that cannot file for itself.
        hrActor:
          sibling.userId == null
            ? await resolveHrActor(db, sibling.tenant_id, route?.levels)
            : null,
        inactive: INACTIVE.test(
          `${sibling.status ?? ""} ${sibling.employement_status ?? ""}`,
        ),
      },
      targetCase,
      originEnrolment,
      targetEnrolment,
      originSchedule,
      targetSchedule,
      routePublished: Boolean(route),
      alreadyRaised,
    });
    targets.push({
      tenantId: sibling.tenant_id,
      employeeId: sibling.id,
      userId: sibling.userId,
      employeeName: sibling.employee_name,
      caseId: targetCase?.id ?? null,
      factHash: targetCase?.factHash ?? null,
      ...verdict,
    });
  }
  return { origin, originEmployee, targets };
}

async function enrolmentsInForce(db, tenantId, employeeId, day) {
  return db.employeeDeviceEnrolment.findMany({
    where: {
      tenantId,
      employeeId,
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
    },
    select: { sn: true, deviceUserId: true, effectiveFrom: true },
    take: 20,
  });
}

async function scheduleInForce(db, tenantId, employeeId, day) {
  return db.workSchedule.findFirst({
    where: {
      tenantId,
      employeeId,
      effective_start_date: { lte: day },
      OR: [{ effective_end_date: null }, { effective_end_date: { gte: day } }],
    },
    orderBy: { effective_start_date: "desc" },
    select: { schedule_pattern: true, schedule_name: true },
  });
}

// Company names live in RBAC, not in erp-hr. The HR client is fail-soft: a null
// name only costs the wording of the reason clause, never the mirror. The real
// tenant ids always land on the row (originTenantId / mirrorGroupId) so the web
// can render the names from its own company list.
const companyName = (tenantId) =>
  payrollRegisterProfile(tenantId)?.companyName ?? null;

// The context the target company's own services see: that company, that
// employee's own account. `system` only lifts the tenant scope for the reads we
// already did — every write below runs through attendanceTransaction for the
// target tenant, so FORCE RLS still applies.
const targetCtx = ({ tenantId, userId, employeeId }) => ({
  system: true,
  actorVerified: true,
  permissions: ["hr.approvals.self"],
  user: {
    userId,
    employeeId,
    tenantId,
    isAdmin: false,
    roles: [],
  },
});

// Issue 420 — the employee has no login in the target company, so that
// company's HR files the request on their behalf. The context names the real HR
// user (the approval service resolves its actor through `userId`), and carries
// the verifier grant the on-behalf door re-asserts.
const onBehalfCtx = ({ tenantId, hrActor }) => ({
  system: true,
  actorVerified: true,
  permissions: ["hr.approvals.verify", "hr.approvals.self"],
  user: {
    userId: hrActor.userId,
    employeeId: hrActor.employeeId,
    tenantId,
    isAdmin: false,
    roles: ["HR"],
  },
});

export function isMirroring() {
  return Boolean(mcpCtx.getStore()?.mirroring);
}

// R1/R2/R4 — raise the request in every qualifying company. Best effort: a
// failure in one company is reported, never rolled back into the origin raise.
export async function mirrorRaise({ tenantId, anomalyId }, db = prisma) {
  const {
    origin,
    originEmployee,
    targets,
    skipped = [],
  } = await collectSiblings({ tenantId, anomalyId }, db);
  if (!origin) return { group: null, mirrored: [], notMirrored: skipped };
  if (skipped.length)
    return { group: null, mirrored: [], notMirrored: skipped };
  if (!targets.length) return { group: null, mirrored: [], notMirrored: [] };

  const from = companyName(tenantId) ?? "another company";
  const mirrored = [];
  const notMirrored = [];
  const group = origin.mirrorGroupId ?? randomUUID();
  // Stamp the origin first: a later failure half-way still leaves both rows
  // joinable by group, and only the origin carries originAnomalyId (null there).
  // Every write runs under an explicit tenant context: tenantScope.js appends
  // the AMBIENT tenant to the WHERE clause, so on a live raise (origin company
  // context) the target-company stamp below would silently match no row.
  await mcpCtx.run({ user: { tenantId } }, () =>
    db.attendanceAnomaly.updateMany({
      where: { tenantId, id: anomalyId, mirrorGroupId: null },
      data: { mirrorGroupId: group },
    }),
  );

  for (const target of targets) {
    if (target.verdict !== "mirror") {
      notMirrored.push({
        tenantId: target.tenantId,
        company: companyName(target.tenantId),
        reason: target.reason,
      });
      continue;
    }
    try {
      const { raiseRuleRequest, raiseRuleRequestOnBehalf } = await import(
        "./attendanceRules.service.js"
      );
      const to = companyName(target.tenantId) ?? "another company";
      const reason = [
        String(origin.reason ?? "").trim(),
        MIRROR_CLAUSE(from, to),
      ]
        .filter(Boolean)
        .join("\n\n");
      const ctx = target.onBehalf ? onBehalfCtx(target) : targetCtx(target);
      const record = await mcpCtx.run({ ...ctx, mirroring: true }, () =>
        target.onBehalf
          ? raiseRuleRequestOnBehalf({
              user: ctx.user,
              anomalyId: target.caseId,
              employeeId: target.employeeId,
              reason,
            })
          : raiseRuleRequest({
              user: ctx.user,
              anomalyId: target.caseId,
              reason,
              onBehalf: false,
            }),
      );
      await mcpCtx.run({ user: { tenantId: target.tenantId } }, () =>
        db.attendanceAnomaly.updateMany({
          where: { tenantId: target.tenantId, id: target.caseId },
          data: {
            originAnomalyId: origin.id,
            originTenantId: tenantId,
            mirrorGroupId: group,
            originRaisedByName:
              origin.raisedByName ?? originEmployee?.employee_name ?? null,
          },
        }),
      );
      mirrored.push({
        tenantId: target.tenantId,
        company: to,
        requestId: record?.approvalRef ?? null,
        anomalyId: target.caseId,
      });
    } catch (err) {
      notMirrored.push({
        tenantId: target.tenantId,
        company: companyName(target.tenantId),
        reason: err?.message ?? "mirror failed",
      });
    }
  }
  return { group: mirrored.length ? group : null, mirrored, notMirrored };
}

// R5/D2 — the first decision in the group is applied to members still pending.
// The sibling's own route already advanced it as far as its stage allowed; this
// does not re-route it (D5), it records the same outcome with its own audit row
// per company and flags a decision that lands after that company's payroll lock.
export async function mirrorDecision(
  { tenantId, anomalyId, decision, comment, deciderName, deductionDays },
  db = prisma,
) {
  const origin = await db.attendanceAnomaly.findFirst({
    where: { tenantId, id: anomalyId },
    select: { id: true, mirrorGroupId: true, date: true },
  });
  if (!origin?.mirrorGroupId) return { applied: [] };
  const siblings = await db.attendanceAnomaly.findMany({
    where: {
      mirrorGroupId: origin.mirrorGroupId,
      tenantId: { not: tenantId },
      status: "PENDING",
      evidenceState: "ACTIVE",
    },
    select: {
      id: true,
      tenantId: true,
      employeeId: true,
      factHash: true,
      date: true,
    },
  });
  const applied = [];
  for (const sibling of siblings) {
    const note =
      `${comment ?? ""}`.trim() +
      `\n\nDecided by ${deciderName ?? "the origin company"} (mirrored).`;
    // Payroll guard: decide anyway (the approval record must never dangle) but
    // flag it when that company's payroll already covers the day. The check runs
    // inside the write transaction so the shared period lock is held for it.
    let locked = false;
    await attendanceTransaction(db, sibling.tenantId, async (tx) => {
      try {
        await assertAttendancePeriodOpen(
          tx,
          sibling.tenantId,
          sibling.date,
          sibling.date,
        );
      } catch (err) {
        if (err?.status !== 409) throw err;
        locked = true;
      }
      await tx.attendanceAnomaly.updateMany({
        where: {
          tenantId: sibling.tenantId,
          id: sibling.id,
          status: "PENDING",
        },
        data: {
          status: decision,
          decidedAt: new Date(),
          reviewNote: note.trim(),
          decidedAfterPayrollLock: locked,
          // Management's explicit deduction follows the decision to the same
          // person's copy of the case in the other companies.
          ...(deductionDays != null
            ? { manualDeductionDays: deductionDays }
            : {}),
          workflowVersion: { increment: 1 },
        },
      });
      if (sibling.factHash)
        await tx.hrApprovalRequest.updateMany({
          where: {
            tenantId: sibling.tenantId,
            kind: KIND,
            sourceRef: `${sibling.id}@${sibling.factHash}`,
            stage: { notIn: ["APPROVED", "REJECTED", "WITHDRAWN"] },
          },
          data: {
            stage: decision,
            execution: "APPLIED",
            version: { increment: 1 },
          },
        });
      await tx.attendanceRuleAudit.create({
        data: {
          tenantId: sibling.tenantId,
          employeeId: sibling.employeeId,
          anomalyId: sibling.id,
          action: `MIRRORED_${decision}`,
          actorId: "system:mirror",
          data: {
            via: "linked-company",
            from: tenantId,
            decision,
            comment: comment ?? null,
            decidedAfterPayrollLock: locked,
          },
        },
      });
      // The decision must have the same effect there as here: price the case
      // again and re-evaluate that day. Skipped once that company's payroll
      // covers the day — the flag sends it to the payroll office instead of
      // silently changing a paid month.
      if (!locked) {
        try {
          await reconcileRulePayroll(tx, {
            tenantId: sibling.tenantId,
            employeeId: sibling.employeeId,
            date: sibling.date,
            actorId: "system:mirror",
          });
          await applyEvaluatedShifts({
            tenantId: sibling.tenantId,
            employeeIds: [sibling.employeeId],
            from: dateKey(sibling.date),
            to: dateKey(sibling.date),
            db: tx,
            dryRun: false,
            rulesReconciliation: true,
            trigger: "MIRRORED_DECISION",
          });
        } catch (err) {
          if (err?.status !== 409) throw err;
          locked = true;
          await tx.attendanceAnomaly.updateMany({
            where: { tenantId: sibling.tenantId, id: sibling.id },
            data: { decidedAfterPayrollLock: true },
          });
        }
      }
    });
    applied.push({
      tenantId: sibling.tenantId,
      anomalyId: sibling.id,
      decidedAfterPayrollLock: locked,
    });
  }
  return { applied };
}

// R5/D3 — withdrawing the origin withdraws only the mirrors that are still
// pending; a mirror already decided keeps its decision.
export async function withdrawMirrors({ tenantId, anomalyId }, db = prisma) {
  const origin = await db.attendanceAnomaly.findFirst({
    where: { tenantId, id: anomalyId },
    select: { id: true, mirrorGroupId: true },
  });
  if (!origin?.mirrorGroupId) return { withdrawn: [] };
  const siblings = await db.attendanceAnomaly.findMany({
    where: {
      mirrorGroupId: origin.mirrorGroupId,
      tenantId: { not: tenantId },
      status: "PENDING",
    },
    select: { id: true, tenantId: true, employeeId: true, factHash: true },
  });
  const withdrawn = [];
  for (const sibling of siblings) {
    await attendanceTransaction(db, sibling.tenantId, async (tx) => {
      await tx.hrApprovalRequest.updateMany({
        where: {
          tenantId: sibling.tenantId,
          kind: KIND,
          sourceRef: `${sibling.id}@${sibling.factHash ?? ""}`,
          stage: { notIn: ["APPROVED", "REJECTED", "WITHDRAWN"] },
        },
        data: {
          stage: "WITHDRAWN",
          execution: "APPLIED",
          version: { increment: 1 },
        },
      });
      // The case itself returns to unraised so the target company can still act.
      await tx.attendanceAnomaly.updateMany({
        where: { tenantId: sibling.tenantId, id: sibling.id },
        data: {
          reason: null,
          raisedById: null,
          raisedByName: null,
          workflowVersion: { increment: 1 },
        },
      });
      await tx.attendanceRuleAudit.create({
        data: {
          tenantId: sibling.tenantId,
          employeeId: sibling.employeeId,
          anomalyId: sibling.id,
          action: "MIRROR_WITHDRAWN",
          actorId: "system:mirror",
          data: { via: "origin-withdrawn", from: tenantId },
        },
      });
    });
    withdrawn.push({ tenantId: sibling.tenantId, anomalyId: sibling.id });
  }
  return { withdrawn };
}

// Best-effort wrapper used by the raise/decision/withdraw hooks: a mirror
// problem must never fail the caller's own action (plan §3.2).
export async function mirrorSafely(label, fn) {
  try {
    return await mcpCtx.run({ system: true }, () => fn());
  } catch (err) {
    logger.error({ err, label }, "attendance mirror failed");
    return null;
  }
}

// Issue 353b (operator, 2026-11-05) — an edited message follows the group. The
// sibling keeps its own "Raised in <A> and mirrored to <B> automatically …"
// clause and takes the origin's new text; its sealed request is re-sealed with
// the new digest so the sibling's approver can still decide it. Best effort per
// sibling: a failure there never fails the edit the employee made.
export function editedSiblingReason(currentReason, newReason) {
  const text = String(currentReason ?? "").trim();
  const at = text.indexOf("\n\nRaised in ");
  const clause = at >= 0 ? text.slice(at) : "";
  return `${String(newReason ?? "").trim()}${clause}`;
}

export async function mirrorEditReason(
  { tenantId, anomalyId, reason },
  db = prisma,
) {
  const origin = await db.attendanceAnomaly.findFirst({
    where: { tenantId, id: anomalyId },
    select: { id: true, mirrorGroupId: true },
  });
  if (!origin?.mirrorGroupId) return { edited: [], failed: [] };
  const siblings = await db.attendanceAnomaly.findMany({
    where: {
      mirrorGroupId: origin.mirrorGroupId,
      tenantId: { not: tenantId },
      status: "PENDING",
    },
    select: { id: true, tenantId: true, employeeId: true, factHash: true, reason: true },
  });
  const edited = [];
  const failed = [];
  const { loadSource } = await import("./approval/adapters.js");
  const { json } = await import("./approval/adapters.js");
  const { encryptString } = await import("../lib/crypto.js");
  const seal = (value) => ({
    sealed: encryptString(JSON.stringify(json(value))),
  });
  for (const sibling of siblings) {
    const nextReason = editedSiblingReason(sibling.reason, reason);
    if (nextReason.trim() === String(sibling.reason ?? "").trim()) continue;
    const ref = `${sibling.id}@${sibling.factHash ?? ""}`;
    try {
      await attendanceTransaction(db, sibling.tenantId, async (tx) => {
        const request = await tx.hrApprovalRequest.findFirst({
          where: {
            tenantId: sibling.tenantId,
            kind: KIND,
            sourceRef: ref,
            execution: "PENDING",
          },
          select: { id: true, round: true },
        });
        await tx.attendanceAnomaly.updateMany({
          where: { tenantId: sibling.tenantId, id: sibling.id, status: "PENDING" },
          data: { reason: nextReason, workflowVersion: { increment: 1 } },
        });
        if (request) {
          const resealed = await loadSource(
            tx,
            { tenantId: sibling.tenantId },
            KIND,
            ref,
          );
          await tx.hrApprovalRequest.update({
            where: { id: request.id },
            data: {
              version: { increment: 1 },
              sourceHash: resealed.digest,
              snapshot: seal(resealed.snapshot),
            },
          });
        }
        await tx.attendanceRuleAudit.create({
          data: {
            tenantId: sibling.tenantId,
            employeeId: sibling.employeeId,
            anomalyId: sibling.id,
            action: "REQUEST_EDITED",
            actorId: "system:mirror",
            data: json({
              before: sibling.reason,
              after: nextReason,
              approvalRef: request?.id ?? null,
              mirroredFrom: tenantId,
            }),
          },
        });
      });
      edited.push({
        tenantId: sibling.tenantId,
        anomalyId: sibling.id,
        requestId: null,
      });
    } catch (err) {
      failed.push({
        tenantId: sibling.tenantId,
        anomalyId: sibling.id,
        reason: err?.message ?? "mirror edit failed",
      });
    }
  }
  return { edited, failed };
}
