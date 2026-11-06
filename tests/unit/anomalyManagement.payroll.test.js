import { describe, it, expect } from "@jest/globals";
import {
  combinedAttendanceDeductions,
  manualDeductionsByShift,
} from "../../src/lib/anomalyPayroll.js";
import { countViolationDays } from "../../src/lib/attendanceDeduction.js";
import { ruleDeductions } from "../../src/lib/attendanceAnomalyRules.js";
import { buildPayslipFromInputs } from "../../src/services/payrollService.js";
const date = "2026-10-05T00:00:00Z";
const marked = (id, days, extra = {}) => ({
  id,
  date,
  type: "LATE_CHECKIN",
  status: "REJECTED",
  manualDeductionDays: days,
  ...extra,
});
const lateRule = {
  ruleKey: "LATE",
  enabled: true,
  triggerCount: 3,
  deductionDays: 1,
};
describe("management attendance deductions", () => {
  it("uses the highest manual marking once per shift", () =>
    expect(
      manualDeductionsByShift([
        marked(1, 0.5),
        marked(2, 0.5),
        marked(3, 1),
      ]).get("2026-10-05"),
    ).toBe(1));
  it("does not count the same persisted anomaly twice", () =>
    expect(
      manualDeductionsByShift([marked(1, 0.5), marked(1, 0.5)]).get(
        "2026-10-05",
      ),
    ).toBe(0.5));
  it("replaces half-day automatic credit loss with the manual half-day marking", () =>
    expect(
      combinedAttendanceDeductions({
        attendance: [{ date, status: "HALF_DAY", day_credit: 0.5 }],
        anomalies: [marked(1, 0.5)],
        config: { absenceRecoveryEnabled: true },
      }),
    ).toEqual([
      { date: "2026-10-05", automaticDays: 0, manualDays: 0.5, days: 0.5 },
    ]));
  it("does not charge a full absence again", () =>
    expect(
      combinedAttendanceDeductions({
        attendance: [{ date, status: "ABSENT", day_credit: 0 }],
        anomalies: [marked(1, 1)],
        config: { absenceRecoveryEnabled: true },
      })[0].days,
    ).toBe(1));
  it("keeps half-day markings even when automatic deductions are disabled", () =>
    expect(
      combinedAttendanceDeductions({ anomalies: [marked(1, 0.5)] })[0].days,
    ).toBe(0.5));
  it("excuses the shift when any request category is approved", () =>
    expect(
      countViolationDays({
        attendance: [{ date, status: "LATE" }],
        anomalies: [{ date, type: "EARLY_CHECKOUT", status: "APPROVED" }],
      }),
    ).toEqual([]));
  it.each(["GROSS", "POOLED_FLOOR", "POOLED_FLOOR_DIRECT"])(
    "excludes manually marked shifts from automatic threshold counters in %s mode",
    (deductionBasis) => {
      const attendance = [3, 4, 5].map((d) => ({
        date: `2026-10-0${d}`,
        status: "LATE",
        day_credit: 1,
      }));
      const result = combinedAttendanceDeductions({
        attendance,
        anomalies: [marked(1, 0.5)],
        rules: [lateRule],
        config: { deductionBasis },
      });
      expect(result).toEqual([
        { date: "2026-10-05", automaticDays: 0, manualDays: 0.5, days: 0.5 },
      ]);
    },
  );
  it("keeps different shifts separate and is stable under input reordering", () => {
    const anomalies = [marked(1, 0.5), marked(2, 1, { date: "2026-10-06" })];
    expect(combinedAttendanceDeductions({ anomalies })).toEqual(
      combinedAttendanceDeductions({ anomalies: [...anomalies].reverse() }),
    );
    expect(
      combinedAttendanceDeductions({ anomalies }).reduce(
        (n, l) => n + l.days,
        0,
      ),
    ).toBe(1.5);
  });
  it("does not feed historical arbitrary marks into current payroll", () => {
    const slip = buildPayslipFromInputs({
      employee: { id: 1 },
      employmentTerm: {
        baseSalary: 31000,
        payFrequency: "MONTHLY",
        currency: "PKR",
      },
      assignments: [],
      payrollRun: {
        periodStart: new Date("2026-10-01"),
        periodEnd: new Date("2026-10-31"),
        countryCode: "PK",
        currencyCode: "PKR",
      },
      taxRateRows: [],
      asOf: new Date("2026-10-31"),
      bridges: {
        anomalyRows: [marked(1, 0.5), marked(2, 1)],
        attendanceRows: [{ date, status: "ABSENT", day_credit: 0 }],
        attendanceDeductionRules: [],
      },
      ruleConfig: { absenceRecoveryEnabled: true },
    });
    expect(
      slip.deductions
        .filter((d) => d.code === "MANAGEMENT_ATTENDANCE_DEDUCTION")
        .map((d) => Number(d.amount)),
    ).toEqual([]);
    expect(slip.deductions.some((d) => d.code === "ABSENCE_RECOVERY")).toBe(
      false,
    );
  });
});

it("replaces a full-day automatic absence with only a half-day manual mark", () => {
  expect(
    combinedAttendanceDeductions({
      attendance: [{ date, status: "ABSENT", day_credit: 0 }],
      anomalies: [marked(1, 0.5)],
      config: { absenceRecoveryEnabled: true },
    }),
  ).toEqual([
    { date: "2026-10-05", automaticDays: 0, manualDays: 0.5, days: 0.5 },
  ]);
});
it("restores automatic attendance deductions when all manual markings are cleared", () => {
  expect(
    combinedAttendanceDeductions({
      attendance: [{ date, status: "ABSENT", day_credit: 0 }],
      anomalies: [{ ...marked(1, 0.5), manualDeductionDays: null }],
      config: { absenceRecoveryEnabled: true },
    })[0].days,
  ).toBe(1);
});

