// src/services/onboarding-survey.service.js
//
// Recruitment Phase 4 — the 30/60/90 day onboarding surveys and their
// completion rates.
//
//   runOnboardingSurveyJob  the daily pass, two halves:
//     1. ISSUE: a SYSTEM scan finds checklists whose start date + 30, 60 or 90
//        days has passed (within a grace window, so an old checklist never
//        receives all three at once), drops the types already issued or
//        submitted and the employees who have left, and issues each missing
//        survey under its tenant: one row per checklist and type (the unique
//        key makes a concurrent pass a duplicate, not a second survey),
//        issuedAt now, due a week later, hr.onboarding.survey_issued.v1 to the
//        employee in the same transaction.
//     2. REMIND: an issued, unsubmitted survey two days from its due time is
//        reminded once (a conditional claim on remindedAt), with
//        hr.onboarding.survey_reminder.v1.
//   getOnboardingSurveyCompletion  hr_onboarding_survey_completion_get:
//     completion per survey type per start-date cohort month.
//
// Events carry ids and times only; a survey's responses never leave this
// service (the submit path already announces survey_submitted).
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
    SURVEY_ISSUE_GRACE_DAYS,
    SURVEY_REMINDER_LEAD_DAYS,
    SURVEY_SCHEDULE,
    dueSurveyTypes,
    employeeHasLeft,
    shouldRemindSurvey,
    surveyCompletion,
    surveyDueAt,
} from "../lib/onboarding-readiness.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const log = logger.child({ component: "onboarding-survey" });

export const SURVEY_ISSUED_EVENT = "hr.onboarding.survey_issued.v1";
export const SURVEY_REMINDER_EVENT = "hr.onboarding.survey_reminder.v1";

export const DEFAULT_SURVEY_LIMIT = 200;
const MAX_SURVEY_LIMIT = 1000;
// Checklists considered per pass. The window is bounded (start dates in the
// last 120 days), so this only caps a pathological backlog.
const SCAN_CAP = 2000;
const IN_CHUNK = 500;
const COMPLETION_CAP = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const clampLimit = (limit) => {
    const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : DEFAULT_SURVEY_LIMIT;
    return n <= 0 ? DEFAULT_SURVEY_LIMIT : Math.min(n, MAX_SURVEY_LIMIT);
};

const idStr = (v) => (v != null ? String(v) : null);
const iso = (v) => (v ? new Date(v).toISOString() : null);

const chunks = (list, size = IN_CHUNK) => {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
};

// ── Events ───────────────────────────────────────────────────────────────────

function surveyEvent(eventName, survey, extra = {}) {
    if (!survey?.tenantId) return null;
    return {
        eventName,
        tenantId: survey.tenantId,
        aggregateType: "OnboardingSurvey",
        aggregateId: survey.id,
        actorId: null,
        payload: {
            surveyId: String(survey.id),
            checklistId: idStr(survey.checklistId),
            employeeId: idStr(survey.employeeId),
            // The new hire answers their own survey: they are the recipient.
            recipientId: idStr(survey.employeeId),
            surveyType: survey.type ?? null,
            issuedAt: iso(survey.issuedAt),
            dueAt: iso(survey.dueAt),
            ...extra,
        },
    };
}

/** hr.onboarding.survey_issued.v1 — to the employee. */
export const surveyIssuedEvent = (survey) => surveyEvent(SURVEY_ISSUED_EVENT, survey);

/** hr.onboarding.survey_reminder.v1 — to the employee, once. */
export const surveyReminderEvent = (survey) => surveyEvent(SURVEY_REMINDER_EVENT, survey, { remindedAt: iso(survey?.remindedAt) });

// ── Issue ────────────────────────────────────────────────────────────────────

const EMPLOYEE_STATUS_SELECT = Object.freeze({ id: true, status: true, employement_status: true, separatedAt: true });
const SURVEY_SELECT = Object.freeze({
    id: true, tenantId: true, checklistId: true, employeeId: true, type: true,
    issuedAt: true, dueAt: true, remindedAt: true, submittedAt: true,
});

const isUniqueConflict = (err) => err?.code === "P2002";

