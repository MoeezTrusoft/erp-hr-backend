// Plan item 2.1 (D1): the configured deduction rules drive payroll, and the
// defaults price exactly like the code that was hard-coded before.
import { describe, it, expect } from "@jest/globals";
import {
  ruleDeductions,
  deductionRulesFromPolicy,
  DEFAULT_DEDUCTION_RULES,
} from "../../src/lib/attendanceAnomalyRules.js";
import { ruleDeductions as before } from "../fixtures/attendanceAnomalyRules.before-configurable.js";
import {
  loadDeductionRules,
  snapshotDeductionRules,
  rulesForRun,
} from "../../src/services/deductionRules.service.js";
import { updateAttendancePolicy } from "../../src/services/attendancePolicyConfig.service.js";

let id = 0;
const base = { rulesVersion: 2, status: "REJECTED", evidenceState: "ACTIVE", decisionRole: "Management" };
const mk = (employeeId, day, type, minutes = null) => {
  const expected = new Date(`2026-09-${String(day).padStart(2, "0")}T09:00:00Z`);
  return {
    ...base,
    id: ++id,
    employeeId,
    date: expected,
    sessionKey: `s${id}`,
    type,
    measuredMinutes: minutes,
    expectedTime: expected,
    actualTime: new Date(+expected + (minutes ?? 0) * 60000),
  };
};
const PERIOD = { from: new Date("2026-09-01"), to: new Date("2026-09-30") };
// A fixture covering every line kind, several employees and pool remainders.
const fixture = () => [
  mk(1, 1, "ABSENT"),
  mk(1, 2, "MISSING_CHECKIN"),
  mk(1, 3, "MISSING_CHECKOUT"),
  mk(1, 4, "LATE_CHECKIN", 45),
  mk(1, 5, "EARLY_CHECKOUT", 31),
  mk(2, 1, "LATE_CHECKIN", 10),
  mk(2, 2, "LATE_CHECKIN", 20),
  mk(2, 3, "EARLY_CHECKOUT", 30),
  mk(2, 4, "LATE_CHECKIN", 5),
  mk(2, 5, "LATE_CHECKIN", 6),
  mk(3, 9, "LATE_CHECKIN", 12),
  mk(3, 10, "LATE_CHECKIN", 12),
  { ...mk(4, 11, "ABSENT"), status: "APPROVED" }, // not priced
  { ...mk(4, 12, "ABSENT"), decisionRole: "HR" }, // not priced
];

describe("defaults are today's behaviour", () => {
  it("DEFAULT_DEDUCTION_RULES hold the formerly hard-coded values", () => {
    expect(DEFAULT_DEDUCTION_RULES).toEqual({
      majorThresholdMinutes: 30,
      poolSize: 3,
      absentDays: 1,
      missingPunchDays: 0.5,
      majorTimingDays: 0.5,
      pooledMinorDays: 1,
    });
  });
  it("prices the fixture identically to the previous implementation", () => {
    const rows = fixture();
    expect(ruleDeductions(rows, PERIOD)).toEqual(before(rows, PERIOD));
    expect(ruleDeductions(rows, { ...PERIOD, rules: DEFAULT_DEDUCTION_RULES })).toEqual(
      before(rows, PERIOD),
    );
    // sanity: the fixture really exercises every kind of line
    const result = before(rows, PERIOD);
    expect(result.days).toBeGreaterThan(3);
    expect(result.lines.some((l) => l.pooled)).toBe(true);
    expect(result.minorRemainder).toBeGreaterThan(0);
  });
  it("matches on 200 randomised months", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const types = ["ABSENT", "MISSING_CHECKIN", "MISSING_CHECKOUT", "LATE_CHECKIN", "EARLY_CHECKOUT"];
    for (let run = 0; run < 200; run++) {
      const rows = [];
      for (let n = 0; n < 1 + Math.floor(rand() * 25); n++) {
        const type = types[Math.floor(rand() * types.length)];
        const minutes = /LATE|EARLY/.test(type) ? 1 + Math.floor(rand() * 90) : null;
        rows.push(mk(1 + Math.floor(rand() * 4), 1 + Math.floor(rand() * 28), type, minutes));
      }
      expect(ruleDeductions(rows, PERIOD)).toEqual(before(rows, PERIOD));
    }
  });
});

