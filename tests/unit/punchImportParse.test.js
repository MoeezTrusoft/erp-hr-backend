import { describe, expect, it } from "@jest/globals";
import { daysBetween, importToken, normaliseTimestamp, parsePunchLog, runs } from "../../src/lib/punchImportParse.js";

describe("punch log parser", () => {
  it("accepts ISO and day-first stamps", () => {
    expect(normaliseTimestamp("2026-10-12 9:05")).toBe("2026-10-12 09:05:00");
    expect(normaliseTimestamp("12/10/2026 18:30:15")).toBe("2026-10-12 18:30:15");
    expect(normaliseTimestamp("31/02/2026 18:30")).not.toBeNull(); // calendar check happens in the capture parser
    expect(normaliseTimestamp("tomorrow")).toBeNull();
  });
  it("parses a headed CSV, defaults status, and reports bad lines", () => {
    const r = parsePunchLog('User ID,Time,Status\n3004,2026-10-13 08:01:02,0\n3004,"13/10/2026 17:00",1\n,2026-10-13 09:00,0\n3126,nonsense\n');
    expect(r.rows.map((x) => x.raw)).toEqual([
      "3004\t2026-10-13 08:01:02\t0\t0\t0",
      "3004\t2026-10-13 17:00:00\t1\t0\t0",
    ]);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5]);
    expect(r.from).toBe("2026-10-13");
    expect(r.ids).toEqual(["3004"]);
  });
  it("reads tab files without a header", () => {
    const r = parsePunchLog("505\t2026-09-08 09:00:00\n505\t2026-09-08 18:00:00\t1\n");
    expect(r.rows).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
  });
  it("binds the token to device and content", () => {
    const a = parsePunchLog("1,2026-10-13 08:00:00,0").rows;
    expect(importToken("S1", a)).toBe(importToken("S1", a));
    expect(importToken("S1", a)).not.toBe(importToken("S2", a));
  });
});


describe("period helpers", () => {
  it("lists days and collapses runs across month ends", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(runs(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-04"])).toEqual([
      { from: "2026-10-30", to: "2026-11-01" },
      { from: "2026-11-04", to: "2026-11-04" },
    ]);
  });
});