/** The (checklist, type) pairs the pass should issue, from a SYSTEM read. */
async function findIssueCandidates(now, summary) {
    const latestStart = new Date(now.getTime() - SURVEY_SCHEDULE[0].days * DAY_MS);
    const earliestStart = new Date(now.getTime() - (SURVEY_SCHEDULE[SURVEY_SCHEDULE.length - 1].days + SURVEY_ISSUE_GRACE_DAYS + 1) * DAY_MS);
    return mcpCtx.run({ system: true }, async () => {
        const checklists = await prisma.onboardingChecklist.findMany({
            where: { tenantId: { not: null }, startDate: { gte: earliestStart, lte: latestStart } },
            select: { id: true, tenantId: true, employeeId: true, startDate: true },
            orderBy: [{ startDate: "asc" }, { id: "asc" }],
            take: SCAN_CAP,
        });
        if (!checklists.length) return [];

        const settled = new Map();
        for (const ids of chunks(checklists.map((c) => c.id))) {
            const surveys = await prisma.onboardingSurvey.findMany({
                where: { checklistId: { in: ids } },
                select: { checklistId: true, type: true, issuedAt: true, submittedAt: true },
            });
            for (const s of surveys) {
                if (s.issuedAt || s.submittedAt) settled.set(`${s.checklistId}|${s.type}`, true);
            }
        }
        const employees = new Map();
        for (const ids of chunks([...new Set(checklists.map((c) => c.employeeId))])) {
            const rows = await prisma.employee.findMany({ where: { id: { in: ids } }, select: EMPLOYEE_STATUS_SELECT });
            for (const e of rows) employees.set(e.id, e);
        }

        const pairs = [];
        for (const c of checklists) {
            const { due, stale } = dueSurveyTypes(c.startDate, now);
            const open = due.filter((type) => !settled.has(`${c.id}|${type}`));
            summary.stale += stale.filter((type) => !settled.has(`${c.id}|${type}`)).length;
            if (!open.length) continue;
            if (employeeHasLeft(employees.get(c.employeeId))) {
                summary.skippedLeft += open.length;
                continue;
            }
            for (const type of open) pairs.push({ ...c, type });
        }
        return pairs;
    });
}

/** Issue one survey under its tenant. Returns the outcome label. */
async function issueOne({ tenantId, id: checklistId, employeeId, type }, now) {
    try {
        return await tenantTransaction(
            prisma,
            async (tx) => {
                const employee = await tx.employee.findFirst({
                    where: { id: employeeId, tenant_id: tenantId },
                    select: EMPLOYEE_STATUS_SELECT,
                });
                if (employeeHasLeft(employee)) return "skippedLeft";
                const dueAt = surveyDueAt(now);
                const existing = await tx.onboardingSurvey.findFirst({
                    where: withTenant(tenantId, { checklistId, type }),
                    select: SURVEY_SELECT,
                });
                let survey;
                if (!existing) {
                    survey = await tx.onboardingSurvey.create({
                        data: scopedData(tenantId, { checklistId, employeeId, type, issuedAt: now, dueAt }),
                        select: SURVEY_SELECT,
                    });
                } else {
                    // A row nobody issued or answered yet (written by another
                    // path) is issued in place.
                    const claim = await tx.onboardingSurvey.updateMany({
                        where: withTenant(tenantId, { id: existing.id, issuedAt: null, submittedAt: null }),
                        data: { issuedAt: now, dueAt },
                    });
                    if (Number(claim?.count ?? 0) !== 1) return "duplicate";
                    survey = { ...existing, issuedAt: now, dueAt };
                }
                await enqueueHrDomainEvent(tx, surveyIssuedEvent({ ...survey, tenantId: survey.tenantId ?? tenantId }));
                return "issued";
            },
            { tenantId },
        );
    } catch (err) {
        // A concurrent pass created it first: the unique key held.
        if (isUniqueConflict(err)) return "duplicate";
        throw err;
    }
}

// ── Remind ───────────────────────────────────────────────────────────────────

async function findReminderCandidates(now, limit) {
    return mcpCtx.run({ system: true }, async () =>
        await prisma.onboardingSurvey.findMany({
            where: {
                tenantId: { not: null },
                issuedAt: { not: null },
                submittedAt: null,
                remindedAt: null,
                dueAt: { gt: now, lte: new Date(now.getTime() + SURVEY_REMINDER_LEAD_DAYS * DAY_MS) },
            },
            select: { id: true, tenantId: true },
            orderBy: [{ dueAt: "asc" }, { id: "asc" }],
            take: limit,
        }),
    );
}

async function remindOne(tenantId, surveyId, now) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const survey = await tx.onboardingSurvey.findFirst({ where: withTenant(tenantId, { id: surveyId }), select: SURVEY_SELECT });
            if (!survey || !shouldRemindSurvey(survey, now)) return "duplicate";
            const employee = await tx.employee.findFirst({
                where: { id: survey.employeeId, tenant_id: tenantId },
                select: EMPLOYEE_STATUS_SELECT,
            });
            if (employeeHasLeft(employee)) return "skippedLeft";
            const claim = await tx.onboardingSurvey.updateMany({
                where: withTenant(tenantId, { id: survey.id, remindedAt: null, submittedAt: null }),
                data: { remindedAt: now },
            });
            if (Number(claim?.count ?? 0) !== 1) return "duplicate";
            await enqueueHrDomainEvent(tx, surveyReminderEvent({ ...survey, tenantId: survey.tenantId ?? tenantId, remindedAt: now }));
            return "reminded";
        },
        { tenantId },
    );
}

// ── The daily job ────────────────────────────────────────────────────────────

