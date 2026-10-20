// Recruitment Phase 4 — the pure orientation-session rules: the baseline,
// template validation, working-day placement (never a weekend), the
// tenant-zone time range, the calendar mark and the tombstone filter.
import { describe, it, expect } from "@jest/globals";

const util = await import("../../../src/lib/onboarding-sessions.util.js");
const {
    DEFAULT_ONBOARDING_SESSIONS,
    validateTemplateSessions,
    resolveSessionPlan,
    workingDayFrom,
    placeSessions,
    sessionTimeRange,
    sessionCalendarMark,
    nextSessionCalendarAction,
    isSessionTombstone,
    liveSessionWhere,
    parseLooseClock,
    isOnboardingCalendarEnabled,
    dateKey,
} = util;

const good = {
    key: "welcome",
    title: " Welcome ",
    sessionType: "orientation",
    dayOffset: 0,
    fromTime: "09:00",
    toTime: "10:00",
    location: " Room 2 ",
    required: true,
    assigneeType: "HR",
};

describe("the baseline", () => {
    it("is itself a valid template: day-one welcome and IT setup, week-one compliance, a manager one-to-one", () => {
        const verdict = validateTemplateSessions(DEFAULT_ONBOARDING_SESSIONS);
        expect(verdict.ok).toBe(true);
        const byKey = Object.fromEntries(DEFAULT_ONBOARDING_SESSIONS.map((s) => [s.key, s]));
        expect(byKey["welcome-hr-orientation"]).toMatchObject({ sessionType: "orientation", dayOffset: 0, assigneeType: "HR" });
        expect(byKey["it-setup"].dayOffset).toBe(0);
        expect(byKey["manager-one-to-one"].assigneeType).toBe("MANAGER");
        const compliance = DEFAULT_ONBOARDING_SESSIONS.filter((s) => s.sessionType === "compliance");
        expect(compliance.map((s) => s.key)).toEqual(["code-of-conduct", "data-protection"]);
        expect(compliance.every((s) => s.dayOffset > 0 && s.dayOffset <= 4)).toBe(true);
    });
});

describe("validateTemplateSessions", () => {
    it("accepts and trims a well-formed session; an empty list is valid (no sessions)", () => {
        const verdict = validateTemplateSessions([good]);
        expect(verdict).toEqual({ ok: true, sessions: [{ ...good, title: "Welcome", location: "Room 2" }] });
        expect(validateTemplateSessions([])).toEqual({ ok: true, sessions: [] });
    });

    it("defaults required to false and leaves times empty when neither is given", () => {
        const { sessions } = validateTemplateSessions([{ ...good, required: undefined, fromTime: undefined, toTime: undefined }]);
        expect(sessions[0]).toMatchObject({ required: false, fromTime: null, toTime: null });
    });

    it.each([
        [{ key: "Bad Key" }, /key must be/],
        [{ title: "  " }, /title is required/],
        [{ sessionType: "party" }, /sessionType must be one of/],
        [{ dayOffset: 1.5 }, /dayOffset must be an integer/],
        [{ dayOffset: "2" }, /dayOffset must be an integer/],
        [{ dayOffset: 500 }, /dayOffset must be an integer/],
        [{ toTime: undefined }, /both fromTime and toTime/],
        [{ fromTime: "9am" }, /HH:MM/],
        [{ fromTime: "11:00", toTime: "10:00" }, /after fromTime/],
        [{ required: "yes" }, /required must be/],
        [{ assigneeType: "IT" }, /assigneeType must be one of/],
    ])("refuses %j", (over, error) => {
        const verdict = validateTemplateSessions([{ ...good, ...over }]);
        expect(verdict.ok).toBe(false);
        expect(verdict.error).toMatch(error);
    });

    it("refuses a repeated key, a non-list and too many sessions", () => {
        expect(validateTemplateSessions([good, { ...good }]).error).toMatch(/used twice/);
        expect(validateTemplateSessions({}).ok).toBe(false);
        const many = Array.from({ length: 21 }, (_, i) => ({ ...good, key: `s-${i}` }));
        expect(validateTemplateSessions(many).error).toMatch(/at most 20/);
    });
});

describe("resolveSessionPlan", () => {
    it("the template's list wins; no template, null sessions or a broken stored list fall back to the baseline", () => {
        expect(resolveSessionPlan({ id: 4, sessions: [good] })).toMatchObject({ source: "TEMPLATE", templateId: 4 });
        expect(resolveSessionPlan({ id: 4, sessions: [] })).toEqual({ sessions: [], source: "TEMPLATE", templateId: 4 });
        for (const template of [null, { id: 5, sessions: null }, { id: 6, sessions: [{ key: "" }] }]) {
            expect(resolveSessionPlan(template)).toEqual({ sessions: DEFAULT_ONBOARDING_SESSIONS, source: "DEFAULT", templateId: null });
        }
    });
});

