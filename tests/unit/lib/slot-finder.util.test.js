// Recruitment Phase 3a — the pure slot finder: common free time for a panel,
// the tenant's working window per day in its own zone (with and without
// daylight saving), leave, non-working days, lead time, spreading.
import { describe, it, expect } from "@jest/globals";

import {
    findCommonSlots,
    isValidTimeZone,
    leaveRowToInterval,
    normalizeIntervals,
    parseClock,
    workingWindowUtc,
    zoneOffsetMs,
    zonedDate,
    zonedTimeToUtc,
} from "../../../src/lib/slot-finder.util.js";

const KARACHI = { workdayStart: "09:00", workdayEnd: "18:00", timeZone: "Asia/Karachi" };
// Monday 2026-10-19 08:00 in Karachi (UTC+5, no daylight saving).
const MONDAY_8AM_PKT = "2026-10-19T03:00:00.000Z";

const starts = (slots) => slots.map((s) => s.start);
const dayOf = (iso) => iso.slice(0, 10);

describe("time zone arithmetic", () => {
    it("converts a Karachi wall time to UTC (+5, all year)", () => {
        expect(zonedTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, "Asia/Karachi").toISOString()).toBe("2026-01-15T04:00:00.000Z");
        expect(zonedTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, "Asia/Karachi").toISOString()).toBe("2026-07-15T04:00:00.000Z");
        expect(zoneOffsetMs("2026-07-15T00:00:00Z", "Asia/Karachi")).toBe(5 * 3_600_000);
    });

    it("uses the offset in force on each side of a London clock change", () => {
        // Clocks go forward on 2026-03-29 and back on 2026-10-25.
        expect(zonedTimeToUtc({ year: 2026, month: 3, day: 27, hour: 9 }, "Europe/London").toISOString()).toBe("2026-03-27T09:00:00.000Z");
        expect(zonedTimeToUtc({ year: 2026, month: 3, day: 30, hour: 9 }, "Europe/London").toISOString()).toBe("2026-03-30T08:00:00.000Z");
        expect(zonedTimeToUtc({ year: 2026, month: 10, day: 23, hour: 9 }, "Europe/London").toISOString()).toBe("2026-10-23T08:00:00.000Z");
        expect(zonedTimeToUtc({ year: 2026, month: 10, day: 26, hour: 9 }, "Europe/London").toISOString()).toBe("2026-10-26T09:00:00.000Z");
    });

    it("resolves the skipped hour to the instant one offset later", () => {
        // 01:30 on 2026-03-29 does not exist in London; it becomes 02:30 BST.
        expect(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, "Europe/London").toISOString()).toBe("2026-03-29T01:30:00.000Z");
    });

    it("finds the local calendar date west of UTC", () => {
        expect(zonedDate("2026-10-20T02:00:00Z", "America/New_York")).toEqual({ year: 2026, month: 10, day: 19 });
        expect(zonedDate("2026-10-20T20:00:00Z", "Asia/Karachi")).toEqual({ year: 2026, month: 10, day: 21 });
    });

    it("validates zones and clocks", () => {
        expect(isValidTimeZone("Europe/London")).toBe(true);
        expect(isValidTimeZone("Mars/Olympus")).toBe(false);
        expect(parseClock("09:30")).toBe(570);
        expect(() => parseClock("9:30")).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-SLOT-WINDOW-INVALID" }));
        expect(() => workingWindowUtc({ year: 2026, month: 10, day: 20 }, { ...KARACHI, workdayEnd: "09:00" })).toThrow(
            expect.objectContaining({ code: "HR-RECRUITMENT-SLOT-WINDOW-INVALID" }),
        );
    });
});

