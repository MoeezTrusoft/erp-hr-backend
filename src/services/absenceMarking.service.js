// Absences share the same evidence, deadlines, period locks and revision history as captured attendance.
import { applyEvaluatedShifts } from "./attendanceWriter.service.js";
import { dateKey } from "../lib/attendanceDates.js";
export async function markAbsences({
  tenantId,
  from,
  to,
  dryRun = true,
  now = new Date(),
  db,
}) {
  const result = await applyEvaluatedShifts({
    tenantId,
    from: dateKey(from),
    to: dateKey(to),
    dryRun,
    now,
    db,
    trigger: "ABSENCE_SWEEP",
  });
  return {
    ...result,
    marked: result.byStatus.ABSENT || 0,
    alreadyPresent: result.unchanged,
    manuallyCorrected: result.skippedManuallyCorrected,
    notWorking: result.nonWorking,
    setupRequired: result.byStatus.SETUP_REQUIRED || 0,
  };
}