describe("working-day placement", () => {
    // 2026-10-23 is a Friday, 2026-10-24/25 the weekend.
    const FRIDAY = "2026-10-23";
    it("day 0 is the start date; +1 from a Friday is the Monday", () => {
        expect(dateKey(workingDayFrom(FRIDAY, 0))).toBe("2026-10-23");
        expect(dateKey(workingDayFrom(FRIDAY, 1))).toBe("2026-10-26");
        expect(dateKey(workingDayFrom(FRIDAY, 5))).toBe("2026-10-30");
    });

    it("a weekend start rolls day 0 forward to Monday", () => {
        expect(dateKey(workingDayFrom("2026-10-24", 0))).toBe("2026-10-26");
        expect(dateKey(workingDayFrom("2026-10-25T00:00:00Z", 2))).toBe("2026-10-28");
    });

    it("a negative offset counts working days back", () => {
        expect(dateKey(workingDayFrom("2026-10-26", -1))).toBe("2026-10-23");
    });

    it("never lands on a weekend, for every offset from every weekday", () => {
        for (let d = 19; d <= 25; d += 1) {
            for (let off = -5; off <= 15; off += 1) {
                expect([0, 6]).not.toContain(workingDayFrom(`2026-10-${d}`, off).getUTCDay());
            }
        }
    });

    it("honours another weekend (Friday and Saturday)", () => {
        expect(dateKey(workingDayFrom("2026-10-22", 1, { nonWorkingWeekdays: [5, 6] }))).toBe("2026-10-25");
    });

    it("placeSessions dates each session; an unreadable start date gives none", () => {
        const [s] = placeSessions([{ ...good, dayOffset: 1 }], FRIDAY);
        expect(dateKey(s.sessionDate)).toBe("2026-10-26");
        expect(workingDayFrom("not a date", 0)).toBeNull();
    });
});

describe("sessionTimeRange", () => {
    it("reads the date and clock in the tenant's zone", () => {
        const range = sessionTimeRange({ sessionDate: new Date("2026-10-26T00:00:00Z"), fromTime: "09:30", toTime: "11:00" }, { timeZone: "Asia/Karachi" });
        expect(range.start.toISOString()).toBe("2026-10-26T04:30:00.000Z");
        expect(range.end.toISOString()).toBe("2026-10-26T06:00:00.000Z");
    });

    it("falls back to the working-day start and one hour, and reads loose times", () => {
        const range = sessionTimeRange({ sessionDate: "2026-10-26", fromTime: "soon" }, { timeZone: "UTC", workdayStart: "08:00" });
        expect(range.start.toISOString()).toBe("2026-10-26T08:00:00.000Z");
        expect(range.end.toISOString()).toBe("2026-10-26T09:00:00.000Z");
        expect(parseLooseClock("2:15 pm")).toBe(14 * 60 + 15);
        expect(parseLooseClock("12:00am")).toBe(0);
        expect(parseLooseClock("25:00")).toBeNull();
        expect(sessionTimeRange({ sessionDate: null }, { timeZone: "UTC" })).toBeNull();
    });
});

describe("calendar helpers", () => {
    it("the mark is PENDING, due now, attempts reset", () => {
        const now = new Date("2026-10-20T08:00:00Z");
        expect(sessionCalendarMark("CREATE", now)).toEqual({
            calendarSyncStatus: "PENDING",
            calendarSyncAction: "CREATE",
            calendarSyncAttempts: 0,
            calendarNextAttemptAt: now,
            calendarLastError: null,
        });
        expect(nextSessionCalendarAction({})).toBe("CREATE");
        expect(nextSessionCalendarAction({ calendarEventId: "e" })).toBe("UPDATE");
        expect(nextSessionCalendarAction({ calendarEventId: "e", cancel: true })).toBe("CANCEL");
    });

    it("a CANCEL row is a tombstone, and the live filter keeps null and other actions", () => {
        expect(isSessionTombstone({ calendarSyncAction: "CANCEL" })).toBe(true);
        expect(isSessionTombstone({ calendarSyncAction: null })).toBe(false);
        expect(liveSessionWhere()).toEqual({ OR: [{ calendarSyncAction: null }, { calendarSyncAction: { not: "CANCEL" } }] });
    });

    it("invites need both onboardingAutomation and calendarSync", () => {
        const flags = (on) => (key) => on.includes(key);
        expect(isOnboardingCalendarEnabled(flags(["onboardingAutomation", "calendarSync"]))).toBe(true);
        expect(isOnboardingCalendarEnabled(flags(["calendarSync"]))).toBe(false);
        expect(isOnboardingCalendarEnabled(flags(["onboardingAutomation"]))).toBe(false);
    });
});