// Management's explicit deduction on a rejection (operator, 2026-11-05): half,
// one or two days, replacing the attendance policy's pricing for that work date.
const ruleCase = (id, extra = {}) => ({
  id,
  employeeId: 1,
  date: "2026-10-05T00:00:00Z",
  sessionKey: "s1",
  type: "ABSENT",
  rulesVersion: 2,
  status: "REJECTED",
  decisionRole: "Management",
  evidenceState: "ACTIVE",
  ...extra,
});
describe("management explicit deduction in the rules payroll", () => {
  it("prices the marked day at the chosen days instead of the policy", () => {
    expect(ruleDeductions([ruleCase(1, { manualDeductionDays: 2 })])).toMatchObject({
      days: 2,
    });
    expect(ruleDeductions([ruleCase(1)])).toMatchObject({ days: 1 });
  });

  it("takes the highest marking once for the employee's work date", () => {
    const result = ruleDeductions([
      ruleCase(1, { manualDeductionDays: 0.5 }),
      ruleCase(2, {
        type: "MISSING_CHECKOUT",
        sessionKey: "s2",
        manualDeductionDays: 1,
      }),
    ]);
    expect(result.days).toBe(1);
    expect(result.lines).toEqual([
      { anomalyIds: [1, 2], days: 1, date: "2026-10-05", manual: true },
    ]);
  });

  it("removes a marked day from the automatic missing-punch pool", () => {
    const result = ruleDeductions([
      ruleCase(1, { type: "MISSING_CHECKOUT", date: "2026-10-01T00:00:00Z", sessionKey: "s1" }),
      ruleCase(2, { type: "MISSING_CHECKOUT", date: "2026-10-02T00:00:00Z", sessionKey: "s2" }),
      ruleCase(3, {
        type: "MISSING_CHECKOUT",
        date: "2026-10-03T00:00:00Z",
        sessionKey: "s3",
        manualDeductionDays: 2,
      }),
    ]);
    // The two unmarked misses no longer complete the pool of three.
    expect(result).toMatchObject({ days: 2, missingCount: 2 });
  });

  it("ignores a marking on a case Management did not reject", () => {
    expect(
      ruleDeductions([ruleCase(1, { status: "APPROVED", manualDeductionDays: 1 })])
        .days,
    ).toBe(0);
    expect(
      ruleDeductions([
        { ...ruleCase(1), status: "PENDING", decisionRole: null, lapsed: true, manualDeductionDays: 2 },
      ]).days,
    ).toBe(1);
  });

  it("refuses a marking outside half, one or two days", () => {
    expect(() =>
      ruleDeductions([ruleCase(1, { manualDeductionDays: 1.5 })]),
    ).toThrow("Invalid manual attendance deduction");
  });

  it("prices a two-day marking into the payslip at two daily rates", () => {
    const slip = buildPayslipFromInputs({
      employee: { id: 1 },
      employmentTerm: {
        baseSalary: 31000,
        payFrequency: "MONTHLY",
        currency: "PKR",
      },
      assignments: [],
      payrollRun: {
        periodStart: new Date("2026-10-01"),
        periodEnd: new Date("2026-10-31"),
        countryCode: "PK",
        currencyCode: "PKR",
      },
      taxRateRows: [],
      asOf: new Date("2026-10-31"),
      bridges: { anomalyRows: [ruleCase(1, { manualDeductionDays: 2 })] },
      ruleConfig: { absenceRecoveryEnabled: true },
    });
    const line = slip.deductions.find((d) => d.code === "ATTENDANCE_RULES_V2");
    // 31,000 over 31 calendar days = 1,000 a day; two days = 2,000.
    expect(line.amount).toBe("2000.0000");
    expect(line.description).toBe("Management-disapproved attendance: 2 day(s)");
  });
});

it("two half-day markings still deduct only half a day", () => {
  expect(
    manualDeductionsByShift([marked(1, 0.5), marked(2, 0.5)]).get("2026-10-05"),
  ).toBe(0.5);
});
it("ignores legacy manual half-day markings and automatic absence", () => {
  const slip = buildPayslipFromInputs({
    employee: { id: 1 },
    employmentTerm: {
      baseSalary: 31000,
      payFrequency: "MONTHLY",
      currency: "PKR",
    },
    assignments: [],
    payrollRun: {
      periodStart: new Date("2026-10-01"),
      periodEnd: new Date("2026-10-31"),
      countryCode: "PK",
      currencyCode: "PKR",
    },
    taxRateRows: [],
    asOf: new Date("2026-10-31"),
    bridges: {
      anomalyRows: [marked(1, 0.5), marked(2, 0.5)],
      attendanceRows: [{ date, status: "ABSENT", day_credit: 0 }],
      attendanceDeductionRules: [],
    },
    ruleConfig: { absenceRecoveryEnabled: true },
  });
  expect(
    slip.deductions
      .filter((d) => d.code === "MANAGEMENT_ATTENDANCE_DEDUCTION")
      .map((d) => Number(d.amount)),
  ).toEqual([]);
  expect(slip.deductions.some((d) => d.code === "ABSENCE_RECOVERY")).toBe(
    false,
  );
});
