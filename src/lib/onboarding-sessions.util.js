// src/lib/onboarding-sessions.util.js
//
// Recruitment Phase 4 (plan 6.7 "Orientation scheduling") — the PURE rules
// for the orientation and compliance sessions a new hire gets on handoff.
// No DB, no clock of its own (only the flag getter reads the environment):
// the template service, the handoff step, the preview tool and the calendar
// worker all decide from here, so they cannot disagree about what a valid
// session plan is or which day a session lands on.
//
//   * DEFAULT_ONBOARDING_SESSIONS is the documented baseline a tenant gets
//     when its default template carries no `sessions` (null). An EMPTY list
//     is a valid template choice ("no sessions"), unlike tasks, because a
//     tenant may run orientation outside HR entirely.
//   * validateTemplateSessions owns the shape: a stable `key` per session
//     (the handoff is idempotent on checklist + key), a closed type and
//     assignee vocabulary, an integer working-day offset, HH:MM times.
//   * dayOffset counts WORKING days from the start date, so a session never
//     lands on a weekend: day 0 is the start date (or the next working day
//     when the hire starts on a weekend), +n is the n-th working day after
//     it, -n the n-th working day before it. Dates are calendar dates kept
//     as UTC midnight, the same convention the schedule screen writes.
//   * A session row whose calendarSyncAction is CANCEL is a TOMBSTONE: HR
//     deleted it while a calendar event exists (or was being written), and
//     the calendar worker removes the row once the event is cancelled. Every
//     reader lists sessions through liveSessionWhere().
import { zonedTimeToUtc } from "./slot-finder.util.js";
import { isRecruitmentFlagEnabled } from "./recruitmentFlags.js";

export const ONBOARDING_SESSION_TYPES = Object.freeze(["orientation", "training", "meeting", "compliance"]);
export const ONBOARDING_SESSION_ASSIGNEES = Object.freeze(["HR", "MANAGER", "BUDDY", "NEW_HIRE"]);

export const SESSION_CALENDAR_ACTION = Object.freeze({ CREATE: "CREATE", UPDATE: "UPDATE", CANCEL: "CANCEL" });
export const SESSION_CALENDAR_STATUS = Object.freeze({ PENDING: "PENDING", SYNCED: "SYNCED", FAILED: "FAILED" });

// Sunday and Saturday (Date#getUTCDay numbering), as the slot finder.
export const DEFAULT_NON_WORKING_WEEKDAYS = Object.freeze([0, 6]);

const MAX_SESSIONS = 20;
const MAX_TITLE = 200;
const MAX_LOCATION = 500;
const MIN_DAY_OFFSET = -20;
const MAX_DAY_OFFSET = 120;
const DEFAULT_DURATION_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The baseline: day-one welcome and setup, week-one compliance, the manager one-to-one. */
export const DEFAULT_ONBOARDING_SESSIONS = Object.freeze([
    {
        key: "welcome-hr-orientation",
        title: "Welcome and HR orientation",
        sessionType: "orientation",
        dayOffset: 0,
        fromTime: "09:30",
        toTime: "11:00",
        location: null,
        required: true,
        assigneeType: "HR",
    },
    {
        key: "it-setup",
        title: "IT setup and system access",
        sessionType: "training",
        dayOffset: 0,
        fromTime: "11:30",
        toTime: "12:30",
        location: null,
        required: true,
        assigneeType: "HR",
    },
    {
        key: "manager-one-to-one",
        title: "One-to-one with your manager",
        sessionType: "meeting",
        dayOffset: 0,
        fromTime: "14:00",
        toTime: "14:30",
        location: null,
        required: true,
        assigneeType: "MANAGER",
    },
    {
        key: "code-of-conduct",
        title: "Code of conduct",
        sessionType: "compliance",
        dayOffset: 2,
        fromTime: "10:00",
        toTime: "11:00",
        location: null,
        required: true,
        assigneeType: "HR",
    },
    {
        key: "data-protection",
        title: "Data protection and information security",
        sessionType: "compliance",
        dayOffset: 3,
        fromTime: "10:00",
        toTime: "11:00",
        location: null,
        required: true,
        assigneeType: "HR",
    },
].map((s) => Object.freeze(s)));

