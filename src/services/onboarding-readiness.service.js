// src/services/onboarding-readiness.service.js
//
// Recruitment Phase 4 — day-one readiness. "Acceptance creates everything day
// one needs": this checks, a few days before each start date, that it really
// did, and alerts HR and the hiring manager when it did not.
//
//   runOnboardingReadinessJob   the daily pass (scheduled at 07:00). A SYSTEM
//       scan finds open checklists starting soon (ids and tenants only); per
//       tenant it reads the lead days and time zone; per checklist, under its
//       tenant, it computes the gaps (src/lib/onboarding-readiness.util.js),
//       stores the verdict, and when AT_RISK and not yet alerted during the
//       tenant's local day, claims the alert with a conditional update and
//       announces hr.onboarding.readiness_at_risk.v1 in the same transaction.
//       Re-running the same day recomputes the verdict and never re-alerts.
//   getOnboardingReadiness      hr_onboarding_readiness_get: the live
//       computation next to the stored verdict.
//   listOnboardingReadiness     hr_onboarding_readiness_list: upcoming starts
//       with their stored verdicts.
//
// The event carries ids and counts only (no names, no task titles); the gap
// titles stay on the checklist for the HR screens.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { liveSessionWhere } from "../lib/onboarding-sessions.util.js";
import {
    READINESS_STATUS,
    MAX_READINESS_LEAD_DAYS,
    computeReadinessGaps,
    countGapsByKind,
    daysUntilStart,
    isInReadinessWindow,
    localDayStartUtc,
    readinessVerdict,
    resolveHrOwnerId,
    resolveLeadDays,
    resolveTimeZone,
    startDateKey,
    storedGaps,
} from "../lib/onboarding-readiness.util.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const log = logger.child({ component: "onboarding-readiness" });

export const READINESS_AT_RISK_EVENT = "hr.onboarding.readiness_at_risk.v1";
export const OPEN_CHECKLIST_STATUSES = Object.freeze(["NOT_STARTED", "IN_PROGRESS", "OVERDUE"]);

export const DEFAULT_READINESS_LIMIT = 200;
const MAX_READINESS_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const assertEnabled = () => {
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) {
        throw fail("Onboarding automation is disabled", 503, "HR-ONBOARDING-AUTOMATION-DISABLED");
    }
};

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
};

const clampLimit = (limit, fallback = DEFAULT_READINESS_LIMIT, max = MAX_READINESS_LIMIT) => {
    const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : fallback;
    return n <= 0 ? fallback : Math.min(n, max);
};

const idStr = (v) => (v != null ? String(v) : null);

// ── Event ────────────────────────────────────────────────────────────────────

/** hr.onboarding.readiness_at_risk.v1 — ids, the start date and gap counts. */
export function readinessAtRiskEvent(checklist, { counts, totalGaps, daysUntil, hrOwnerId, managerId } = {}) {
    if (!checklist?.tenantId) return null;
    return {
        eventName: READINESS_AT_RISK_EVENT,
        tenantId: checklist.tenantId,
        aggregateType: "OnboardingChecklist",
        aggregateId: checklist.id,
        actorId: null,
        payload: {
            checklistId: String(checklist.id),
            employeeId: idStr(checklist.employeeId),
            startDate: startDateKey(checklist.startDate),
            daysUntilStart: daysUntil ?? null,
            totalGaps: Number(totalGaps) || 0,
            gapCounts: { ...counts },
            // The two recipients the Notification Hub routes the alert to.
            hrOwnerId: idStr(hrOwnerId),
            managerId: idStr(managerId),
        },
    };
}

// ── Loading and computing ────────────────────────────────────────────────────

const CHECKLIST_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    employeeId: true,
    startDate: true,
    status: true,
    memberAssignments: true,
    readinessStatus: true,
    readinessCheckedAt: true,
    readinessGaps: true,
    readinessAlertedAt: true,
});