describe("findCommonSlots — Karachi", () => {
    it("starts at least 24 h ahead, skips the weekend and spreads one slot per day", () => {
        const slots = findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT });
        expect(starts(slots)).toEqual([
            "2026-10-20T04:00:00.000Z", // Tue 09:00 PKT
            "2026-10-21T04:00:00.000Z",
            "2026-10-22T04:00:00.000Z",
            "2026-10-23T04:00:00.000Z", // Fri
            "2026-10-26T04:00:00.000Z", // Mon (Sat/Sun skipped)
        ]);
        expect(slots[0].end).toBe("2026-10-20T05:00:00.000Z");
    });

    it("honours the lead time inside the first day", () => {
        // Monday 13:00 PKT -> nothing before Tuesday 13:00 PKT.
        const slots = findCommonSlots({ ...KARACHI, now: "2026-10-19T08:00:00Z", count: 3 });
        expect(slots[0].start).toBe("2026-10-20T08:00:00.000Z");
    });

    it("needs EVERY panelist free (busy given per employee)", () => {
        const slots = findCommonSlots({
            ...KARACHI,
            now: MONDAY_8AM_PKT,
            count: 3,
            busy: {
                3: [{ start: "2026-10-20T04:00:00Z", end: "2026-10-20T06:00:00Z" }],
                4: [{ start: "2026-10-20T06:00:00Z", end: "2026-10-20T07:00:00Z" }],
            },
        });
        expect(slots[0].start).toBe("2026-10-20T07:00:00.000Z");
    });

    it("treats intervals as half-open (back to back is free)", () => {
        const slots = findCommonSlots({
            ...KARACHI,
            now: MONDAY_8AM_PKT,
            count: 3,
            busy: [{ start: "2026-10-20T04:00:00Z", end: "2026-10-20T05:00:00Z" }],
        });
        expect(slots[0].start).toBe("2026-10-20T05:00:00.000Z");
    });

    it("never runs past the end of the working day", () => {
        // Busy until 17:00 PKT on Tuesday: only 17:00-18:00 is left.
        const slots = findCommonSlots({
            ...KARACHI,
            now: MONDAY_8AM_PKT,
            count: 3,
            to: "2026-10-20T23:00:00Z",
            busy: [{ start: "2026-10-20T04:00:00Z", end: "2026-10-20T12:00:00Z" }],
        });
        expect(starts(slots)).toEqual(["2026-10-20T12:00:00.000Z"]);
        expect(slots[0].end).toBe("2026-10-20T13:00:00.000Z");
    });

    it("skips days of approved leave (whole tenant-local days)", () => {
        const leave = [leaveRowToInterval({ employeeId: 3, startDate: "2026-10-21T00:00:00Z", endDate: "2026-10-22T00:00:00Z" }, "Asia/Karachi")];
        const slots = findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT, leave });
        expect(slots.map((s) => dayOf(s.start))).toEqual(["2026-10-20", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"]);
    });

    it("leave covers 00:00 to 24:00 in the tenant zone", () => {
        expect(leaveRowToInterval({ employeeId: 1, startDate: "2026-10-21T00:00:00Z", endDate: "2026-10-21T00:00:00Z" }, "Asia/Karachi")).toEqual({
            employeeId: 1,
            start: new Date("2026-10-20T19:00:00.000Z"),
            end: new Date("2026-10-21T19:00:00.000Z"),
        });
        expect(leaveRowToInterval({ startDate: "nope" }, "Asia/Karachi")).toBeNull();
    });

    it("skips non-working dates and custom weekdays", () => {
        const slots = findCommonSlots({
            ...KARACHI,
            now: MONDAY_8AM_PKT,
            nonWorkingDates: ["2026-10-23"],
            nonWorkingWeekdays: [0, 3], // Sundays and Wednesdays off; Saturday works
        });
        expect(slots.map((s) => dayOf(s.start))).toEqual(["2026-10-20", "2026-10-22", "2026-10-24", "2026-10-26", "2026-10-27"]);
    });

    it("spreads across the days it has before doubling up, never overlapping", () => {
        const slots = findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT, to: "2026-10-21T23:00:00Z", count: 5 });
        const days = slots.map((s) => dayOf(s.start));
        expect(slots).toHaveLength(5);
        expect(days.filter((d) => d === "2026-10-20")).toHaveLength(3);
        expect(days.filter((d) => d === "2026-10-21")).toHaveLength(2);
        for (let i = 1; i < slots.length; i += 1) {
            if (dayOf(slots[i].start) === dayOf(slots[i - 1].start)) {
                expect(new Date(slots[i].start).getTime()).toBeGreaterThanOrEqual(new Date(slots[i - 1].end).getTime());
            }
        }
    });

    it("keeps the count between 3 and 5", () => {
        expect(findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT, count: 10 })).toHaveLength(5);
        expect(findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT, count: 1 })).toHaveLength(3);
    });

    it("steps on the 30-minute grid from the window start", () => {
        const slots = findCommonSlots({
            ...KARACHI,
            now: MONDAY_8AM_PKT,
            durationMinutes: 45,
            count: 3,
            busy: [{ start: "2026-10-20T04:00:00Z", end: "2026-10-20T04:10:00Z" }],
        });
        expect(slots[0].start).toBe("2026-10-20T04:30:00.000Z");
        expect(slots[0].end).toBe("2026-10-20T05:15:00.000Z");
    });

    it("applies the caller's extra rule", () => {
        const slots = findCommonSlots({
            ...KARACHI,
            now: MONDAY_8AM_PKT,
            count: 3,
            isSlotBlocked: (start) => start.toISOString().startsWith("2026-10-20"),
        });
        expect(dayOf(slots[0].start)).toBe("2026-10-21");
    });

    it("stops after ten working days when no end is given", () => {
        const slots = findCommonSlots({
            ...KARACHI,
            now: MONDAY_8AM_PKT,
            busy: [{ start: "2026-10-19T00:00:00Z", end: "2026-11-03T00:00:00Z" }], // Tue 20 .. Mon 2 Nov
        });
        // Ten working days from Tue 20 Oct end on Mon 2 Nov, so Tue 3 Nov is out of range.
        expect(slots).toEqual([]);
    });

    it("returns nothing for a range that closes before the lead time", () => {
        expect(findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT, to: "2026-10-19T20:00:00Z" })).toEqual([]);
    });

    it("refuses an unknown zone, a bad duration and a bad step", () => {
        expect(() => findCommonSlots({ ...KARACHI, timeZone: "Nowhere/City", now: MONDAY_8AM_PKT })).toThrow(
            expect.objectContaining({ code: "HR-RECRUITMENT-SLOT-TIMEZONE-INVALID", status: 400 }),
        );
        expect(() => findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT, durationMinutes: 10 })).toThrow(
            expect.objectContaining({ code: "HR-RECRUITMENT-SLOT-DURATION-INVALID" }),
        );
        expect(() => findCommonSlots({ ...KARACHI, now: MONDAY_8AM_PKT, stepMinutes: 1 })).toThrow(
            expect.objectContaining({ code: "HR-RECRUITMENT-SLOT-STEP-INVALID" }),
        );
        expect(() => findCommonSlots({ ...KARACHI })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-SLOT-RANGE-INVALID" }));
    });
});

