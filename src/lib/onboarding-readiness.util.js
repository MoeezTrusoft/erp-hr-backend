// src/lib/onboarding-readiness.util.js
//
// Recruitment Phase 4 — the pure rules behind day-one readiness, the 30/60/90
// day surveys and their completion rates. No database, no clock of its own:
// the services load rows and pass `now` and the tenant's time zone in, so
// every rule here is deterministic and unit-tested on its own.
//
// Readiness: a new hire is READY for day one when nothing that has to happen
// before they walk in is still open. The gap kinds, in the order HR reads them:
//   TASK          a pre_joining or pre_boarding checklist task not completed
//   PROVISIONING  an IT provisioning request not FULFILLED (a CANCELLED one is
//                 no longer needed, so it is not a gap)
//   SIGNATURE     a document that requires a signature and is not signed
//   UPLOAD_REVIEW a document whose review is still PENDING (the new hire's
//                 own uploads through the self portal)
//   SESSION       a required orientation or compliance session with no date
// Any gap makes the checklist AT_RISK.
//
// Day arithmetic: a start date is a calendar date (stored as midnight UTC), so
// its UTC fields are the day; "today" is the tenant-local date of `now`. The
// readiness window is today .. today + leadDays, inclusive.
import { toDateKey, zonedDate, zonedTimeToUtc, isValidTimeZone } from "./slot-finder.util.js";

export const READINESS_STATUS = Object.freeze({ READY: "READY", AT_RISK: "AT_RISK" });

export const READINESS_GAP_KIND = Object.freeze({
    TASK: "TASK",
    PROVISIONING: "PROVISIONING",
    SIGNATURE: "SIGNATURE",
    UPLOAD_REVIEW: "UPLOAD_REVIEW",
    SESSION: "SESSION",
});

// The keys of the per-kind counts an event and the tools carry.
const COUNT_KEYS = Object.freeze({
    TASK: "tasks",
    PROVISIONING: "provisioning",
    SIGNATURE: "signatures",
    UPLOAD_REVIEW: "uploads",
    SESSION: "sessions",
});

export const PRE_START_STAGES = Object.freeze(["pre_joining", "pre_boarding"]);
const SETTLED_PROVISIONING = Object.freeze(["FULFILLED", "CANCELLED"]);

export const DEFAULT_READINESS_LEAD_DAYS = 2;
export const MAX_READINESS_LEAD_DAYS = 14;
const DEFAULT_TIME_ZONE = "Asia/Karachi";

// The stored gap list is bounded; the counts always cover every gap.
export const MAX_STORED_GAPS = 100;
const TITLE_MAX = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

