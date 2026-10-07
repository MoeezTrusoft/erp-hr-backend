import { describe, it, expect } from "@jest/globals";
import {
  combinedAttendanceDeductions,
  manualDeductionsByShift,
} from "../../src/lib/anomalyPayroll.js";
import { countViolationDays } from "../../src/lib/attendanceDeduction.js";
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
  it("does not excuse lateness when a separate early-checkout request is approved", () =>
    expect(
      countViolationDays({
        attendance: [{ date, status: "LATE" }],
        anomalies: [{ date, type: "EARLY_CHECKOUT", status: "APPROVED" }],
      }),
    ).toEqual([{ ruleKey: "LATE", day: "2026-10-05" }]));
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
  it("prices capped days through the real payroll engine and the configured daily salary rate", () => {
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
    ).toEqual([1000]);
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

it("two half-day markings still deduct only half a day", () => {
  expect(
    manualDeductionsByShift([marked(1, 0.5), marked(2, 0.5)]).get("2026-10-05"),
  ).toBe(0.5);
});
it("prices only the manual half day even when automatic absence was a full day", () => {
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
  ).toEqual([500]);
  expect(slip.deductions.some((d) => d.code === "ABSENCE_RECOVERY")).toBe(
    false,
  );
});