/** Read one checklist's day-one inputs (separate reads: no relation filters). */
async function loadReadinessInputs(db, tenantId, checklistId) {
    const checklist = await db.onboardingChecklist.findFirst({
        where: withTenant(tenantId, { id: checklistId }),
        select: CHECKLIST_SELECT,
    });
    if (!checklist) return null;
    const byChecklist = withTenant(tenantId, { checklistId: checklist.id });
    const tasks = await db.onboardingTask.findMany({
        where: byChecklist,
        select: { id: true, title: true, stage: true, completed: true, dueDate: true, assigneeType: true, assigneeId: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    const provisioningRequests = await db.onboardingProvisioningRequest.findMany({
        where: byChecklist,
        select: { id: true, title: true, status: true, dueDate: true },
        orderBy: [{ id: "asc" }],
    });
    const documents = await db.onboardingDocument.findMany({
        where: byChecklist,
        select: { id: true, title: true, requiresSign: true, signedAt: true, reviewStatus: true },
        orderBy: [{ id: "asc" }],
    });
    const sessions = await db.onboardingSession.findMany({
        // A deleted session waiting for its invite to be cancelled is not live.
        where: { ...byChecklist, ...liveSessionWhere() },
        select: { id: true, title: true, required: true, sessionDate: true },
        orderBy: [{ id: "asc" }],
    });
    const employee = await db.employee.findFirst({
        where: { id: checklist.employeeId, tenant_id: tenantId },
        select: { id: true, managerId: true },
    });
    return { checklist, tasks, provisioningRequests, documents, sessions, employee };
}

function evaluate(inputs) {
    const gaps = computeReadinessGaps(inputs);
    return {
        gaps,
        counts: countGapsByKind(gaps),
        totalGaps: gaps.length,
        status: readinessVerdict(gaps),
        hrOwnerId: resolveHrOwnerId({ memberAssignments: inputs.checklist.memberAssignments, tasks: inputs.tasks }),
        managerId: inputs.employee?.managerId ?? null,
    };
}

async function tenantClock(tenantId) {
    const settings = await getRecruitmentSettings({ tenantId });
    return {
        leadDays: resolveLeadDays(settings?.onboardingReadinessLeadDays),
        timeZone: resolveTimeZone(settings?.timeZone),
    };
}

// ── The daily job ────────────────────────────────────────────────────────────

/** Check, store and (at most once a local day) alert one checklist. */
async function checkOne(tenantId, checklistId, { now, timeZone, leadDays }) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const inputs = await loadReadinessInputs(tx, tenantId, checklistId);
            if (!inputs || !OPEN_CHECKLIST_STATUSES.includes(inputs.checklist.status)) return "skipped";
            const { checklist } = inputs;
            if (!isInReadinessWindow({ startDate: checklist.startDate, now, timeZone, leadDays })) return "outOfWindow";

            const result = evaluate(inputs);
            await tx.onboardingChecklist.updateMany({
                where: withTenant(tenantId, { id: checklist.id }),
                data:{ readinessStatus: result.status, readinessCheckedAt: now, readinessGaps: storedGaps(result.gaps) },
            });
            if (result.status !== READINESS_STATUS.AT_RISK) return "ready";

            // Claim today's alert: only one pass per tenant-local day wins it.
            const dayStart = localDayStartUtc(now, timeZone);
            const claim = await tx.onboardingChecklist.updateMany({
                where: withTenant(tenantId, {
                    id: checklist.id,
                    OR: [{ readinessAlertedAt: null }, { readinessAlertedAt: { lt: dayStart } }],
                }),
                data: { readinessAlertedAt: now },
            });
            if (Number(claim?.count ?? 0) !== 1) return "atRisk";
            await enqueueHrDomainEvent(
                tx,
                readinessAtRiskEvent(
                    { ...checklist, tenantId: checklist.tenantId ?? tenantId },
                    { ...result, daysUntil: daysUntilStart(checklist.startDate, now, timeZone) },
                ),
            );
            return "alerted";
        },
        { tenantId },
    );
}

/**
 * The daily readiness pass. Idempotent (a second run the same day recomputes
 * and does not re-alert), one bad checklist never stops the run.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 * @returns {Promise<object>} counts per outcome, or { skipped: "FLAG_OFF" }
 */
