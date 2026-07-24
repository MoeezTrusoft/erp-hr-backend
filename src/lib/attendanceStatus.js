// src/lib/attendanceStatus.js
//
// Single source of truth for deriving a day's attendance status from the
// check-in time vs the employee's shift start. Used at WRITE time
// (attendance check-in + biometric device sync) and by the dev seed so the
// stored StatusAttendance is authoritative; the Timesheet read layer then just
// reads the stored status (no per-row shift resolution on read).
//
//   on-time  → PRESENT   (check-in ≤ shiftStart + grace)
//   late     → LATE      (grace < lateness < HALF_DAY threshold)
//   half-day → HALF_DAY  (lateness ≥ HALF_DAY threshold, default 30 min)
//   absent   → ABSENT    (no check-in)
//
// All thresholds are env-tunable so ops can adjust without a redeploy.

export const LATE_GRACE_MIN = Number(process.env.HR_LATE_GRACE_MIN ?? 0);
export const HALF_DAY_MIN = Number(process.env.HR_HALF_DAY_MIN ?? 30);

// Parse "HH:MM" → minutes from midnight. Returns null on bad input.
export function parseClockToMinutes(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const DEFAULT_SHIFT_START_MIN =
  parseClockToMinutes(process.env.HR_DEFAULT_SHIFT_START ?? "09:00") ?? 540;

// Local minutes-of-day for a Date (uses the runtime TZ; the cluster runs UTC and
// timestamps are stored UTC, so this is consistent end-to-end).
export function minutesOfDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Resolve an employee's shift-start (minutes from midnight) for a given date.
 * Best-effort, cheap, no DB: prefers an explicit shiftStartMinutes, then a
 * WorkSchedule.schedule_pattern day entry ("HH:MM-HH:MM"), then the default.
 * @param {object} [opts]
 * @param {number} [opts.shiftStartMinutes] explicit override
 * @param {object} [opts.schedulePattern] WorkSchedule.schedule_pattern JSON e.g. { MON:"09:00-17:00" }
 * @param {Date}   [opts.date] the work date (to pick the weekday key)
 */
export function resolveShiftStartMin({ shiftStartMinutes, schedulePattern, date } = {}) {
  if (Number.isFinite(shiftStartMinutes)) return shiftStartMinutes;
  if (schedulePattern && date) {
    const keys = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const d = date instanceof Date ? date : new Date(date);
    const key = keys[d.getUTCDay()];
    const range = schedulePattern[key] ?? schedulePattern[key?.toLowerCase?.()];
    if (typeof range === "string") {
      const start = parseClockToMinutes(range.split("-")[0]);
      if (start != null) return start;
    }
  }
  return DEFAULT_SHIFT_START_MIN;
}

/**
 * Derive StatusAttendance from a check-in time and shift start.
 * @param {Date|string|null} checkIn
 * @param {number} [shiftStartMin=DEFAULT_SHIFT_START_MIN]
 * @returns {"PRESENT"|"LATE"|"HALF_DAY"|"ABSENT"}
 */
export function deriveAttendanceStatus(checkIn, shiftStartMin = DEFAULT_SHIFT_START_MIN) {
  if (!checkIn) return "ABSENT";
  const mod = minutesOfDay(checkIn);
  if (mod == null) return "ABSENT";
  const lateness = mod - (shiftStartMin + LATE_GRACE_MIN);
  if (lateness <= 0) return "PRESENT";
  if (lateness >= HALF_DAY_MIN) return "HALF_DAY";
  return "LATE";
}

// Work-mode normalization → canonical Remote | Onsite | Hybrid (matches
// Employee.work_mode). WFH KPI counts Remote + Hybrid.
export function normalizeWorkMode(raw) {
  if (!raw || typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.startsWith("remote") || v === "wfh") return "Remote";
  if (v.startsWith("hybrid")) return "Hybrid";
  if (v.startsWith("onsite") || v.startsWith("on-site") || v === "office") return "Onsite";
  return null;
}

export const WFH_MODES = new Set(["Remote", "Hybrid"]);
