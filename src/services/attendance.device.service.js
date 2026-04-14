import net from "node:net";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
        select: { id: true, employee_code: true, employee_name: true },
      });
      if (employee) return employee;
    }
  }

  if (employeeCodeRaw !== undefined && employeeCodeRaw !== null && String(employeeCodeRaw).trim() !== "") {
    const code = String(employeeCodeRaw).trim();
    const employee = await prisma.employee.findFirst({
      where: { employee_code: code },
      select: { id: true, employee_code: true, employee_name: true },
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

    const key = `${employee.id}|${dayKey(timestamp)}`;
    if (!grouped.has(key)) {
      grouped.set(key, { employee, punchDay: dayKey(timestamp), punches: [] });
    }
    grouped.get(key).punches.push({
      timestamp,
      type: parseType(punch?.type),
      raw: punch,
    });
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
    const lateCutoff = buildLateCutoff(checkIn, shiftStart, lateGraceMinutes);
    const calculatedStatus = checkIn > lateCutoff ? "LATE" : "PRESENT";

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
      return existing?.check_out || checkOut || null;
    })();
    const totalHours = calculateTotalHours(mergedCheckIn, mergedCheckOut);
    const mergedStatus = mergedCheckIn > lateCutoff ? "LATE" : "PRESENT";

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
