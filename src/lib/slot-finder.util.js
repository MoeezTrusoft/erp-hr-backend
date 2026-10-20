// src/lib/slot-finder.util.js
//
// Recruitment Phase 3a — the interview SLOT FINDER. Pure: no DB, no I/O, no
// clock of its own (the caller passes `now`), so the whole search is unit
// testable and the service, the tools and any later job decide identically.
//
// Given a panel's busy intervals (calendar free-busy plus the panel's own HR
// interviews), approved leave, non-working days and the tenant's working
// window, it returns up to N slots in which EVERY panelist is free, spread
// across different days where it can (a candidate offered five times on one
// Tuesday has really been offered one day).
//
// Time zones: the working window ("09:00"-"18:00") is a wall-clock time in
// the tenant's IANA zone. Each day's window is converted to UTC on its own,
// with Intl only, so a day after a daylight-saving change gets the new
// offset (09:00 Europe/London is 08:00Z in summer, 09:00Z in winter). A wall
// time that does not exist (the hour skipped when clocks go forward) resolves
// to the instant one offset later; a working window never sits in that hour
// in practice.
//
// Every interval is half-open [start, end): an interview ending at 10:00
// does not collide with one starting at 10:00.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SLOT_FINDER_DEFAULTS = Object.freeze({
    count: 5,
    minCount: 3,
    maxCount: 5,
    stepMinutes: 30,
    searchWorkingDays: 10,
    minLeadHours: 24,
    // Sunday and Saturday (Date#getUTCDay numbering) unless the caller says
    // otherwise; the service adds each panelist's own off days.
    nonWorkingWeekdays: Object.freeze([0, 6]),
    minDurationMinutes: 15,
    maxDurationMinutes: 480,
});

// The longest stretch searched whatever `to` says, so a far-off range cannot
// turn one call into an unbounded loop.
const MAX_CALENDAR_DAYS = 90;

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const fail = (message, code) => Object.assign(new Error(message), { status: 400, code });

// ── Time zone arithmetic ─────────────────────────────────────────────────────

const formatters = new Map();