describe("findCommonSlots — Europe/London across the October clock change", () => {
    it("09:00 is 08:00Z before 25 Oct and 09:00Z after", () => {
        const slots = findCommonSlots({
            workdayStart: "09:00",
            workdayEnd: "17:00",
            timeZone: "Europe/London",
            now: "2026-10-21T12:00:00Z", // Wed 13:00 BST
        });
        expect(starts(slots)).toEqual([
            "2026-10-22T12:00:00.000Z", // Thu 13:00 BST (lead time)
            "2026-10-23T08:00:00.000Z", // Fri 09:00 BST
            "2026-10-26T09:00:00.000Z", // Mon 09:00 GMT
            "2026-10-27T09:00:00.000Z",
            "2026-10-28T09:00:00.000Z",
        ]);
    });

    it("the last slot of a winter day ends at 17:00 GMT", () => {
        const slots = findCommonSlots({
            workdayStart: "09:00",
            workdayEnd: "17:00",
            timeZone: "Europe/London",
            now: "2026-10-23T12:00:00Z",
            to: "2026-10-26T23:59:00Z",
            busy: [{ start: "2026-10-26T09:00:00Z", end: "2026-10-26T16:00:00Z" }],
        });
        expect(starts(slots)).toEqual(["2026-10-26T16:00:00.000Z"]);
        expect(slots[0].end).toBe("2026-10-26T17:00:00.000Z");
    });
});

describe("findCommonSlots — a zone west of UTC", () => {
    it("works out the first local day from the lead time", () => {
        // 2026-10-19 22:00 EDT; the lead time ends Tue 20 Oct 22:00 EDT, after
        // that day's window, so Wednesday is the first day.
        const slots = findCommonSlots({
            workdayStart: "09:00",
            workdayEnd: "17:00",
            timeZone: "America/New_York",
            now: "2026-10-20T02:00:00Z",
            count: 3,
        });
        expect(slots[0].start).toBe("2026-10-21T13:00:00.000Z");
    });
});

describe("normalizeIntervals", () => {
    it("drops junk and empty intervals and sorts", () => {
        expect(normalizeIntervals([
            { start: "2026-10-20T05:00:00Z", end: "2026-10-20T06:00:00Z" },
            { start: "bad", end: "2026-10-20T06:00:00Z" },
            { start: "2026-10-20T04:00:00Z", end: "2026-10-20T04:00:00Z" },
            { start: "2026-10-20T01:00:00Z", end: "2026-10-20T02:00:00Z" },
        ]).map((i) => new Date(i.start).toISOString())).toEqual(["2026-10-20T01:00:00.000Z", "2026-10-20T05:00:00.000Z"]);
        expect(normalizeIntervals(null)).toEqual([]);
    });
});
