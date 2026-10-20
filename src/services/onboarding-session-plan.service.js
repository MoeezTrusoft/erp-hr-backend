// src/services/onboarding-session-plan.service.js
//
// Recruitment Phase 4 (plan 6.7 "Orientation scheduling") — the orientation
// and compliance sessions a new hire gets when the accepted-offer handoff
// creates their checklist, and the preview HR uses to check a template.
//
//   * createOrientationSessionsInTx runs INSIDE the handoff's transaction.
//     The sessions come from the tenant's default active template
//     (`sessions`), else the baseline (lib/onboarding-sessions.util.js), and
//     land on working days counted from the start date. It is idempotent on
//     the unique (checklistId, templateKey): a replay creates only what is
//     missing, and a concurrent replay's duplicate is skipped by the index.
//   * Each session's host is resolved from its assigneeType: HR = the hire's
//     recruiter (requisition.recruiterId), MANAGER = the employee's manager
//     (Employee.managerId, else the requisition's requester, who is the
//     hiring manager), BUDDY = the checklist's buddy when one is assigned,
//     NEW_HIRE = no host. An unresolved host is left empty for HR to fill.
//   * With onboarding automation and calendar sync both on, each new session
//     is marked PENDING CREATE for the calendar worker in the same write.
//   * hr.onboarding.sessions_scheduled.v1 (ids only) announces what was
//     created, in the same transaction.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
    SESSION_CALENDAR_ACTION,
    dateKey,
    isOnboardingCalendarEnabled,
    placeSessions,
    resolveSessionPlan,
    sessionCalendarMark,
    toCalendarDate,
    validateTemplateSessions,
} from "../lib/onboarding-sessions.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { findDefaultTemplate } from "./onboardingTemplate.service.js";

export const SESSIONS_SCHEDULED_EVENT = "hr.onboarding.sessions_scheduled.v1";

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const toId = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * hr.onboarding.sessions_scheduled.v1 — ids only (the hosts as routing ids,
 * so the hub can tell them); null without a tenant.
 */
export function onboardingSessionsScheduledEvent({ tenantId, checklistId, employeeId, sessionIds, assigneeIds = [], actorId = null } = {}) {
    if (!tenantId) return null;
    return {
        eventName: SESSIONS_SCHEDULED_EVENT,
        tenantId,
        aggregateType: "OnboardingChecklist",
        aggregateId: checklistId,
        actorId,
        payload: {
            checklistId: String(checklistId),
            employeeId: employeeId != null ? String(employeeId) : null,
            sessionIds: (sessionIds ?? []).map(String),
            assigneeIds: [...new Set((assigneeIds ?? []).filter((id) => id != null).map(String))],
        },
    };
}

// ── Host resolution ──────────────────────────────────────────────────────────

// The requisition behind the hire, read only when a session needs it.
async function requisitionOwners(tx, tenantId, offerId) {
    const id = toId(offerId);
    if (!id) return { recruiterId: null, requesterId: null };
    const offer = await tx.offer.findFirst({
        where: scopedWhere(tenantId, { id }),
        select: { jobRequisition: { select: { recruiterId: true, requestedById: true } } },
    });
    return {
        recruiterId: offer?.jobRequisition?.recruiterId ?? null,
        requesterId: offer?.jobRequisition?.requestedById ?? null,
    };
}

/**
 * One resolver per handoff: each lookup runs at most once, and only when a
 * session asks for that host.
 */
function hostResolver(tx, { tenantId, checklistId, employeeId, offerId, hrOwnerId, managerId }) {
    const memo = new Map();
    const once = (key, fn) => {
        if (!memo.has(key)) memo.set(key, fn());
        return memo.get(key);
    };
    const owners = () => once("owners", () => requisitionOwners(tx, tenantId, offerId));
    return async (assigneeType) => {
        switch (assigneeType) {
            case "HR":
                return toId(hrOwnerId) ?? (await owners()).recruiterId ?? null;
            case "MANAGER":
                return once("manager", async () => {
                    if (toId(managerId)) return toId(managerId);
                    const employee = await tx.employee.findFirst({
                        where: scopedEmployeeWhere(tenantId, { id: Number(employeeId) }),
                        select: { managerId: true },
                    });
                    return employee?.managerId ?? (await owners()).requesterId ?? null;
                });
            case "BUDDY":
                return once("buddy", async () => {
                    const buddy = await tx.onboardingBuddy.findFirst({
                        where: scopedWhere(tenantId, { checklistId: Number(checklistId) }),
                        select: { buddyId: true },
                    });
                    return buddy?.buddyId ?? null;
                });
            default:
                return null;
        }
    };
}

// ── The handoff step ─────────────────────────────────────────────────────────

/**
 * Create the hire's orientation and compliance sessions inside the caller's
 * transaction. Idempotent and cheap: one template read, one read of what
 * exists, one insert of what is missing.
 *
 * @param {object} tx a tenantTransaction client
 * @param {object} args
 * @param {string} args.tenantId
 * @param {number} args.checklistId
 * @param {number} args.employeeId
 * @param {Date|string} args.startDate  the hire date (day 0)
 * @param {Date} [args.now]
 * @param {number} [args.offerId]       the accepted offer (resolves the recruiter and hiring manager)
 * @param {number} [args.hrOwnerId]     overrides the recruiter as the HR host
 * @param {number} [args.managerId]     overrides the employee's manager
 * @param {number|string} [args.actorId]
 * @returns {Promise<{ created: number, existing: number, sessionIds: number[], source: string, templateId: number|null, calendarQueued: boolean, skipped?: string }>}
 */