const isoOrNull = (v) => {
    if (v == null) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const gap = (kind, row, title) => ({
    kind,
    id: row?.id ?? null,
    title: String(title ?? "").slice(0, TITLE_MAX) || null,
    dueDate: isoOrNull(row?.dueDate ?? row?.sessionDate ?? null),
});

/**
 * Every gap between a checklist and day one.
 * @param {{ tasks?: object[], provisioningRequests?: object[], documents?: object[], sessions?: object[] }} input
 * @returns {{ kind: string, id: number|null, title: string|null, dueDate: string|null }[]}
 */
export function computeReadinessGaps({ tasks = [], provisioningRequests = [], documents = [], sessions = [] } = {}) {
    const gaps = [];
    for (const t of tasks) {
        if (PRE_START_STAGES.includes(String(t?.stage ?? "")) && !t?.completed) {
            gaps.push(gap(READINESS_GAP_KIND.TASK, t, t.title));
        }
    }
    for (const p of provisioningRequests) {
        if (!SETTLED_PROVISIONING.includes(String(p?.status ?? ""))) {
            gaps.push(gap(READINESS_GAP_KIND.PROVISIONING, p, p.title));
        }
    }
    for (const d of documents) {
        if (d?.requiresSign && !d?.signedAt) gaps.push(gap(READINESS_GAP_KIND.SIGNATURE, d, d.title));
    }
    for (const d of documents) {
        if (d?.reviewStatus === "PENDING") gaps.push(gap(READINESS_GAP_KIND.UPLOAD_REVIEW, d, d.title));
    }
    for (const s of sessions) {
        if (s?.required && !s?.sessionDate) gaps.push({ ...gap(READINESS_GAP_KIND.SESSION, s, s.title), dueDate: null });
    }
    return gaps;
}

/** { tasks, provisioning, signatures, uploads, sessions } — always all five keys. */
export function countGapsByKind(gaps = []) {
    const counts = Object.fromEntries(Object.values(COUNT_KEYS).map((k) => [k, 0]));
    for (const g of gaps) {
        const key = COUNT_KEYS[g?.kind];
        if (key) counts[key] += 1;
    }
    return counts;
}

export const readinessVerdict = (gaps = []) =>
    gaps.length ? READINESS_STATUS.AT_RISK : READINESS_STATUS.READY;

/** The list persisted on the checklist: bounded, in rule order. */
export const storedGaps = (gaps = []) => gaps.slice(0, MAX_STORED_GAPS);

// ── Days and windows ─────────────────────────────────────────────────────────

export const resolveTimeZone = (timeZone) => (isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE);

export function resolveLeadDays(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return DEFAULT_READINESS_LEAD_DAYS;
    return Math.min(n, MAX_READINESS_LEAD_DAYS);
}

const utcDate = (instant) => {
    const d = new Date(instant);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const dayNumber = ({ year, month, day }) => Date.UTC(year, month - 1, day) / DAY_MS;

/** Whole calendar days from the tenant's today to the start date (0 = starts today). */
export function daysUntilStart(startDate, now, timeZone) {
    if (startDate == null || Number.isNaN(new Date(startDate).getTime())) return null;
    return dayNumber(utcDate(startDate)) - dayNumber(zonedDate(now, resolveTimeZone(timeZone)));
}

/** Is the start date within today .. today + leadDays (tenant-local)? */
export function isInReadinessWindow({ startDate, now, timeZone, leadDays }) {
    const days = daysUntilStart(startDate, now, timeZone);
    return days !== null && days >= 0 && days <= resolveLeadDays(leadDays);
}

/** The UTC instant the tenant's current local day began. */
export function localDayStartUtc(now, timeZone) {
    const zone = resolveTimeZone(timeZone);
    return zonedTimeToUtc({ ...zonedDate(now, zone), hour: 0, minute: 0 }, zone);
}

/** Was HR already alerted during the tenant's current local day? */
export function alertedToday(alertedAt, now, timeZone) {
    if (!alertedAt) return false;
    return new Date(alertedAt).getTime() >= localDayStartUtc(now, timeZone).getTime();
}

/** The start date as a YYYY-MM-DD calendar date. */
export const startDateKey = (startDate) => (startDate == null ? null : toDateKey(utcDate(startDate)));

// ── Routing ──────────────────────────────────────────────────────────────────

const HR_ROLE_RE = /^(hr|hr[\s_-]?(owner|manager|partner|lead|admin|generalist)|hrbp|people[\s_-]?(ops|partner))$/i;

const positiveId = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The HR person who owns the checklist: an HR member on the checklist's team,
 * else the assignee of its first HR task that has one. Null when neither
 * exists (the Notification Hub then routes to the tenant's HR role).
 */
export function resolveHrOwnerId({ memberAssignments, tasks = [] } = {}) {
    const members = Array.isArray(memberAssignments) ? memberAssignments : [];
    for (const m of members) {
        const id = positiveId(m?.employeeId);
        if (id && HR_ROLE_RE.test(String(m?.role ?? "").trim())) return id;
    }
    const ordered = [...tasks].sort((a, b) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0) || (a?.id ?? 0) - (b?.id ?? 0));
    for (const t of ordered) {
        const id = positiveId(t?.assigneeId);
        if (id && t?.assigneeType === "HR") return id;
    }
    return null;
}

// ── Surveys ──────────────────────────────────────────────────────────────────

export const SURVEY_SCHEDULE = Object.freeze([
    Object.freeze({ type: "DAY_30", days: 30 }),
    Object.freeze({ type: "DAY_60", days: 60 }),
    Object.freeze({ type: "DAY_90", days: 90 }),
]);
export const SURVEY_TYPES = Object.freeze(SURVEY_SCHEDULE.map((s) => s.type));

// A survey is open for a week after it is issued and reminded once two days
// before it closes.
export const SURVEY_DUE_DAYS = 7;
export const SURVEY_REMINDER_LEAD_DAYS = 2;
// A survey whose trigger day passed more than this long ago is not issued
// late: it keeps a checklist that predates the job (or a long outage) from
// receiving all three surveys at once.
export const SURVEY_ISSUE_GRACE_DAYS = 30;

const addDaysMs = (instant, days) => new Date(new Date(instant).getTime() + days * DAY_MS);

export const surveyTriggerAt = (startDate, days) => addDaysMs(startDate, days);
export const surveyDueAt = (issuedAt) => addDaysMs(issuedAt, SURVEY_DUE_DAYS);

/**
 * The survey types whose trigger day (start + 30/60/90 days) has passed and
 * that are still inside the issue grace window.
 * @returns {{ due: string[], stale: string[] }}
 */
export function dueSurveyTypes(startDate, now) {
    const due = [];
    const stale = [];
    if (startDate == null || Number.isNaN(new Date(startDate).getTime())) return { due, stale };
    const at = new Date(now).getTime();
    for (const { type, days } of SURVEY_SCHEDULE) {
        const trigger = surveyTriggerAt(startDate, days).getTime();
        if (trigger > at) continue;
        if (at - trigger > SURVEY_ISSUE_GRACE_DAYS * DAY_MS) stale.push(type);
        else due.push(type);
    }
    return { due, stale };
}

/** Is an issued, unsubmitted survey inside its one-reminder window? */
export function shouldRemindSurvey(survey, now) {
    if (!survey?.issuedAt || survey?.submittedAt || survey?.remindedAt || !survey?.dueAt) return false;
    const at = new Date(now).getTime();
    const due = new Date(survey.dueAt).getTime();
    return at < due && at >= due - SURVEY_REMINDER_LEAD_DAYS * DAY_MS;
}

const LEFT_RE = /inactive|terminated|exited|offboard|separated|resigned|left/i;

/** Has the employee left (separated, or a status saying so)? */
export function employeeHasLeft(employee) {
    if (!employee) return true;
    if (employee.separatedAt) return true;
    return LEFT_RE.test(`${employee.status ?? ""} ${employee.employement_status ?? ""}`);
}

/** "2026-07" — the cohort month of a start date. */
export const cohortMonth = (startDate) => {
    const key = startDateKey(startDate);
    return key ? key.slice(0, 7) : null;
};

const rate = (submitted, issued) => (issued ? Math.round((submitted / issued) * 1000) / 10 : null);

/**
 * Completion per survey type per start-date cohort month.
 *
 * A survey counts as issued when the job issued it, or when it was submitted
 * without being issued (the portal's own feedback form); overdue means issued,
 * unsubmitted and past its due time.
 *
 * @param {{ type: string, startDate: Date, issuedAt?: Date, dueAt?: Date, submittedAt?: Date }[]} rows
 * @returns {{ rows: object[], totals: object[] }}
 */
export function surveyCompletion(rows = [], now = new Date()) {
    const at = new Date(now).getTime();
    const blank = () => ({ issued: 0, submitted: 0, overdue: 0, pending: 0 });
    const cells = new Map();
    const totals = new Map(SURVEY_TYPES.map((t) => [t, blank()]));
    for (const r of rows) {
        if (!SURVEY_TYPES.includes(r?.type)) continue;
        const cohort = cohortMonth(r.startDate);
        if (!cohort) continue;
        if (!r.issuedAt && !r.submittedAt) continue;
        const key = `${cohort}|${r.type}`;
        if (!cells.has(key)) cells.set(key, { cohortMonth: cohort, surveyType: r.type, ...blank() });
        for (const cell of [cells.get(key), totals.get(r.type)]) {
            cell.issued += 1;
            if (r.submittedAt) cell.submitted += 1;
            else if (r.dueAt && new Date(r.dueAt).getTime() < at) cell.overdue += 1;
            else cell.pending += 1;
        }
    }
    const withRate = (c) => ({ ...c, completionRate: rate(c.submitted, c.issued) });
    return {
        rows: [...cells.values()]
            .sort((a, b) => a.cohortMonth.localeCompare(b.cohortMonth) || SURVEY_TYPES.indexOf(a.surveyType) - SURVEY_TYPES.indexOf(b.surveyType))
            .map(withRate),
        totals: [...totals.entries()].map(([surveyType, c]) => withRate({ surveyType, ...c })),
    };
}
