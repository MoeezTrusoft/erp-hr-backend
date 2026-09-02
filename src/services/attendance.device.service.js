import net from "node:net";
import prisma from "../lib/prisma.js";
import {
  deriveAttendanceStatus,
  resolveShiftStartMin,
  parseClockToMinutes,
  normalizeWorkMode,
  minutesOfDay,
} from "../lib/attendanceStatus.js";
const DEFAULT_DEVICE_HOST = process.env.ATTENDANCE_DEVICE_HOST || "103.245.195.202";
const DEFAULT_DEVICE_PORT = Number(process.env.ATTENDANCE_DEVICE_PORT || 4370);
const DEFAULT_TIMEOUT_MS = Number(process.env.ATTENDANCE_DEVICE_TIMEOUT_MS || 3000);

function parseDateInput(value) {
  if (!value) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function parseShiftStart(value) {
  const raw = String(value || "09:00").trim();
  const [h, m] = raw.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid shiftStart format: ${value}. Expected HH:mm`);
  }
  return { hours: h, minutes: m };
}

function dayRange(dateInput) {
  const base = new Date(dateInput);
  base.setHours(0, 0, 0, 0);
  const start = new Date(base);
  const end = new Date(base);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// A shift is a run of punches separated by less than this. Night shifts cross
// midnight (20:00->05:00, 22:00->08:00), so grouping by calendar day splits one
// shift into two zero-hour days — 380 of 1628 August shifts were wrong that way.
// 11h separates them cleanly: the largest gap WITHIN a night shift is ~9h, the
// smallest gap BETWEEN shifts is ~14h.
const SESSION_GAP_MS =
  Number(process.env.ATTENDANCE_SHIFT_GAP_HOURS || 11) * 60 * 60 * 1000;

/**
 * The date a punch's shift belongs to. If an Attendance row for this employee
 * was opened less than SESSION_GAP_MS ago, this punch continues that shift and
 * inherits its date — that is what carries a night shift past midnight. A live
 * single punch at 05:00 is otherwise indistinguishable from a new morning.
 */
async function resolveShiftDate(employeeId, timestamp) {
  const open = await prisma.attendance.findFirst({
    where: {
      employeeId,
      check_in: { gte: new Date(timestamp.getTime() - SESSION_GAP_MS), lte: timestamp },
    },
    orderBy: { check_in: "desc" },
    select: { date: true },
  });
  return dayKey(open?.date ?? timestamp);
}

/**
 * Shift start for this employee, from work_schedules.schedule_pattern (loaded
 * from the roster). Falls back to the caller's value when the employee has no
 * schedule or a roster-driven one with no fixed clock range.
 */
async function resolveEmployeeShiftStart(employeeId, fallback, cache, onDate) {
  // Cache per employee AND day: the schedule is effective-dated now, so one
  // employee can legitimately have different shifts on different days of a batch.
  const day = onDate instanceof Date ? onDate : new Date();
  const cacheKey = `${employeeId}|${dayKey(day)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let value = fallback;
  try {
    // Effective-dated so a mid-month shift change does not rewrite earlier days.
    const ws = await prisma.workSchedule.findFirst({
      where: {
        employeeId,
        effective_start_date: { lte: day },
        OR: [{ effective_end_date: null }, { effective_end_date: { gte: day } }],
      },
      orderBy: { effective_start_date: "desc" },
      select: { schedule_pattern: true },
    });
    const from = ws?.schedule_pattern?.shift?.from;
    if (typeof from === "string" && /^\d{1,2}:\d{2}$/.test(from)) value = from;
  } catch {
    // A missing/unreadable schedule must not fail the roll-up; the fallback
    // shift start still yields a usable status.
  }
  cache.set(cacheKey, value);
  return value;
}

/**
 * deriveAttendanceStatus compares minutes-of-day, so a 00:30 check-in against a
 * 22:00 shift reads as 21.5h EARLY instead of 2.5h late. When the check-in sits
 * far before the shift start it belongs to the previous day's shift, so express
 * the start as a negative offset.
 */
function effectiveShiftStartMin(checkIn, shiftStartMin) {
  if (shiftStartMin == null) return shiftStartMin;
  // minutesOfDay() is UTC-based; use it rather than local getHours() so both
  // sides of the comparison share one basis.
  const mod = minutesOfDay(checkIn);
  if (mod == null) return shiftStartMin;
  const delta = mod - shiftStartMin;
  // Pick whichever occurrence of the shift start is nearest the check-in. Both
  // directions occur in this roster:
  //   00:30 in, 22:00 shift  -> yesterday's shift, 2.5h late (not 21.5h early)
  //   23:05 in, 00:00 shift  -> tomorrow's shift, 55m early (not 23h late)
  if (delta < -720) return shiftStartMin - 1440;
  if (delta > 720) return shiftStartMin + 1440;
  return shiftStartMin;
}

function parseTimestamp(raw) {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function parseType(rawType) {
  const t = String(rawType || "").trim().toUpperCase();
  if (!t) return "";
  if (["IN", "CHECKIN", "CHECK_IN", "CLOCK_IN", "I", "0"].includes(t)) return "IN";
  if (["OUT", "CHECKOUT", "CHECK_OUT", "CLOCK_OUT", "O", "1"].includes(t)) return "OUT";
  return "";
}

function calculateTotalHours(checkIn, checkOut) {
  if (!(checkIn instanceof Date) || !(checkOut instanceof Date)) return null;
  const ms = checkOut.getTime() - checkIn.getTime();
  if (ms <= 0) return null;
  return Number((ms / (1000 * 60 * 60)).toFixed(2));
}

function buildLateCutoff(targetDate, shiftStart = "09:00", lateGraceMinutes = 15) {
  const { hours, minutes } = parseShiftStart(shiftStart);
  const cutoff = new Date(targetDate);
  cutoff.setHours(hours, minutes + Number(lateGraceMinutes || 0), 0, 0);
  return cutoff;
}

async function resolveEmployeeFromPunch(punch) {
  const employeeIdRaw = punch.employeeId;
  const employeeCodeRaw = punch.employeeCode ?? punch.deviceUserId ?? punch.userId;

  if (employeeIdRaw !== undefined && employeeIdRaw !== null && employeeIdRaw !== "") {
    const employeeId = Number(employeeIdRaw);
    if (Number.isInteger(employeeId) && employeeId > 0) {
      const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, employee_code: true, employee_name: true, work_mode: true },
      });
      if (employee) return employee;
    }
  }

  if (employeeCodeRaw !== undefined && employeeCodeRaw !== null && String(employeeCodeRaw).trim() !== "") {
    const code = String(employeeCodeRaw).trim();

    // Resolve deviceUserId directly against Employee. There is no local Person
    // model: Employee.personId is a cross-database anchor to RBAC's Person
    // (see schema.prisma), so `prisma.person` is undefined here and querying it
    // threw "Cannot read properties of undefined (reading 'findUnique')" for
    // every punch, failing the whole roll-up.
    const employee = await prisma.employee.findFirst({
      where: { OR: [{ biometric_id: code }, { employee_code: code }] },
      select: { id: true, employee_code: true, biometric_id: true, employee_name: true, work_mode: true, tenant_id: true },
    });
    if (employee) return employee;
  }

  return null;
}

