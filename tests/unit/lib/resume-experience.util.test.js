// tests/unit/lib/resume-experience.util.test.js
//
// Recruitment Phase 7 (D18c) — years of experience from the parsed work
// history: dated entries only, overlaps merged, "present" is the parse time,
// capped at 50, null when nothing is dated.
import { describe, it, expect } from "@jest/globals";

import {
    experienceEntriesOf,
    experienceInterval,
    mergeIntervals,
    parseExperienceDate,
    yearsOfExperienceFrom,
} from "../../../src/lib/resume-experience.util.js";

const PARSED_AT = new Date("2026-10-27T00:00:00Z");

describe("parseExperienceDate", () => {
    it("reads the common resume date shapes as the first day of their period", () => {
        expect(parseExperienceDate("2019")).toEqual(new Date("2019-01-01T00:00:00Z"));
        expect(parseExperienceDate("2019-03")).toEqual(new Date("2019-03-01T00:00:00Z"));
        expect(parseExperienceDate("03/2019")).toEqual(new Date("2019-03-01T00:00:00Z"));
        expect(parseExperienceDate("Mar 2019")).toEqual(new Date("2019-03-01T00:00:00Z"));
        expect(parseExperienceDate("September 2019")).toEqual(new Date("2019-09-01T00:00:00Z"));
        expect(parseExperienceDate("Sept 2019")).toEqual(new Date("2019-09-01T00:00:00Z"));
        expect(parseExperienceDate("2019-03-15")).toEqual(new Date("2019-03-15T00:00:00Z"));
        expect(parseExperienceDate(2019)).toEqual(new Date("2019-01-01T00:00:00Z"));
    });

    it("rejects what is not a date", () => {
        for (const bad of ["", "soon", "Marble 2019", "13/2019", "2019-13", "1066", null, undefined, {}, "present"]) {
            expect(parseExperienceDate(bad)).toBeNull();
        }
    });
});

describe("experienceInterval", () => {
    it("'present', 'current' and a current flag end at the parse time", () => {
        const start = new Date("2024-10-27T00:00:00Z");
        expect(experienceInterval({ startDate: "2024-10-27", endDate: "Present" }, PARSED_AT)).toEqual({ start, end: PARSED_AT });
        expect(experienceInterval({ start: "2024-10-27", end: "current" }, PARSED_AT)).toEqual({ start, end: PARSED_AT });
        expect(experienceInterval({ from: "2024-10-27", current: true }, PARSED_AT)).toEqual({ start, end: PARSED_AT });
    });

    it("an entry without an end (and no current flag), a reversed one, or one starting after the parse is undated", () => {
        expect(experienceInterval({ startDate: "2020" }, PARSED_AT)).toBeNull();
        expect(experienceInterval({ startDate: "2022", endDate: "2020" }, PARSED_AT)).toBeNull();
        expect(experienceInterval({ startDate: "2027", endDate: "present" }, PARSED_AT)).toBeNull();
        expect(experienceInterval({ endDate: "2020" }, PARSED_AT)).toBeNull();
        expect(experienceInterval("2019-2020", PARSED_AT)).toBeNull();
    });

    it("an end after the parse time is clamped to it", () => {
        expect(experienceInterval({ startDate: "2026", endDate: "2030" }, PARSED_AT).end).toEqual(PARSED_AT);
    });
});

describe("mergeIntervals", () => {
    it("merges overlapping and touching intervals, keeps gaps", () => {
        const d = (s) => new Date(`${s}T00:00:00Z`);
        const merged = mergeIntervals([
            { start: d("2018-01-01"), end: d("2020-01-01") },
            { start: d("2015-01-01"), end: d("2016-01-01") },
            { start: d("2019-06-01"), end: d("2021-01-01") }, // overlaps the first
            { start: d("2021-01-01"), end: d("2022-01-01") }, // touches the merged block
            { start: d("2019-01-01"), end: d("2019-02-01") }, // inside it
        ]);
        expect(merged).toEqual([
            { start: d("2015-01-01"), end: d("2016-01-01") },
            { start: d("2018-01-01"), end: d("2022-01-01") },
        ]);
    });
});

describe("yearsOfExperienceFrom", () => {
    it("counts two concurrent jobs once (overlap merge)", () => {
        const years = yearsOfExperienceFrom(
            [
                { title: "Engineer", startDate: "2016-01", endDate: "2020-01" },
                { title: "Freelance", startDate: "2018-01", endDate: "2019-01" }, // inside the first
                { title: "Lead", startDate: "2019-07", endDate: "2021-01" }, // overlaps the first
            ],
            PARSED_AT,
        );
        // 2016-01 .. 2021-01 merged = 5 years (not 4 + 1 + 1.5).
        expect(years).toBe(5);
    });

    it("adds disjoint periods and runs a current job to the parse time", () => {
        const years = yearsOfExperienceFrom(
            [
                { startDate: "2014", endDate: "2016" },
                { startDate: "2024-10-27", endDate: "present" },
            ],
            PARSED_AT,
        );
        expect(years).toBe(4);
    });

    it("ignores undated entries next to dated ones", () => {
        expect(yearsOfExperienceFrom([{ startDate: "2020" }, { startDate: "2021", endDate: "2023" }, { title: "x" }], PARSED_AT)).toBe(2);
    });

    it("is null when no entry is dated, and for no entries", () => {
        expect(yearsOfExperienceFrom([{ title: "Engineer" }, { startDate: "2020" }], PARSED_AT)).toBeNull();
        expect(yearsOfExperienceFrom([], PARSED_AT)).toBeNull();
        expect(yearsOfExperienceFrom(undefined, PARSED_AT)).toBeNull();
    });

    it("caps at 50 years", () => {
        expect(yearsOfExperienceFrom([{ startDate: "1950", endDate: "present" }], PARSED_AT)).toBe(50);
    });

    it("is deterministic at a given parse time ('present' does not read the clock)", () => {
        const entries = [{ startDate: "2020-01", endDate: "present" }];
        expect(yearsOfExperienceFrom(entries, new Date("2021-01-01T00:00:00Z"))).toBe(1);
        expect(yearsOfExperienceFrom(entries, new Date("2021-01-01T00:00:00Z"))).toBe(1);
    });
});

describe("experienceEntriesOf", () => {
    it("reads the first work-history key holding an array", () => {
        expect(experienceEntriesOf({ workExperience: [{ a: 1 }] })).toEqual([{ a: 1 }]);
        expect(experienceEntriesOf({ experience: "ten years", employment: [{ b: 2 }] })).toEqual([{ b: 2 }]);
        expect(experienceEntriesOf({ skills: [] })).toEqual([]);
        expect(experienceEntriesOf(null)).toEqual([]);
    });
});
