// src/lib/resume-experience.util.js
//
// Recruitment Phase 7 (D18c): years of experience from a parsed resume.
//
// The fit score has an experience component (src/lib/fit-score.util.js) that
// never turned on, because the resume parse carried no years. This derives
// them from the parse's dated work-history entries, deterministically, so the
// same parse always gives the same number:
//
//   * an entry counts only when it has a usable start and an end: an end date,
//     an end of "present" / "current" / "now" (or a current flag), which means
//     the parse time. An entry with no end and no current flag is undated:
//     guessing it runs to today could add years nobody worked;
//   * dates read as the first day of their period ("2019" is 1 Jan 2019,
//     "Mar 2020" is 1 Mar 2020), an end after the parse time is the parse
//     time, and an entry ending before it starts, or starting after the parse
//     time, is ignored;
//   * overlapping or touching entries are merged first, so two jobs held at
//     the same time are counted once;
//   * the total is in years of 365.25 days, rounded to one decimal and capped
//     at 50; null when no entry is dated (unknown, never zero).
//
// Pure: no DB, no clock (the parse time is passed in).

export const MAX_YEARS_OF_EXPERIENCE = 50;

// The parse keys a work history has appeared under (first array wins).
export const EXPERIENCE_LIST_KEYS = Object.freeze([
    "experience",
    "workExperience",
    "employment",
    "employmentHistory",
    "workHistory",
]);

const START_KEYS = Object.freeze(["startDate", "start", "from", "startedAt", "dateFrom"]);
const END_KEYS = Object.freeze(["endDate", "end", "to", "endedAt", "dateTo"]);
const CURRENT_KEYS = Object.freeze(["current", "isCurrent", "present", "ongoing"]);
const PRESENT_WORDS = new Set(["present", "current", "now", "ongoing", "today", "till date", "to date", "till now"]);

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

const MONTH_NAMES = Object.freeze([
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]);

/** Month index for "mar", "march" or "sept" (the abbreviation or the full name), else undefined. */
const monthIndex = (word) => {
    const i = MONTH_NAMES.findIndex((name) => name === word || name.slice(0, 3) === word || (word === "sept" && name === "september"));
    return i === -1 ? undefined : i;
};

const utc = (year, month = 0, day = 1) => {
    const d = new Date(Date.UTC(year, month, day));
    return Number.isNaN(d.getTime()) ? null : d;
};

const validYear = (y) => Number.isInteger(y) && y >= 1900 && y <= 2200;

/**
 * One resume date: "2019", "2019-03", "03/2019", "Mar 2019", "March 2019",
 * "2019-03-15", or a Date. Returns a Date or null.
 */
export function parseExperienceDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "number") return validYear(value) ? utc(value) : null;
    if (typeof value !== "string") return null;
    const s = value.trim().toLowerCase();
    if (!s) return null;
    let m = /^(\d{4})$/.exec(s);
    if (m) return validYear(Number(m[1])) ? utc(Number(m[1])) : null;
    m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
    if (m) return validYear(Number(m[1])) && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? utc(Number(m[1]), Number(m[2]) - 1) : null;
    m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
    if (m) return validYear(Number(m[2])) && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? utc(Number(m[2]), Number(m[1]) - 1) : null;
    m = /^([a-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
    if (m) {
        const month = monthIndex(m[1]);
        return month !== undefined && validYear(Number(m[2])) ? utc(Number(m[2]), month) : null;
    }
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
        const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : value.trim());
        return Number.isNaN(d.getTime()) || !validYear(d.getUTCFullYear()) ? null : d;
    }
    return null;
}

const firstPresent = (entry, keys) => {
    for (const key of keys) {
        const v = entry[key];
        if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
};

const isPresentWord = (value) => typeof value === "string" && PRESENT_WORDS.has(value.trim().toLowerCase());

/**
 * The [start, end] interval of one entry at parse time `now`, or null when it
 * is not dated (see the header for the rules).
 */
export function experienceInterval(entry, now) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const at = new Date(now);
    const start = parseExperienceDate(firstPresent(entry, START_KEYS));
    if (!start || start > at) return null;
    const rawEnd = firstPresent(entry, END_KEYS);
    const current = CURRENT_KEYS.some((k) => entry[k] === true);
    let end = isPresentWord(rawEnd) || (rawEnd === null && current) ? at : parseExperienceDate(rawEnd);
    if (!end) return null;
    if (end > at) end = at;
    if (end < start) return null;
    return { start, end };
}

/** Sort and merge overlapping (or touching) intervals. */
export function mergeIntervals(intervals) {
    const sorted = intervals
        .filter(Boolean)
        .map((i) => ({ start: new Date(i.start), end: new Date(i.end) }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const cur of sorted) {
        const last = merged[merged.length - 1];
        if (last && cur.start <= last.end) {
            if (cur.end > last.end) last.end = cur.end;
        } else {
            merged.push(cur);
        }
    }
    return merged;
}

/** The work-history array of a parse (the first listed key holding an array). */
export function experienceEntriesOf(parsed) {
    if (!parsed || typeof parsed !== "object") return [];
    for (const key of EXPERIENCE_LIST_KEYS) {
        if (Array.isArray(parsed[key])) return parsed[key];
    }
    return [];
}

/**
 * Years of experience from work-history entries, at parse time `now`.
 * @param {Array<object>} entries
 * @param {Date|string} now  the parse time ("present" means this instant)
 * @returns {number|null} 0..50, one decimal; null when no entry is dated
 */
export function yearsOfExperienceFrom(entries, now = new Date()) {
    if (!Array.isArray(entries) || !entries.length) return null;
    const intervals = entries.map((e) => experienceInterval(e, now)).filter(Boolean);
    if (!intervals.length) return null;
    const totalMs = mergeIntervals(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
    const years = Math.round((totalMs / MS_PER_YEAR) * 10) / 10;
    return Math.min(MAX_YEARS_OF_EXPERIENCE, years);
}