function normalizeGroupedPunches(groupPunches) {
  const sorted = [...groupPunches].sort((a, b) => a.timestamp - b.timestamp);
  const inPunches = sorted.filter((p) => p.type === "IN");
  const outPunches = sorted.filter((p) => p.type === "OUT");

  const checkIn = (inPunches[0] || sorted[0])?.timestamp || null;
  let checkOut = null;

  if (outPunches.length) {
    checkOut = outPunches[outPunches.length - 1].timestamp;
  } else if (sorted.length > 1) {
    checkOut = sorted[sorted.length - 1].timestamp;
  }

  if (checkIn && checkOut && checkOut.getTime() <= checkIn.getTime()) {
    checkOut = null;
  }

  return { checkIn, checkOut, punchesCount: sorted.length };
}

export async function probeAttendanceDevice({
  host = DEFAULT_DEVICE_HOST,
  port = DEFAULT_DEVICE_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    const startedAt = Date.now();
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () =>
      finish({
        host,
        port,
        reachable: true,
        roundTripMs: Date.now() - startedAt,
      })
    );

    socket.once("timeout", () =>
      finish({
        host,
        port,
        reachable: false,
        error: `Timeout after ${timeoutMs}ms`,
      })
    );

    socket.once("error", (err) =>
      finish({
        host,
        port,
        reachable: false,
        error: err?.message || "Connection failed",
      })
    );

    socket.connect(port, host);
  });
}