export async function runOnboardingReadinessJob({ now = new Date(), limit } = {}) {
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const summary = { scanned: 0, ready: 0, atRisk: 0, alerted: 0, outOfWindow: 0, skipped: 0, failed: 0 };

    // A superset of every tenant's window (time zones put "today" up to a day
    // either side of UTC); each tenant's own window is applied per row.
    const rows = await mcpCtx.run({ system: true }, async () =>
        await prisma.onboardingChecklist.findMany({
            where: {
                tenantId: { not: null },
                status: { in: [...OPEN_CHECKLIST_STATUSES] },
                startDate: { gte: new Date(at.getTime() - 2 * DAY_MS), lte: new Date(at.getTime() + (MAX_READINESS_LEAD_DAYS + 2) * DAY_MS) },
            },
            select: { id: true, tenantId: true },
            orderBy: [{ startDate: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = rows.length;

    const byTenant = new Map();
    for (const row of rows) {
        if (!row.tenantId) continue;
        if (!byTenant.has(row.tenantId)) byTenant.set(row.tenantId, []);
        byTenant.get(row.tenantId).push(row.id);
    }

    for (const [tenantId, ids] of byTenant) {
        await mcpCtx.run({ user: { tenantId } }, async () => {
            let clock;
            try {
                clock = await tenantClock(tenantId);
            } catch (err) {
                summary.failed += ids.length;
                log.warn({ tenantId, errMessage: err?.message }, "onboarding readiness: settings unavailable, tenant skipped");
                return;
            }
            for (const id of ids) {
                try {
                    const outcome = await checkOne(tenantId, id, { now: at, ...clock });
                    summary[outcome] += 1;
                    if (outcome === "alerted") summary.atRisk += 1;
                } catch (err) {
                    summary.failed += 1;
                    log.warn({ tenantId, checklistId: id, code: err?.code, errMessage: err?.message }, "onboarding readiness: checklist failed");
                }
            }
        });
    }
    if (summary.scanned) log.info(summary, "onboarding readiness: pass done");
    return summary;
}

// ── Tools ────────────────────────────────────────────────────────────────────

const storedVerdict = (c) => ({
    status: c.readinessStatus ?? null,
    checkedAt: c.readinessCheckedAt ?? null,
    alertedAt: c.readinessAlertedAt ?? null,
    gaps: Array.isArray(c.readinessGaps) ? c.readinessGaps : [],
});

/** hr_onboarding_readiness_get — the live computation and the stored verdict. */
export async function getOnboardingReadiness({ tenantId, checklistId, now = new Date() } = {}) {
    requireTenant(tenantId);
    assertEnabled();
    const id = Number(checklistId);
    if (!Number.isInteger(id) || id <= 0) throw fail("Onboarding checklist not found", 404, "HR-ONBOARDING-NOT-FOUND");
    const at = new Date(now);
    const clock = await tenantClock(tenantId);
    return tenantTransaction(
        prisma,
        async (tx) => {
            const inputs = await loadReadinessInputs(tx, tenantId, id);
            if (!inputs) throw fail("Onboarding checklist not found", 404, "HR-ONBOARDING-NOT-FOUND");
            const { checklist } = inputs;
            const live = evaluate(inputs);
            return {
                checklistId: checklist.id,
                employeeId: checklist.employeeId,
                checklistStatus: checklist.status,
                startDate: startDateKey(checklist.startDate),
                daysUntilStart: daysUntilStart(checklist.startDate, at, clock.timeZone),
                leadDays: clock.leadDays,
                inWindow: isInReadinessWindow({ startDate: checklist.startDate, now: at, ...clock }),
                live: {
                    status: live.status,
                    totalGaps: live.totalGaps,
                    gapCounts: live.counts,
                    gaps: live.gaps,
                    hrOwnerId: live.hrOwnerId,
                    managerId: live.managerId,
                },
                stored: storedVerdict(checklist),
            };
        },
        { tenantId },
    );
}

const VERDICT_FILTERS = Object.freeze(["READY", "AT_RISK", "UNCHECKED"]);

const employeeName = (e) => {
    const full = [e?.first_name, e?.last_name].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
    return full || String(e?.employee_name ?? "").trim() || null;
};

/**
 * hr_onboarding_readiness_list — open checklists starting from today through
 * `days` ahead (default: the tenant's lead days), soonest first, with their
 * stored verdicts.
 */
export async function listOnboardingReadiness({ tenantId, days, status, limit, now = new Date() } = {}) {
    requireTenant(tenantId);
    assertEnabled();
    if (status != null && !VERDICT_FILTERS.includes(status)) {
        throw fail("status must be READY, AT_RISK or UNCHECKED", 400, "HR-ONBOARDING-READINESS-FILTER-INVALID");
    }
    const at = new Date(now);
    const clock = await tenantClock(tenantId);
    const horizon = days == null ? clock.leadDays : Math.min(Math.max(Math.floor(Number(days)) || 0, 0), 60);
    const dayStart = localDayStartUtc(at, clock.timeZone);
    const verdictWhere =
        status === "UNCHECKED" ? { readinessStatus: null } : status ? { readinessStatus: status } : {};

    return tenantTransaction(
        prisma,
        async (tx) => {
            const rows = await tx.onboardingChecklist.findMany({
                where: withTenant(tenantId, {
                    status: { in: [...OPEN_CHECKLIST_STATUSES] },
                    // Day-granular bounds widened by a day; the exact window is
                    // applied below with the tenant's calendar.
                    startDate: { gte: new Date(dayStart.getTime() - DAY_MS), lte: new Date(dayStart.getTime() + (horizon + 1) * DAY_MS) },
                    ...verdictWhere,
                }),
                select: CHECKLIST_SELECT,
                orderBy: [{ startDate: "asc" }, { id: "asc" }],
                take: clampLimit(limit, 50, 200),
            });
            const upcoming = rows
                .map((c) => ({ c, d: daysUntilStart(c.startDate, at, clock.timeZone) }))
                .filter(({ d }) => d !== null && d >= 0 && d <= horizon);
            const employeeIds = [...new Set(upcoming.map(({ c }) => c.employeeId))];
            const employees = employeeIds.length
                ? await tx.employee.findMany({
                    where: { id: { in: employeeIds }, tenant_id: tenantId },
                    select: { id: true, first_name: true, last_name: true, employee_name: true, managerId: true },
                })
                : [];
            const byId = new Map(employees.map((e) => [e.id, e]));
            const items = upcoming.map(({ c, d }) => {
                const v = storedVerdict(c);
                return {
                    checklistId: c.id,
                    employeeId: c.employeeId,
                    employeeName: employeeName(byId.get(c.employeeId)),
                    managerId: byId.get(c.employeeId)?.managerId ?? null,
                    startDate: startDateKey(c.startDate),
                    daysUntilStart: d,
                    readinessStatus: v.status,
                    readinessCheckedAt: v.checkedAt,
                    readinessAlertedAt: v.alertedAt,
                    gapCount: v.gaps.length,
                };
            });
            return { leadDays: clock.leadDays, days: horizon, items, total: items.length };
        },
        { tenantId },
    );
}
