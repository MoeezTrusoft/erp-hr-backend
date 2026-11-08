// F-01: month-on-month swing gate. Edge cases a payroll QA would try.
import { describe, it, expect } from "@jest/globals";
import { unexplainedVariances, cleanReason, VARIANCE_ACK_ACTION } from "../../src/lib/payslipVariance.js";

const run = { id: 9, periodStart: new Date("2026-10-01T00:00:00Z") };

// db fake: current payslips, previous payslips (already newest-first), earnings, acks.
const fakeDb = ({ current, previous = [], earnings = [], acks = [] }) => {
  const calls = { previousWhere: null };
  return {
    calls,
    payrollPayslip: {
      findMany: async ({ where }) => {
        if (where.payrollRunId === run.id) return current;
        calls.previousWhere = where;
        return previous;
      },
    },
    payrollEarning: { findMany: async () => earnings },
    payrollAuditLog: { findMany: async () => acks },
  };
};
const slip = (id, employeeId, gross) => ({ id, employeeId, grossAmount: gross });
const ids = (list) => list.map((v) => v.employeeId);

describe("unexplainedVariances", () => {
  it("flags a swing above 10% in either direction, not 10% or below", async () => {
    const db = fakeDb({
      current: [slip(1, 1, "110000"), slip(2, 2, "110001"), slip(3, 3, "89999"), slip(4, 4, "90000"), slip(5, 5, "100000")],
      previous: [slip(11, 1, "100000"), slip(12, 2, "100000"), slip(13, 3, "100000"), slip(14, 4, "100000"), slip(15, 5, "100000")],
    });
    expect(ids(await unexplainedVariances(db, { tenantId: "t", run }))).toEqual([2, 3]);
  });

  it("catches the 2.2x overpayment (salary total stored as Basic)", async () => {
    const db = fakeDb({ current: [slip(1, 1, "166666")], previous: [slip(11, 1, "75000")] });
    const [v] = await unexplainedVariances(db, { tenantId: "t", run });
    expect(v).toMatchObject({ employeeId: 1, previous: 75000, current: 166666 });
    expect(v.pct).toBeGreaterThan(120);
  });

  it("skips new joiners and a previous gross of zero", async () => {
    const db = fakeDb({ current: [slip(1, 1, "50000"), slip(2, 2, "50000")], previous: [slip(12, 2, "0")] });
    expect(await unexplainedVariances(db, { tenantId: "t", run })).toEqual([]);
  });

  it("skips a swing that is only proration, on either side", async () => {
    const base = { current: [slip(1, 1, "50000"), slip(2, 2, "50000")], previous: [slip(11, 1, "100000"), slip(12, 2, "100000")] };
    const onCurrent = fakeDb({ ...base, earnings: [{ payslipId: 1, description: "Base salary (prorated 50.0%) for 2026-10-01 to 2026-10-31" }] });
    expect(ids(await unexplainedVariances(onCurrent, { tenantId: "t", run }))).toEqual([2]);
    const onPrevious = fakeDb({ ...base, earnings: [{ payslipId: 12, description: "Base salary (Prorated 50.0%)" }] });
    expect(ids(await unexplainedVariances(onPrevious, { tenantId: "t", run }))).toEqual([1]);
  });

  it("compares against the most recent earlier payslip and never a cancelled run", async () => {
    const db = fakeDb({ current: [slip(1, 1, "100000")], previous: [slip(21, 1, "100000"), slip(11, 1, "40000")] });
    expect(await unexplainedVariances(db, { tenantId: "t", run })).toEqual([]);
    expect(JSON.stringify(db.calls.previousWhere)).toContain('"status":{"not":"CANCELLED"}');
    expect(JSON.stringify(db.calls.previousWhere)).toContain('"periodStart":{"lt"');
  });

  it("an explanation clears the flag only for the gross it explained", async () => {
    const current = [slip(1, 1, "150000.0000")],
      previous = [slip(11, 1, "100000")];
    const explained = fakeDb({ current, previous, acks: [{ employeeId: 1, newValues: { grossAmount: 150000 } }] });
    expect(await unexplainedVariances(explained, { tenantId: "t", run })).toEqual([]);
    const recalculated = fakeDb({ current: [slip(1, 1, "175000.0000")], previous, acks: [{ employeeId: 1, newValues: { grossAmount: 150000 } }] });
    expect(ids(await unexplainedVariances(recalculated, { tenantId: "t", run }))).toEqual([1]);
  });

  it("treats a malformed or missing acknowledgement as unexplained", async () => {
    const previous = [slip(11, 1, "100000")],
      current = [slip(1, 1, "150000")];
    for (const newValues of [null, {}, "garbage", { grossAmount: null }]) {
      const db = fakeDb({ current, previous, acks: [{ employeeId: 1, newValues }] });
      expect(ids(await unexplainedVariances(db, { tenantId: "t", run }))).toEqual([1]);
    }
  });

  it("includeAcknowledged still lists explained swings (used when recording a new one)", async () => {
    const db = fakeDb({ current: [slip(1, 1, "150000")], previous: [slip(11, 1, "100000")], acks: [{ employeeId: 1, newValues: { grossAmount: 150000 } }] });
    expect(ids(await unexplainedVariances(db, { tenantId: "t", run, includeAcknowledged: true }))).toEqual([1]);
  });

  it("returns nothing for a run with no payslips", async () => {
    expect(await unexplainedVariances(fakeDb({ current: [] }), { tenantId: "t", run })).toEqual([]);
  });

  it("uses a stable audit action name", () => {
    expect(VARIANCE_ACK_ACTION).toBe("PAYSLIP_VARIANCE_ACKNOWLEDGED");
  });
});

describe("cleanReason", () => {
  it("collapses whitespace and accepts a real explanation", () => {
    expect(cleanReason("  Approved\n raise   effective Oct  ")).toBe("Approved raise effective Oct");
  });
  it("rejects empty, whitespace-only, too short and too long text", () => {
    for (const bad of [undefined, null, "", "          ", "short", "x".repeat(501)]) expect(() => cleanReason(bad)).toThrow();
    try { cleanReason("short"); } catch (e) { expect(e.status).toBe(400); }
  });
  it("rejects ten spaces dressed up as a reason", () => {
    expect(() => cleanReason("a         b")).toThrow(); // collapses to "a b"
    expect(() => cleanReason(" ".repeat(12))).toThrow();
  });
});