describe("settings change the pricing", () => {
  it("raising the major threshold turns a 45 minute case into a pooled minor one", () => {
    const rows = [mk(1, 4, "LATE_CHECKIN", 45)];
    expect(ruleDeductions(rows, PERIOD).days).toBe(0.5);
    const lax = ruleDeductions(rows, { ...PERIOD, rules: { majorThresholdMinutes: 60 } });
    expect(lax.days).toBe(0);
    expect(lax.minorCount).toBe(1);
  });
  it("pool size and pooled days apply per employee and never carry over", () => {
    const four = [1, 2, 3, 4].map((d) => mk(1, d, "LATE_CHECKIN", 10));
    expect(ruleDeductions(four, { ...PERIOD, rules: { poolSize: 2, pooledMinorDays: 0.75 } }).days).toBe(1.5);
    // 4 minors with a pool of 3: one pooled deduction, one left over (not carried).
    const result = ruleDeductions(four, PERIOD);
    expect(result.days).toBe(1);
    expect(result.minorRemainder).toBe(1);
  });
  it("day values per anomaly type are configurable", () => {
    const rows = [mk(1, 1, "ABSENT"), mk(1, 2, "MISSING_CHECKIN"), mk(1, 3, "LATE_CHECKIN", 40)];
    const rules = { absentDays: 2, missingPunchDays: 0.25, majorTimingDays: 0.75 };
    expect(ruleDeductions(rows, { ...PERIOD, rules }).days).toBe(3);
  });
  it("a partial rules object keeps the defaults for what it omits", () => {
    expect(ruleDeductions([mk(1, 1, "ABSENT")], { ...PERIOD, rules: { poolSize: 5 } }).days).toBe(1);
  });
});

describe("rules from the policy row", () => {
  it("an empty or missing policy is exactly the defaults", () => {
    expect(deductionRulesFromPolicy({})).toEqual(DEFAULT_DEDUCTION_RULES);
    expect(deductionRulesFromPolicy(null)).toEqual(DEFAULT_DEDUCTION_RULES);
  });
  it("reads the policy columns and ignores out-of-range values", () => {
    const rules = deductionRulesFromPolicy({
      deductMajorThresholdMinutes: 45,
      deductPoolSize: 0, // invalid: keeps 3
      deductAbsentDays: 2,
      deductMissingPunchDays: -1, // invalid: keeps 0.5
    });
    expect(rules).toMatchObject({ majorThresholdMinutes: 45, poolSize: 3, absentDays: 2, missingPunchDays: 0.5 });
  });
});

// Minimal in-memory db for the policy row and the audit log.
const memoryDb = () => {
  const audit = [];
  let policy = null;
  return {
    audit,
    attendancePolicyConfig: {
      findUnique: async () => policy,
      set: (row) => (policy = row),
    },
    payrollAuditLog: {
      findFirst: async ({ where }) =>
        [...audit].reverse().find((r) => r.tenantId === where.tenantId && r.payrollRunId === where.payrollRunId && r.action === where.action) ?? null,
      create: async ({ data }) => {
        const row = { id: audit.length + 1, ...data };
        audit.push(row);
        return row;
      },
    },
  };
};

describe("rules kept with each payroll run", () => {
  it("loads the live rules and falls back to the defaults", async () => {
    const db = memoryDb();
    expect(await loadDeductionRules("t", db)).toEqual(DEFAULT_DEDUCTION_RULES);
    db.attendancePolicyConfig.set({ deductPoolSize: 4 });
    expect((await loadDeductionRules("t", db)).poolSize).toBe(4);
  });
  it("an already-priced run keeps its rules when the configuration changes later", async () => {
    const db = memoryDb();
    db.attendancePolicyConfig.set({ deductAbsentDays: 1 });
    const priced = await loadDeductionRules("t", db);
    await snapshotDeductionRules(db, { tenantId: "t", runId: 7, rules: priced });
    db.attendancePolicyConfig.set({ deductAbsentDays: 3 }); // HR edits afterwards
    expect((await rulesForRun(db, { tenantId: "t", runId: 7 })).absentDays).toBe(1);
    // a run with no snapshot (older than this change) uses the live rules
    expect((await rulesForRun(db, { tenantId: "t", runId: 8 })).absentDays).toBe(3);
  });
  it("re-processing with unchanged rules does not stack identical snapshots", async () => {
    const db = memoryDb();
    const rules = { ...DEFAULT_DEDUCTION_RULES };
    await snapshotDeductionRules(db, { tenantId: "t", runId: 1, rules });
    await snapshotDeductionRules(db, { tenantId: "t", runId: 1, rules });
    expect(db.audit).toHaveLength(1);
    await snapshotDeductionRules(db, { tenantId: "t", runId: 1, rules: { ...rules, poolSize: 4 } });
    expect(db.audit).toHaveLength(2);
  });
});

describe("policy editor validation", () => {
  it("rejects values the pricing could not use", async () => {
    await expect(updateAttendancePolicy({ tenantId: "t", deductPoolSize: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(updateAttendancePolicy({ tenantId: "t", deductAbsentDays: 32 })).rejects.toMatchObject({ status: 400 });
    await expect(updateAttendancePolicy({ tenantId: "t", deductMajorThresholdMinutes: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(updateAttendancePolicy({ tenantId: "t", minSessionMinutes: 1.5 })).rejects.toMatchObject({ status: 400 });
  });
});
