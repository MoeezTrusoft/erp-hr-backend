import net from "node:net";
import prisma from "../lib/prisma.js";
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

function buildLateCutoff(targetDate, shiftStart = "09:00", lateGraceMinutes = 15) {
  const { hours, minutes } = parseShiftStart(shiftStart);
  const cutoff = new Date(targetDate);
  cutoff.setHours(hours, minutes + Number(lateGraceMinutes || 0), 0, 0);
  return cutoff;
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

export async function syncAttendanceFromPunches({ sn, punches = [], dryRun = true, tenantId, requestKey, actorId } = {}) {
  const { receiveCapture } = await import('./attendanceCapture.service.js');
  if (!sn) throw Object.assign(new Error('Registered device serial is required'), { status: 400 });
  const rows = punches.map(p => `${p.deviceUserId ?? p.employeeCode ?? p.userId ?? ''}\t${p.timestamp ?? ''}\t${['OUT','1','5'].includes(String(p.type).toUpperCase()) ? 1 : ['IN','0','4'].includes(String(p.type).toUpperCase()) ? 0 : 'INVALID'}\t0\t0`);
  return receiveCapture({ sn, rows, source: 'DEVICE_SYNC', tenantId, requestKey, actorId, dryRun });
}

export async function getDailyAttendanceSummary({
  tenantId,
  date = new Date(),
  shiftStart = "09:00",
  lateGraceMinutes = 15,
} = {}) {
  const target = parseDateInput(date);
  const { start, end } = dayRange(target);
  const lateCutoff = buildLateCutoff(start, shiftStart, lateGraceMinutes);

  // HR-ATT-DAILYSUM-TENANT-01 (2026-09-14) — this summary counted the WHOLE
  // DATABASE: prisma.employee.count() with no tenant filter and no status
  // filter, so every tenant's "absent" figure included the other four
  // tenants' entire rosters and every separated employee. (A related tenant
  // leak: it also counted people who left months ago.) Scope the headcount to
  // the caller's tenant and to attendance/payroll-eligible employees; absent =
  // eligible headcount minus whoever showed.
  const [eligibleRows, records] = await Promise.all([
    prisma.employee.findMany({
      where: {
        tenant_id: tenantId ?? undefined,
        payroll_included: true,
        attendanceInputMode: {not:"MANUAL_MONTHLY"},
        OR: [{ status: { not: "Inactive" } }, { status: null }],
      },
      select: { id: true },
    }),
    prisma.attendance.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
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

  const eligibleIds = new Set(eligibleRows.map((e) => e.id));
  const totalEmployees = eligibleIds.size;
  const presentSet = new Set();
  const lateSet = new Set();

  for (const rec of records) {
    if (!eligibleIds.has(rec.employeeId)) continue; // separated/excluded
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