function formatterFor(timeZone) {
    let fmt = formatters.get(timeZone);
    if (!fmt) {
        try {
            fmt = new Intl.DateTimeFormat("en-US", {
                timeZone,
                hourCycle: "h23",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        } catch {
            throw fail(`Unknown time zone "${timeZone}"`, "HR-RECRUITMENT-SLOT-TIMEZONE-INVALID");
        }
        formatters.set(timeZone, fmt);
    }
    return fmt;
}

/** Is this an IANA zone Intl knows? */
export function isValidTimeZone(timeZone) {
    try {
        formatterFor(String(timeZone ?? ""));
        return true;
    } catch {
        return false;
    }
}

/** The wall-clock fields of an instant in a zone. */
export function zonedParts(instant, timeZone) {
    const parts = {};
    for (const { type, value } of formatterFor(timeZone).formatToParts(new Date(instant))) {
        if (type !== "literal") parts[type] = Number(value);
    }
    return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour === 24 ? 0 : parts.hour,
        minute: parts.minute,
        second: parts.second,
    };
}

/** The zone's offset from UTC at an instant, in ms (Karachi: +5 h). */
export function zoneOffsetMs(instant, timeZone) {
    const ms = Math.floor(new Date(instant).getTime() / 1000) * 1000;
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * The UTC instant of a wall-clock time in a zone. Two passes, so a time on
 * the far side of a DST change uses the offset in force at that time.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const first = zoneOffsetMs(wall, timeZone);
    let utc = wall - first;
    const second = zoneOffsetMs(utc, timeZone);
    if (second !== first) utc = wall - second;
    return new Date(utc);
}

/** "09:30" -> 570. */
export function parseClock(value) {
    const match = CLOCK_RE.exec(String(value ?? "").trim());
    if (!match) throw fail(`"${value}" is not a HH:MM time`, "HR-RECRUITMENT-SLOT-WINDOW-INVALID");
    return Number(match[1]) * 60 + Number(match[2]);
}

// A calendar date as plain fields; date arithmetic runs in UTC so it never
// depends on the host's zone.
const dateKey = ({ year, month, day }) =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function addDays(date, days) {
    const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const weekdayOf = (date) => new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

/** The tenant-local calendar date of an instant. */
export function zonedDate(instant, timeZone) {
    const { year, month, day } = zonedParts(instant, timeZone);
    return { year, month, day };
}

/** One working day's window as UTC instants. */
export function workingWindowUtc(date, { workdayStart, workdayEnd, timeZone }) {
    const startMin = parseClock(workdayStart);
    const endMin = parseClock(workdayEnd);
    if (endMin <= startMin) throw fail("The working day must end after it starts", "HR-RECRUITMENT-SLOT-WINDOW-INVALID");
    const at = (minutes) => zonedTimeToUtc({ ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 }, timeZone);
    return { start: at(startMin), end: at(endMin) };
}

// ── Intervals ────────────────────────────────────────────────────────────────

const toMs = (value) => {
    if (value == null) return NaN;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : NaN;
};

/** Accepts [{start,end}] or { [employeeId]: [{start,end}] }; drops junk. */
export function normalizeIntervals(input) {
    const list = Array.isArray(input) ? input : input && typeof input === "object" ? Object.values(input).flat() : [];
    return list
        .map((i) => ({ start: toMs(i?.start), end: toMs(i?.end) }))
        .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
        .sort((a, b) => a.start - b.start);
}

export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * An approved leave row as the tenant-local whole days it covers. Leave is
 * day-granular and stored as a date (midnight UTC), so the UTC calendar date
 * of startDate and endDate names the days; each is blocked from 00:00 to
 * 24:00 in the tenant's zone.
 */
export function leaveRowToInterval(row, timeZone) {
    const s = new Date(row?.startDate);
    const e = new Date(row?.endDate ?? row?.startDate);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
    const first = { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate() };
    const last = { year: e.getUTCFullYear(), month: e.getUTCMonth() + 1, day: e.getUTCDate() };
    return {
        employeeId: row?.employeeId ?? null,
        start: zonedTimeToUtc(first, timeZone),
        end: zonedTimeToUtc(addDays(last, 1), timeZone),
    };
}

// ── The search ───────────────────────────────────────────────────────────────

function clampCount(count) {
    const n = Number(count);
    if (!Number.isFinite(n)) return SLOT_FINDER_DEFAULTS.count;
    return Math.min(Math.max(Math.floor(n), SLOT_FINDER_DEFAULTS.minCount), SLOT_FINDER_DEFAULTS.maxCount);
}

function requireDuration(durationMinutes) {
    const n = Number(durationMinutes ?? 60);
    if (!Number.isInteger(n) || n < SLOT_FINDER_DEFAULTS.minDurationMinutes || n > SLOT_FINDER_DEFAULTS.maxDurationMinutes) {
        throw fail(
            `durationMinutes must be a whole number from ${SLOT_FINDER_DEFAULTS.minDurationMinutes} to ${SLOT_FINDER_DEFAULTS.maxDurationMinutes}`,
            "HR-RECRUITMENT-SLOT-DURATION-INVALID",
        );
    }
    return n;
}

/** Every free start in one day's window, in order. */
function freeStartsForDay(window, { durationMs, stepMs, earliest, latest, blocked, isSlotBlocked }) {
    const out = [];
    for (let start = window.start.getTime(); start + durationMs <= window.end.getTime(); start += stepMs) {
        const end = start + durationMs;
        if (start < earliest || end > latest) continue;
        if (blocked.some((b) => overlaps(start, end, b.start, b.end))) continue;
        if (isSlotBlocked && isSlotBlocked(new Date(start), new Date(end))) continue;
        out.push({ start, end });
    }
    return out;
}

/**
 * Round-robin over the days: the first free slot of each day, then a second
 * slot per day, and so on, never picking two that overlap.
 */
function spreadAcrossDays(days, count) {
    const picked = [];
    const cursor = days.map(() => 0);
    let progressed = true;
    while (picked.length < count && progressed) {
        progressed = false;
        for (let d = 0; d < days.length && picked.length < count; d += 1) {
            const slots = days[d];
            while (cursor[d] < slots.length) {
                const slot = slots[cursor[d]];
                cursor[d] += 1;
                if (!picked.some((p) => overlaps(slot.start, slot.end, p.start, p.end))) {
                    picked.push(slot);
                    progressed = true;
                    break;
                }
            }
        }
    }
    return picked.sort((a, b) => a.start - b.start);
}

/**
 * Find up to `count` slots in which every panelist is free.
 *
 * @param {object} input
 * @param {Array|object} [input.busy]           panel busy intervals ([{start,end}] or by employee)
 * @param {Array} [input.leave]                  leave as intervals ([{start,end}], see leaveRowToInterval)
 * @param {string[]} [input.nonWorkingDates]     "YYYY-MM-DD" tenant-local days nobody can do
 * @param {number[]} [input.nonWorkingWeekdays]  0 (Sunday) .. 6 (Saturday)
 * @param {string} input.workdayStart            "HH:MM" tenant-local
 * @param {string} input.workdayEnd              "HH:MM" tenant-local
 * @param {string} input.timeZone                IANA zone
 * @param {number} [input.durationMinutes=60]
 * @param {Date|string} [input.from]             search start (never earlier than now + minLeadHours)
 * @param {Date|string} [input.to]               search end (default: searchWorkingDays working days)
 * @param {Date|string} input.now
 * @param {number} [input.count=5]               3..5
 * @param {number} [input.stepMinutes=30]
 * @param {number} [input.searchWorkingDays=10]
 * @param {number} [input.minLeadHours=24]
 * @param {(start: Date, end: Date) => boolean} [input.isSlotBlocked]  an extra rule (the service's availability gate)
 * @returns {Array<{ start: string, end: string }>} ISO UTC, ordered by start
 */
export function findCommonSlots(input = {}) {
    const timeZone = String(input.timeZone ?? "").trim();
    formatterFor(timeZone); // validates the zone up front
    const durationMs = requireDuration(input.durationMinutes) * MINUTE_MS;
    const stepMinutes = Number(input.stepMinutes ?? SLOT_FINDER_DEFAULTS.stepMinutes);
    if (!Number.isInteger(stepMinutes) || stepMinutes < 5 || stepMinutes > 240) {
        throw fail("stepMinutes must be a whole number from 5 to 240", "HR-RECRUITMENT-SLOT-STEP-INVALID");
    }
    const count = clampCount(input.count);
    const now = toMs(input.now);
    if (!Number.isFinite(now)) throw fail("now is required", "HR-RECRUITMENT-SLOT-RANGE-INVALID");
    const leadHours = Number(input.minLeadHours ?? SLOT_FINDER_DEFAULTS.minLeadHours);
    const earliest = Math.max(now + Math.max(0, leadHours) * HOUR_MS, Number.isFinite(toMs(input.from)) ? toMs(input.from) : -Infinity);
    const to = toMs(input.to);
    const latest = Number.isFinite(to) ? to : Infinity;
    if (latest <= earliest) return [];
    const searchWorkingDays = Math.max(1, Math.floor(Number(input.searchWorkingDays ?? SLOT_FINDER_DEFAULTS.searchWorkingDays)) || 1);

    const window = { workdayStart: input.workdayStart, workdayEnd: input.workdayEnd, timeZone };
    // Validate the window once, before the loop, so a bad setting fails loudly.
    workingWindowUtc(zonedDate(earliest, timeZone), window);

    const offWeekdays = new Set(input.nonWorkingWeekdays ?? SLOT_FINDER_DEFAULTS.nonWorkingWeekdays);
    const offDates = new Set((input.nonWorkingDates ?? []).map(String));
    const blocked = [...normalizeIntervals(input.busy), ...normalizeIntervals(input.leave)];
    const options = { durationMs, stepMs: stepMinutes * MINUTE_MS, earliest, latest, blocked, isSlotBlocked: input.isSlotBlocked };

    const days = [];
    let workingDaysSeen = 0;
    let date = zonedDate(earliest, timeZone);
    for (let i = 0; i < MAX_CALENDAR_DAYS; i += 1, date = addDays(date, 1)) {
        const span = workingWindowUtc(date, window);
        if (span.start.getTime() >= latest) break;
        if (!Number.isFinite(latest) && workingDaysSeen >= searchWorkingDays) break;
        if (offWeekdays.has(weekdayOf(date)) || offDates.has(dateKey(date))) continue;
        workingDaysSeen += 1;
        const free = freeStartsForDay(span, options);
        if (free.length) days.push(free);
    }

    return spreadAcrossDays(days, count).map((s) => ({
        start: new Date(s.start).toISOString(),
        end: new Date(s.end).toISOString(),
    }));
}

export { dateKey as toDateKey, addDays as addCalendarDays, weekdayOf, DAY_MS };
