// HR-ATT-IMPORT-01 — the pure logic of the attendance importer.
//
// Deliberately no DB: the parts carrying real risk are the ones that silently
// corrupt six years of history — a misread date, a leave range exploded into
// per-day rows, an anomaly landing PENDING in the live review queue.

// No module mocks: every function under test here is pure. Constructing the
// Prisma client at import time does not open a connection, so the service can
// be imported directly — which also proves its import graph is clean.
import {
  parseDate,
  parseTime,
  validateRow,
  collapseLeaves,
} from "../src/services/attendanceImport.service.js";

const lookup = { byCode: new Map([["e-1042", 1042]]), count: 1 };
const run = (row, seen = new Set()) => validateRow(row, lookup, seen);
const iso = (d) => d.toISOString().slice(0, 10);

describe("parseDate", () => {
  it("reads ISO", () => expect(iso(parseDate("2021-03-01"))).toBe("2021-03-01"));

  it("reads dd/mm/yyyy day-first, not month-first", () => {
    // 03/04/2021 is 3 April. Month-first would silently shift it to 4 March and
    // land every ambiguous date in the file on the wrong day.
    expect(iso(parseDate("03/04/2021"))).toBe("2021-04-03");
  });

  it("rejects an impossible date instead of rolling it over", () => {
    expect(parseDate("2021-02-30")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });
});

describe("parseTime", () => {
  const day = parseDate("2021-03-01");
  it("anchors the time to the row's own day", () => {
    expect(parseTime("09:02", day).toISOString()).toBe("2021-03-01T09:02:00.000Z");
  });
  it("understands 12-hour clocks", () => {
    expect(parseTime("6:05 pm", day).toISOString()).toBe("2021-03-01T18:05:00.000Z");
    expect(parseTime("12:30 am", day).toISOString()).toBe("2021-03-01T00:30:00.000Z");
  });
  it("returns null for junk rather than guessing", () => {
    expect(parseTime("25:99", day)).toBeNull();
    expect(parseTime("", day)).toBeNull();
  });
});

describe("validateRow", () => {
  it("accepts a clean present day and computes hours", () => {
    const r = run({ employee_code: "E-1042", date: "2021-03-01", day_type: "WORKING", status: "PRESENT", check_in: "09:00", check_out: "17:30", work_mode: "Onsite" });
    expect(r.ok).toBe(true);
    expect(r.value.totalHours).toBe(8.5);
  });

  it("rejects an unknown employee code with a readable message", () => {
    const r = run({ employee_code: "GHOST", date: "2021-03-01" });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/No employee with code "GHOST"/);
  });

  it("normalises work_mode synonyms", () => {
    expect(run({ employee_code: "E-1042", date: "2021-03-01", work_mode: "WFH" }).value.workMode).toBe("Remote");
    expect(run({ employee_code: "E-1042", date: "2021-03-01", work_mode: "work from home" }).value.workMode).toBe("Remote");
  });

  it("treats a missing check-out as missing, not as zero hours", () => {
    const r = run({ employee_code: "E-1042", date: "2021-03-03", check_in: "09:00" });
    expect(r.ok).toBe(true);
    expect(r.value.checkOut).toBeNull();
    expect(r.value.totalHours).toBeNull();
  });

  it("reads an overnight shift as +1 day instead of negative hours", () => {
    const r = run({ employee_code: "E-1042", date: "2021-03-01", check_in: "22:00", check_out: "06:00" });
    expect(r.value.totalHours).toBe(8);
    expect(r.fixes.join(" ")).toMatch(/overnight/);
  });

  it("defaults a historical anomaly to APPROVED so it never lands in the review queue", () => {
    const r = run({ employee_code: "E-1042", date: "2021-03-02", check_in: "10:47", anomaly_type: "LATE_CHECKIN" });
    expect(r.value.resolution).toBe("APPROVED");
  });

  it("infers day_type LEAVE when only leave_type is filled", () => {
    const r = run({ employee_code: "E-1042", date: "2021-03-04", leave_type: "annual" });
    expect(r.value.dayType).toBe("LEAVE");
    expect(r.value.leaveType).toBe("ANNUAL");
  });

  it("flags a LEAVE day with no leave_type", () => {
    const r = run({ employee_code: "E-1042", date: "2021-03-04", day_type: "LEAVE" });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/leave_type is empty/);
  });

  it("catches the same employee-day twice in one file", () => {
    const seen = new Set();
    run({ employee_code: "E-1042", date: "2021-03-01" }, seen);
    const dup = run({ employee_code: "E-1042", date: "2021-03-01" }, seen);
    expect(dup.ok).toBe(false);
    expect(dup.issues.join(" ")).toMatch(/appears earlier in this file/);
  });
});

describe("collapseLeaves", () => {
  const leaveDay = (d, type = "ANNUAL") => ({
    employeeId: 1042, dayType: "LEAVE", leaveType: type, date: parseDate(d),
  });

  it("merges consecutive same-type days into ONE request", () => {
    const out = collapseLeaves([leaveDay("2021-03-04"), leaveDay("2021-03-05"), leaveDay("2021-03-06")]);
    expect(out).toHaveLength(1);
    expect(out[0].total_days).toBe(3);
    expect(iso(out[0].start_date)).toBe("2021-03-04");
    expect(iso(out[0].end_date)).toBe("2021-03-06");
  });

  it("splits on a gap", () => {
    const out = collapseLeaves([leaveDay("2021-03-04"), leaveDay("2021-03-08")]);
    expect(out).toHaveLength(2);
  });

  it("splits when the leave type changes on an adjacent day", () => {
    const out = collapseLeaves([leaveDay("2021-03-04", "ANNUAL"), leaveDay("2021-03-05", "SICK")]);
    expect(out.map((l) => l.type)).toEqual(["ANNUAL", "SICK"]);
  });

  it("ignores non-leave days", () => {
    expect(collapseLeaves([{ employeeId: 1042, dayType: "WORKING", date: parseDate("2021-03-01") }])).toHaveLength(0);
  });
});
