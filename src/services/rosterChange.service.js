import { getWorkSchedules, writeRoster } from './workScheduleService.js';
import { covers, dateKey, badSetup } from '../lib/attendanceDates.js';

export async function changeRoster({
  employeeId,
  tenantId,
  effectiveFrom,
  pattern,
  reason,
  changedBy = null,
  dryRun = false,
  scheduleName = null,
  totalHoursPerWeek = null,
}) {
  if (!reason?.trim())
    throw badSetup('A reason is required for roster changes');
  const rows = await getWorkSchedules({ employeeId, tenantId });
  const earliest = rows.map((r) => dateKey(r.effective_start_date)).sort()[0];
  if (earliest && dateKey(effectiveFrom) < earliest)
    throw badSetup('Roster change is before the earliest version on file');
  const covering = rows.find((r) =>
    covers(r, effectiveFrom, 'effective_start_date', 'effective_end_date'),
  );
  const correction =
    covering &&
    dateKey(covering.effective_start_date) === dateKey(effectiveFrom);
  if (!covering && (!scheduleName || totalHoursPerWeek == null))
    throw badSetup(
      'Provide schedule_name and total_hours_per_week for a first version',
    );
  const result = await writeRoster({
    tenantId,
    employeeId,
    id: correction ? covering.id : undefined,
    action: correction ? 'update' : 'create',
    dryRun,
    data: {
      effective_start_date: effectiveFrom,
      schedule_name: scheduleName ?? covering?.schedule_name,
      total_hours_per_week: totalHoursPerWeek ?? covering?.total_hours_per_week,
      overtimeRuleId: covering?.overtimeRuleId ?? null,
      correctionReason: reason,
      schedule_pattern: { ...pattern, changeReason: reason, changedBy },
    },
  });
  return {
    action: correction ? 'corrected' : covering ? 'versioned' : 'created',
    closed: correction ? null : (covering?.id ?? null),
    created: result.id ?? null,
    plan: dryRun ? result : undefined,
  };
}