export async function syncAttendanceFromPunches({
  punches = [],
  shiftStart = "09:00",
  lateGraceMinutes = 15,
  dryRun = false,
  testConnectivity = false,
  host = DEFAULT_DEVICE_HOST,
  port = DEFAULT_DEVICE_PORT,
} = {}) {
  if (!Array.isArray(punches) || !punches.length) {
    throw new Error("punches array is required");
  }

  const connectivity = testConnectivity ? await probeAttendanceDevice({ host, port }) : null;
  if (testConnectivity && !connectivity?.reachable) {
    throw new Error(`Device connectivity failed: ${connectivity?.error || "unreachable"}`);
  }

  const grouped = new Map();
  const unresolved = [];
  const invalidPunches = [];
  const shiftStartCache = new Map();

  const resolvedPunches = [];
  for (const punch of punches) {
    const timestamp = parseTimestamp(punch?.timestamp);
    if (!timestamp) {
      invalidPunches.push({ reason: "invalid_timestamp", punch });
      continue;
    }

    const employee = await resolveEmployeeFromPunch(punch || {});
    if (!employee) {
      unresolved.push({
        reason: "employee_not_found",
        employeeId: punch?.employeeId ?? null,
        employeeCode: punch?.employeeCode ?? punch?.deviceUserId ?? punch?.userId ?? null,
        timestamp: punch?.timestamp ?? null,
      });
      continue;
    }

    resolvedPunches.push({ employee, timestamp, raw: punch });
  }

  // Chronological per employee: a punch can only continue the session before it.
  resolvedPunches.sort(
    (a, b) => a.employee.id - b.employee.id || a.timestamp - b.timestamp,
  );

  // Last session seen for each employee IN THIS BATCH. Checked before the DB,
  // because a shift opened earlier in this same batch has not been written yet.
  const lastSession = new Map();

  for (const { employee, timestamp, raw } of resolvedPunches) {
    const prev = lastSession.get(employee.id);
    const punchDay =
      prev && timestamp.getTime() - prev.lastTs <= SESSION_GAP_MS
        ? prev.punchDay
        : await resolveShiftDate(employee.id, timestamp);

    const key = `${employee.id}|${punchDay}`;
    if (!grouped.has(key)) {
      grouped.set(key, { employee, punchDay, punches: [] });
    }
    grouped.get(key).punches.push({
      timestamp,
      type: parseType(raw?.type),
      raw,
    });
    lastSession.set(employee.id, { punchDay, lastTs: timestamp.getTime() });
  }

  const summary = {
    totalPunchesReceived: punches.length,
    validPunches: punches.length - invalidPunches.length,
    invalidPunches: invalidPunches.length,
    unresolvedPunches: unresolved.length,
    groupedRecords: grouped.size,
    created: 0,
    updated: 0,
    skipped: 0,
    details: [],
    unresolved,
    connectivity,
    dryRun: !!dryRun,
  };

  for (const group of grouped.values()) {
    const { employee, punchDay, punches: groupPunches } = group;
    const { checkIn, checkOut, punchesCount } = normalizeGroupedPunches(groupPunches);

    if (!checkIn) {
      summary.skipped += 1;
      summary.details.push({ employeeId: employee.id, date: punchDay, action: "skipped_no_checkin" });
      continue;
    }

    const { start, end } = dayRange(parseDateInput(punchDay));
    // The employee's OWN shift start, from work_schedules. Judging a 20:00
    // night-shift worker against a hardcoded 09:00 stamped every one of them
    // HALF_DAY. `shiftStart` is now only the fallback.
    const employeeShiftStart = await resolveEmployeeShiftStart(
      employee.id,
      shiftStart,
      shiftStartCache,
      start,
    );
    const lateCutoff = buildLateCutoff(checkIn, employeeShiftStart, lateGraceMinutes);
    // Route status through the shared helper so synced punches also yield
    // HALF_DAY (≥30min late), not just PRESENT/LATE. The helper's env-tuned
    // grace/half-day thresholds then decide the bucket.
    const rosterShiftStartMin = resolveShiftStartMin({
      shiftStartMinutes: parseClockToMinutes(employeeShiftStart),
    });
    const deviceShiftStartMin = effectiveShiftStartMin(checkIn, rosterShiftStartMin);
    const calculatedStatus = deriveAttendanceStatus(checkIn, deviceShiftStartMin);

    const existing = await prisma.attendance.findFirst({
      where: {
        employeeId: employee.id,
        date: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { id: "desc" },
    });

    const mergedCheckIn = existing?.check_in
      ? new Date(Math.min(existing.check_in.getTime(), checkIn.getTime()))
      : checkIn;
    const mergedCheckOut = (() => {
      if (existing?.check_out && checkOut) return new Date(Math.max(existing.check_out.getTime(), checkOut.getTime()));
      if (existing?.check_out || checkOut) return existing?.check_out || checkOut;
      // A lone OUT punch closing a shift opened by an earlier batch. The device
      // pushes live, so the check-out routinely arrives on its own; with no IN
      // punch beside it normalizeGroupedPunches reports it as the check-IN, and
      // the shift would never gain a check_out or any hours.
      const lastPunch = groupPunches.reduce(
        (acc, p) => (acc && acc.timestamp >= p.timestamp ? acc : p),
        null,
      );
      const allOut = groupPunches.every((p) => p.type === "OUT");
      if (allOut && existing?.check_in && lastPunch && lastPunch.timestamp > existing.check_in) {
        return lastPunch.timestamp;
      }
      return null;
    })();
    const totalHours = calculateTotalHours(mergedCheckIn, mergedCheckOut);
    const mergedStatus = deriveAttendanceStatus(
      mergedCheckIn,
      effectiveShiftStartMin(mergedCheckIn, rosterShiftStartMin),
    );
    // The day's work_mode is taken from the employee's default work_mode
    // (Employee is snake_case), normalized to canonical Remote|Onsite|Hybrid.
    const workMode = normalizeWorkMode(employee.work_mode);

    if (dryRun) {
      summary.details.push({
        employeeId: employee.id,
        date: punchDay,
        action: existing ? "would_update" : "would_create",
        status: mergedStatus || calculatedStatus,
        check_in: mergedCheckIn,
        check_out: mergedCheckOut,
        punchesCount,
      });
      continue;
    }

    if (existing) {
      await prisma.attendance.update({
        where: { id: existing.id },
        data: {
          check_in: mergedCheckIn,
          check_out: mergedCheckOut,
          total_hours: totalHours ?? undefined,
          status: mergedStatus,
          ...(workMode ? { work_mode: workMode } : {}),
          remarks: "Synced from biometric device",
        },
      });
      summary.updated += 1;
      summary.details.push({
        employeeId: employee.id,
        date: punchDay,
        action: "updated",
        attendanceId: existing.id,
        status: mergedStatus,
        check_in: mergedCheckIn,
        check_out: mergedCheckOut,
        punchesCount,
      });
    } else {
      const created = await prisma.attendance.create({
        data: {
          employeeId: employee.id,
          date: start,
          check_in: mergedCheckIn,
          check_out: mergedCheckOut,
          total_hours: totalHours ?? undefined,
          status: calculatedStatus,
          tenantId: employee.tenant_id || null,
          ...(workMode ? { work_mode: workMode } : {}),
          remarks: "Created from biometric device",
        },
      });
      summary.created += 1;
      summary.details.push({
        employeeId: employee.id,
        date: punchDay,
        action: "created",
        attendanceId: created.id,
        status: calculatedStatus,
        check_in: mergedCheckIn,
        check_out: mergedCheckOut,
        punchesCount,
      });
    }
  }

  return summary;
}

export async function getDailyAttendanceSummary({
  date = new Date(),
  shiftStart = "09:00",
  lateGraceMinutes = 15,
} = {}) {
  const target = parseDateInput(date);
  const { start, end } = dayRange(target);
  const lateCutoff = buildLateCutoff(start, shiftStart, lateGraceMinutes);

  const [totalEmployees, records] = await Promise.all([
    prisma.employee.count(),
    prisma.attendance.findMany({
      where: {
        date: {
          gte: start,
          lte: end,
        },
      },
      select: {
        employeeId: true,
        status: true,
        check_in: true,
      },
    }),
  ]);

  const presentSet = new Set();
  const lateSet = new Set();

  for (const rec of records) {
    if (rec?.check_in && rec.check_in > lateCutoff) {
      lateSet.add(rec.employeeId);
      continue;
    }

    if (rec?.status === "LATE") {
      lateSet.add(rec.employeeId);
      continue;
    }

    if (rec?.status === "PRESENT" || rec?.check_in) {
      presentSet.add(rec.employeeId);
    }
  }

  for (const id of lateSet.values()) {
    presentSet.delete(id);
  }

  const present = presentSet.size;
  const late = lateSet.size;
  const absent = Math.max(totalEmployees - (present + late), 0);

  return {
    date: dayKey(start),
    totalEmployees,
    present,
    late,
    absent,
    shiftStart,
    lateGraceMinutes: Number(lateGraceMinutes || 0),
  };
}