const clockMinutes = (value) => {
    const m = CLOCK_RE.exec(value);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const optionalText = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function validateOne(raw, where) {
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    if (!KEY_RE.test(key)) return { error: `${where}: key must be 1-64 lowercase letters, digits, "-" or "_"` };

    const title = typeof raw?.title === "string" ? raw.title.trim() : "";
    if (!title) return { error: `${where}: title is required` };
    if (title.length > MAX_TITLE) return { error: `${where}: title is too long` };

    const sessionType = typeof raw?.sessionType === "string" ? raw.sessionType.trim().toLowerCase() : "";
    if (!ONBOARDING_SESSION_TYPES.includes(sessionType)) {
        return { error: `${where}: sessionType must be one of ${ONBOARDING_SESSION_TYPES.join(", ")}` };
    }

    // Integer only, never coerced: a floored offset is how a day-one session
    // lands on the wrong day.
    const dayOffset = raw?.dayOffset;
    if (!Number.isInteger(dayOffset) || dayOffset < MIN_DAY_OFFSET || dayOffset > MAX_DAY_OFFSET) {
        return { error: `${where}: dayOffset must be an integer from ${MIN_DAY_OFFSET} to ${MAX_DAY_OFFSET} (working days from the start date)` };
    }

    const fromTime = optionalText(raw?.fromTime);
    const toTime = optionalText(raw?.toTime);
    if ((fromTime == null) !== (toTime == null)) return { error: `${where}: give both fromTime and toTime, or neither` };
    if (fromTime != null) {
        const from = clockMinutes(fromTime);
        const to = clockMinutes(toTime);
        if (from == null || to == null) return { error: `${where}: fromTime and toTime must be HH:MM` };
        if (to <= from) return { error: `${where}: toTime must be after fromTime` };
    }

    const location = optionalText(raw?.location);
    if (location && location.length > MAX_LOCATION) return { error: `${where}: location is too long` };

    if (raw?.required != null && typeof raw.required !== "boolean") return { error: `${where}: required must be true or false` };

    const assigneeType = typeof raw?.assigneeType === "string" ? raw.assigneeType.trim().toUpperCase() : "";
    if (!ONBOARDING_SESSION_ASSIGNEES.includes(assigneeType)) {
        return { error: `${where}: assigneeType must be one of ${ONBOARDING_SESSION_ASSIGNEES.join(", ")}` };
    }

    return {
        session: { key, title, sessionType, dayOffset, fromTime, toTime, location, required: raw?.required === true, assigneeType },
    };
}

/**
 * Validate a template's session list. An empty list is valid (no sessions).
 *
 * @returns {{ ok: true, sessions: object[] } | { ok: false, error: string }}
 */
export function validateTemplateSessions(sessions) {
    if (!Array.isArray(sessions)) return { ok: false, error: "sessions must be a list" };
    if (sessions.length > MAX_SESSIONS) return { ok: false, error: `A template allows at most ${MAX_SESSIONS} sessions` };
    const out = [];
    const keys = new Set();
    for (const [i, raw] of sessions.entries()) {
        const verdict = validateOne(raw, `Session ${i + 1}`);
        if (verdict.error) return { ok: false, error: verdict.error };
        if (keys.has(verdict.session.key)) return { ok: false, error: `Session ${i + 1}: key "${verdict.session.key}" is used twice` };
        keys.add(verdict.session.key);
        out.push(verdict.session);
    }
    return { ok: true, sessions: out };
}

/**
 * Which sessions a hire gets: the default template's validated `sessions`,
 * else the baseline. No template, `sessions` null, or a stored list that no
 * longer validates all mean the baseline: a hire is never left without an
 * orientation because of a configuration change.
 *
 * @returns {{ sessions: object[], source: "TEMPLATE"|"DEFAULT", templateId: number|null }}
 */
export function resolveSessionPlan(template) {
    if (!template || template.sessions == null) return { sessions: DEFAULT_ONBOARDING_SESSIONS, source: "DEFAULT", templateId: null };
    const verdict = validateTemplateSessions(template.sessions);
    if (!verdict.ok) return { sessions: DEFAULT_ONBOARDING_SESSIONS, source: "DEFAULT", templateId: null };
    return { sessions: verdict.sessions, source: "TEMPLATE", templateId: template.id ?? null };
}

// ── Working-day placement ────────────────────────────────────────────────────

/** The calendar date of a date-ish value as UTC midnight, or null. */
export function toCalendarDate(value) {
    if (value == null || value === "") return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const dateKey = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);

/**
 * The calendar date `dayOffset` working days from the start date. Day 0 is
 * the start date, rolled forward to a working day; the result is always a
 * working day.
 */
export function workingDayFrom(startDate, dayOffset, { nonWorkingWeekdays = DEFAULT_NON_WORKING_WEEKDAYS } = {}) {
    const start = toCalendarDate(startDate);
    if (!start) return null;
    const off = new Set(nonWorkingWeekdays);
    if (off.size >= 7) return null;
    const isOff = (d) => off.has(d.getUTCDay());
    let day = start;
    while (isOff(day)) day = new Date(day.getTime() + DAY_MS);
    const step = dayOffset < 0 ? -1 : 1;
    for (let left = Math.abs(Math.trunc(Number(dayOffset) || 0)); left > 0; ) {
        day = new Date(day.getTime() + step * DAY_MS);
        if (!isOff(day)) left -= 1;
    }
    return day;
}

/** One planned session (no ids, no assignee yet) for a start date. */
export function placeSessions(sessions, startDate, options = {}) {
    return (Array.isArray(sessions) ? sessions : []).map((s) => ({
        ...s,
        sessionDate: workingDayFrom(startDate, s.dayOffset, options),
    }));
}

// ── Calendar ─────────────────────────────────────────────────────────────────

/**
 * Session invites are a Phase 4 behaviour on top of the Phase 3a calendar
 * switch: both onboardingAutomation and calendarSync must be on, so turning
 * on interview calendars alone never starts writing onboarding invites.
 */
export const isOnboardingCalendarEnabled = (read = isRecruitmentFlagEnabled) =>
    Boolean(read("onboardingAutomation")) && Boolean(read("calendarSync"));

/**
 * The column data that queues a session for the calendar worker: PENDING,
 * the action, attempts reset, due now (the same shape as interviews').
 */
export function sessionCalendarMark(action, now = new Date()) {
    return {
        calendarSyncStatus: SESSION_CALENDAR_STATUS.PENDING,
        calendarSyncAction: action,
        calendarSyncAttempts: 0,
        calendarNextAttemptAt: new Date(now),
        calendarLastError: null,
    };
}

/** Create, update, or (for a tombstone) cancel. */
export function nextSessionCalendarAction({ calendarEventId = null, cancel = false } = {}) {
    if (cancel) return SESSION_CALENDAR_ACTION.CANCEL;
    return calendarEventId ? SESSION_CALENDAR_ACTION.UPDATE : SESSION_CALENDAR_ACTION.CREATE;
}

export const isSessionTombstone = (row) => row?.calendarSyncAction === SESSION_CALENDAR_ACTION.CANCEL;

/** Where-fragment for sessions that still exist for HR and the new hire. */
export const liveSessionWhere = () => ({
    OR: [{ calendarSyncAction: null }, { calendarSyncAction: { not: SESSION_CALENDAR_ACTION.CANCEL } }],
});

// "9:30", "09:30", "9:30 am", "2:00pm" -> minutes; anything else -> null.
export function parseLooseClock(value) {
    const m = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i.exec(String(value ?? "").trim());
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    if (minute > 59) return null;
    if (m[3]) {
        if (hour < 1 || hour > 12) return null;
        const pm = m[3].toLowerCase().startsWith("p");
        hour = (hour % 12) + (pm ? 12 : 0);
    } else if (hour > 23) {
        return null;
    }
    return hour * 60 + minute;
}

/**
 * The session's start and end instants: its calendar date at fromTime in
 * the tenant's zone (workdayStart when the time is missing or unreadable),
 * ending at toTime or an hour later. Null when the session has no date.
 */
export function sessionTimeRange(session, { timeZone, workdayStart = "09:00" } = {}) {
    const date = toCalendarDate(session?.sessionDate);
    if (!date) return null;
    const fields = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    const fromMin = parseLooseClock(session.fromTime) ?? parseLooseClock(workdayStart) ?? 9 * 60;
    const at = (minutes) => zonedTimeToUtc({ ...fields, hour: Math.floor(minutes / 60), minute: minutes % 60 }, timeZone || "UTC");
    const start = at(fromMin);
    const toMin = parseLooseClock(session.toTime);
    const end = toMin != null && toMin > fromMin ? at(toMin) : new Date(start.getTime() + DEFAULT_DURATION_MS);
    return { start, end };
}

const TYPE_LABELS = Object.freeze({
    orientation: "Orientation",
    training: "Training",
    meeting: "Meeting",
    compliance: "Compliance",
});

export const sessionTypeLabel = (type) => TYPE_LABELS[String(type ?? "").toLowerCase()] ?? "Onboarding session";