export async function createOrientationSessionsInTx(
    tx,
    { tenantId, checklistId, employeeId, startDate, now = new Date(), offerId = null, hrOwnerId = null, managerId = null, actorId = null } = {},
) {
    const empty = { created: 0, existing: 0, sessionIds: [], source: null, templateId: null, calendarQueued: false };
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) return { ...empty, skipped: "FLAG_OFF" };
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    const checklist = toId(checklistId);
    if (!checklist) throw fail("A checklist id is required", 400, "HR-ONBOARDING-SESSION-CHECKLIST-REQUIRED");
    const start = toCalendarDate(startDate) ?? toCalendarDate(now);

    const template = await findDefaultTemplate(tx, tenantId);
    const plan = resolveSessionPlan(template);
    const base = { ...empty, source: plan.source, templateId: plan.templateId };
    if (!plan.sessions.length) return base;

    const keys = plan.sessions.map((s) => s.key);
    const present = await tx.onboardingSession.findMany({
        where: scopedWhere(tenantId, { checklistId: checklist, templateKey: { in: keys } }),
        select: { id: true, templateKey: true },
    });
    const have = new Set(present.map((s) => s.templateKey));
    const missing = placeSessions(plan.sessions.filter((s) => !have.has(s.key)), start);
    if (!missing.length) return { ...base, existing: present.length };

    const calendar = isOnboardingCalendarEnabled();
    const mark = calendar ? sessionCalendarMark(SESSION_CALENDAR_ACTION.CREATE, now) : {};
    const hostFor = hostResolver(tx, { tenantId, checklistId: checklist, employeeId, offerId, hrOwnerId, managerId });
    const rows = [];
    for (const s of missing) {
        rows.push({
            tenantId,
            checklistId: checklist,
            templateKey: s.key,
            title: s.title,
            sessionType: s.sessionType,
            sessionDate: s.sessionDate,
            fromTime: s.fromTime,
            toTime: s.toTime,
            location: s.location,
            required: Boolean(s.required),
            assigneeId: await hostFor(s.assigneeType),
            ...mark,
        });
    }
    // A concurrent replay that got there first is skipped by the unique index.
    await tx.onboardingSession.createMany({ data: rows, skipDuplicates: true });
    const created = await tx.onboardingSession.findMany({
        where: scopedWhere(tenantId, { checklistId: checklist, templateKey: { in: missing.map((s) => s.key) } }),
        select: { id: true, assigneeId: true },
        orderBy: { id: "asc" },
    });
    const sessionIds = created.map((s) => s.id);
    if (sessionIds.length) {
        const assigneeIds = created.map((s) => s.assigneeId);
        await enqueueHrDomainEvent(tx, onboardingSessionsScheduledEvent({ tenantId, checklistId: checklist, employeeId, sessionIds, assigneeIds, actorId }));
    }
    return { ...base, created: sessionIds.length, existing: present.length, sessionIds, calendarQueued: calendar && sessionIds.length > 0 };
}

// ── Preview (hr_onboarding_session_plan_preview) ─────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;
const WEEKDAYS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);

/**
 * What a template would create for a start date, without writing anything:
 * the default template, a named one (templateId, active or not), or a draft
 * list (sessions) HR is about to save.
 */
export async function previewOnboardingSessionPlan({ tenantId, startDate, templateId = null, sessions = undefined, baseline = false } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    const start = DATE_RE.test(String(startDate ?? "")) ? toCalendarDate(startDate) : null;
    if (!start) throw fail("startDate must be a date (YYYY-MM-DD)", 400, "HR-ONBOARDING-SESSION-START-INVALID");
    // Phase 6: baseline previews the built-in set, so it names no template
    // and no draft (one source per preview, never a silent pick).
    if (baseline === true && (templateId != null || (sessions !== undefined && sessions !== null))) {
        throw fail("Preview the baseline, a template or a draft list, not more than one", 400, "HR-ONBOARDING-SESSION-PREVIEW-SOURCE");
    }

    let plan;
    if (baseline === true) {
        // The built-in set, whatever the tenant's default template says.
        plan = resolveSessionPlan(null);
    } else if (sessions !== undefined && sessions !== null) {
        const verdict = validateTemplateSessions(sessions);
        if (!verdict.ok) {
            throw Object.assign(fail(`Invalid onboarding sessions: ${verdict.error}`, 422, "HR-ONBOARDING-TEMPLATE-INVALID"), {
                details: { reason: verdict.error },
            });
        }
        plan = { sessions: verdict.sessions, source: "DRAFT", templateId: null };
    } else if (templateId != null) {
        const id = toId(templateId);
        const template = id
            ? await prisma.onboardingChecklistTemplate.findFirst({ where: scopedWhere(tenantId, { id }), select: { id: true, sessions: true } })
            : null;
        if (!template) throw fail("Template not found", 404, "HR-ONBOARDING-TEMPLATE-NOT-FOUND");
        plan = resolveSessionPlan(template);
    } else {
        plan = resolveSessionPlan(await findDefaultTemplate(prisma, tenantId));
    }

    return {
        source: plan.source,
        templateId: plan.templateId,
        startDate: dateKey(start),
        automationEnabled: isRecruitmentFlagEnabled("onboardingAutomation"),
        calendarSyncEnabled: isOnboardingCalendarEnabled(),
        sessions: placeSessions(plan.sessions, start).map((s) => ({
            key: s.key,
            title: s.title,
            sessionType: s.sessionType,
            dayOffset: s.dayOffset,
            sessionDate: dateKey(s.sessionDate),
            weekday: s.sessionDate ? WEEKDAYS[s.sessionDate.getUTCDay()] : null,
            fromTime: s.fromTime,
            toTime: s.toTime,
            location: s.location,
            required: Boolean(s.required),
            assigneeType: s.assigneeType,
        })),
    };
}

export default { createOrientationSessionsInTx, previewOnboardingSessionPlan };