const groupByTenant = (rows) => {
    const map = new Map();
    for (const row of rows) {
        if (!row.tenantId) continue;
        if (!map.has(row.tenantId)) map.set(row.tenantId, []);
        map.get(row.tenantId).push(row);
    }
    return map;
};

/**
 * The daily survey pass: issue what is due, then remind what closes soon.
 * Idempotent, safe to overlap, one bad row never stops the run.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 * @returns {Promise<object>} counts per outcome, or { skipped: "FLAG_OFF" }
 */
export async function runOnboardingSurveyJob({ now = new Date(), limit } = {}) {
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const max = clampLimit(limit);
    const summary = { scanned: 0, issued: 0, reminded: 0, duplicate: 0, skippedLeft: 0, stale: 0, failed: 0 };

    const pairs = (await findIssueCandidates(at, summary)).slice(0, max);
    const reminders = await findReminderCandidates(at, max);
    summary.scanned = pairs.length + reminders.length;

    for (const [tenantId, rows] of groupByTenant(pairs)) {
        await mcpCtx.run({ user: { tenantId } }, async () => {
            for (const row of rows) {
                try {
                    summary[await issueOne(row, at)] += 1;
                } catch (err) {
                    summary.failed += 1;
                    log.warn({ tenantId, checklistId: row.id, surveyType: row.type, code: err?.code, errMessage: err?.message }, "onboarding survey: issue failed");
                }
            }
        });
    }
    for (const [tenantId, rows] of groupByTenant(reminders)) {
        await mcpCtx.run({ user: { tenantId } }, async () => {
            for (const row of rows) {
                try {
                    summary[await remindOne(tenantId, row.id, at)] += 1;
                } catch (err) {
                    summary.failed += 1;
                    log.warn({ tenantId, surveyId: row.id, code: err?.code, errMessage: err?.message }, "onboarding survey: reminder failed");
                }
            }
        });
    }
    if (summary.scanned) log.info(summary, "onboarding survey: pass done");
    return summary;
}

// ── Completion (hr_onboarding_survey_completion_get) ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

function parseBound(value, name, endOfRange) {
    if (value == null || value === "") return null;
    const text = String(value).trim();
    if (DATE_RE.test(text)) {
        const [y, m, d] = text.split("-").map(Number);
        if (d === undefined) {
            // A month: its first day, or (as an upper bound) its last instant.
            return endOfRange ? new Date(Date.UTC(y, m, 1) - 1) : new Date(Date.UTC(y, m - 1, 1));
        }
        const day = new Date(Date.UTC(y, m - 1, d));
        if (day.getUTCMonth() !== m - 1) throw fail(`${name} is not a valid date`, 400, "HR-ONBOARDING-SURVEY-RANGE-INVALID");
        return endOfRange ? new Date(day.getTime() + DAY_MS - 1) : day;
    }
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw fail(`${name} must be a date (YYYY-MM-DD or YYYY-MM)`, 400, "HR-ONBOARDING-SURVEY-RANGE-INVALID");
    return parsed;
}

/**
 * Completion rate per survey type per start-date cohort month. `from` / `to`
 * bound the START DATE (the cohort), YYYY-MM-DD or YYYY-MM; the default is
 * the last twelve months.
 */
export async function getOnboardingSurveyCompletion({ tenantId, from, to, now = new Date() } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    if (!isRecruitmentFlagEnabled("onboardingAutomation")) {
        throw fail("Onboarding automation is disabled", 503, "HR-ONBOARDING-AUTOMATION-DISABLED");
    }
    const at = new Date(now);
    const end = parseBound(to, "to", true) ?? at;
    const start = parseBound(from, "from", false) ?? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
    if (start.getTime() > end.getTime()) throw fail("from must not be after to", 400, "HR-ONBOARDING-SURVEY-RANGE-INVALID");

    return tenantTransaction(
        prisma,
        async (tx) => {
            const checklists = await tx.onboardingChecklist.findMany({
                where: withTenant(tenantId, { startDate: { gte: start, lte: end } }),
                select: { id: true, startDate: true },
                orderBy: [{ startDate: "asc" }, { id: "asc" }],
                take: COMPLETION_CAP,
            });
            const startOf = new Map(checklists.map((c) => [c.id, c.startDate]));
            const rows = [];
            for (const ids of chunks(checklists.map((c) => c.id))) {
                const surveys = await tx.onboardingSurvey.findMany({
                    where: withTenant(tenantId, { checklistId: { in: ids } }),
                    select: { checklistId: true, type: true, issuedAt: true, dueAt: true, submittedAt: true },
                });
                for (const s of surveys) rows.push({ ...s, startDate: startOf.get(s.checklistId) });
            }
            const result = surveyCompletion(rows, at);
            return {
                from: start.toISOString(),
                to: end.toISOString(),
                checklists: checklists.length,
                truncated: checklists.length === COMPLETION_CAP,
                ...result,
            };
        },
        { tenantId },
    );
}
