import { captureDb, TENANT } from "./captureDb.js";
import { publishedSetup } from "./publishedSetup.js";
import { applyEvaluatedShifts } from "../../src/services/attendanceWriter.service.js";
export { TENANT };
export const DATE = "2026-08-02";
export const day = (date = DATE) => new Date(date + "T00:00:00Z");
export const fixed = { shift: { from: "09:00", to: "17:00" }, offDays: [] };
export const rotation = {
  rotatingShifts: [
    { from: "09:00", to: "17:00" },
    { from: "21:00", to: "05:00" },
  ],
  offDays: [],
  cycle: { days: 3, anchor: "2026-08-01", sequence: [0, null, 1] },
};
export function evaluationDb({
  pattern = fixed,
  punches = [],
  rows = [],
  extra = {},
  configure,
} = {}) {
  const release = publishedSetup({
    tenantId: TENANT,
    schedules: [
      { schedule_pattern: pattern, effective_start_date: "2020-01-01" },
    ],
  })[0];
  configure?.(release.config);
  return captureDb({
    attendanceSetupRelease: [release],
    attendance: rows.map((r) => ({
      id: 5,
      tenantId: TENANT,
      employeeId: 1,
      date: day(),
      manually_corrected: false,
      ...r,
    })),
    attendanceDevicePunch: punches.map(([time, status], i) => ({
      id: i + 1,
      tenantId: TENANT,
      employeeId: 1,
      punchedAt: new Date(DATE + "T" + time + ":00Z"),
      status,
      sn: "DEVICE-1",
      directionVerified: true,
    })),
    ...extra,
  });
}
export const evaluate = (db, args = {}) =>
  applyEvaluatedShifts({
    tenantId: TENANT,
    from: DATE,
    to: DATE,
    now: new Date("2026-08-05"),
    dryRun: false,
    db,
    ...args,
  });
