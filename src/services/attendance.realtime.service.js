import prisma from "../lib/prisma.js";
import { checkOutServiceWithTimestamp, createAttendanceService } from "./attendance.service.js";
import { syncAttendanceFromPunches } from "./attendance.device.service.js";
import logger from "../lib/logger.js";
import {
  publishAttendanceEvent,
  publishAttendanceStatus,
  publishAttendanceHealth,
  publishAttendanceBootstrap,
} from "./attendanceRealtime.publisher.js";

const realtimeLog = logger.child({ component: "attendance-realtime" });

const MAX_RECENT_EVENTS = 300;

const recentEvents = [];
let healthInterval = null;
const listenerState = {
  enabled: false,
  running: false,
  connected: false,
  lastEventAt: null,
  lastError: null,
  processed: 0,
  persisted: 0,
  unresolved: 0,
};

function debugEnabled() {
  return String(process.env.ATTENDANCE_DEBUG || "true").toLowerCase() !== "false";
}

function log(...args) {
  if (!debugEnabled()) return;
  realtimeLog.debug({ args }, "attendance-realtime");
}

function pushRecent(event) {
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.length = MAX_RECENT_EVENTS;
  }
}

// X-13: realtime is published onto the `hr:attendance` Redis stream (fail-soft,
// no-op when no transport is bound) instead of a self-hosted socket.io server.
function broadcast(event) {
  publishAttendanceEvent(event);
}

function broadcastStatus() {
  publishAttendanceStatus(getRealtimeListenerState());
}

async function buildHealthSnapshot() {
  try {
    const lastRow = await prisma.attendance.findFirst({
      orderBy: { date: "desc" },
      select: {
        id: true,
        date: true,
        check_in: true,
        check_out: true,
      },
    });

    const lastDbAttendanceAt = lastRow
      ? (lastRow.check_out || lastRow.check_in || lastRow.date)?.toISOString()
      : null;

    return {
      dbConnected: true,
      lastDbAttendanceAt,
      lastRealtimeEventAt: listenerState.lastEventAt || null,
      liveWorking: !!(listenerState.running && listenerState.connected),
    };
  } catch (err) {
    return {
      dbConnected: false,
      dbError: err?.message || "DB check failed",
      lastDbAttendanceAt: null,
      lastRealtimeEventAt: listenerState.lastEventAt || null,
      liveWorking: !!(listenerState.running && listenerState.connected),
    };
  }
}

function normalizeTimestamp(raw) {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function inferActionFromPunch(punch, status) {
  const p = Number(punch);
  if (p === 1 || p === 5) return "checkout";
  const s = Number(status);
  if (s === 1 || s === 5) return "checkout";
  return "checkin";
}

async function resolveEmployee(deviceUserId) {
  if (!deviceUserId) return null;
  const id = Number(deviceUserId);
  if (Number.isInteger(id) && id > 0) {
    const byId = await prisma.employee.findUnique({ where: { id }, select: { id: true, employee_code: true, employee_name: true } });
    if (byId) return byId;
  }
  return await prisma.employee.findFirst({
    where: { employee_code: String(deviceUserId).trim() },
    select: { id: true, employee_code: true, employee_name: true },
  });
}

async function resolveOrCreateEmployee(deviceUserId, userName) {
  const key = String(deviceUserId || "").trim();
  if (!key) return null;

  const found = await resolveEmployee(key);
  if (found) return found;

  const autoCreate = String(process.env.ATTENDANCE_AUTO_CREATE_EMPLOYEE || "true").toLowerCase() !== "false";
  if (!autoCreate) return null;

  const fallbackName = String(userName || "").trim() || `Device User ${key}`;
  const created = await prisma.employee.create({
    data: {
      employee_code: key,
      employee_name: fallbackName,
      status: "active",
      employement_status: "Active",
      remarks: "Auto-created from biometric device",
    },
    select: { id: true, employee_code: true, employee_name: true },
  });
  log("Auto-created employee from device:", created);
  return created;
}

export async function ingestRealtimeDeviceEvent(rawEvent) {
  const timestamp = normalizeTimestamp(rawEvent?.timestamp);
  const deviceUserId = String(rawEvent?.device_user_id ?? rawEvent?.user_id ?? "").trim();
  const uid = String(rawEvent?.uid ?? "").trim();
  const action = inferActionFromPunch(rawEvent?.punch, rawEvent?.status);

  const event = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: "k20",
    timestamp: timestamp.toISOString(),
    deviceUserId,
    uid,
    punch: rawEvent?.punch ?? null,
    status: rawEvent?.status ?? null,
    action,
    employeeId: null,
    employeeName: "",
    attendanceId: null,
    persisted: false,
    error: null,
  };

  listenerState.processed += 1;
  listenerState.lastEventAt = new Date().toISOString();
  log("Incoming event:", {
    deviceUserId,
    uid,
    action,
    timestamp: event.timestamp,
  });

  try {
    const employee = await resolveOrCreateEmployee(deviceUserId || uid, rawEvent?.user_name);
    if (!employee) {
      listenerState.unresolved += 1;
      event.error = "Employee not found for device user";
      log("Unresolved employee for event:", { deviceUserId, uid });
      pushRecent(event);
      broadcast(event);
      return event;
    }

    event.employeeId = employee.id;
    event.employeeName = employee.employee_name || rawEvent?.user_name || "";

    if (action === "checkout") {
      const saved = await checkOutServiceWithTimestamp(employee.id, timestamp.toISOString());
      event.attendanceId = saved?.id || null;
    } else {
      const saved = await createAttendanceService({
        employeeId: employee.id,
        timestamp: timestamp.toISOString(),
      });
      event.attendanceId = saved?.id || null;
    }

    event.persisted = true;
    listenerState.persisted += 1;
    log("Attendance persisted:", {
      employeeId: event.employeeId,
      employeeName: event.employeeName,
      action: event.action,
    });
  } catch (err) {
    event.error = err?.message || "Failed to persist attendance";
    listenerState.lastError = event.error;
    log("Persist failed:", event.error);
  }

  pushRecent(event);
  broadcast(event);
  return event;
}

export function updateListenerState(patch) {
  Object.assign(listenerState, patch || {});
  log("Listener state updated:", listenerState);
  broadcastStatus();
}

export function getRealtimeListenerState() {
  return { ...listenerState };
}

export function getRecentRealtimeEvents(limit = 50) {
  const parsed = Number(limit);
  const safeLimit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_RECENT_EVENTS) : 50;
  return recentEvents.slice(0, safeLimit);
}

export async function ingestBootstrapDeviceEvents(rawEvents = []) {
  if (!Array.isArray(rawEvents) || !rawEvents.length) return [];

  const normalized = [];

  for (const item of rawEvents) {
    const timestamp = normalizeTimestamp(item?.timestamp);
    const deviceUserId = String(item?.device_user_id ?? item?.user_id ?? "").trim();
    const uid = String(item?.uid ?? "").trim();
    const action = inferActionFromPunch(item?.punch, item?.status);

    let employeeId = null;
    let employeeName = "";
    try {
      const employee = await resolveOrCreateEmployee(deviceUserId || uid, item?.user_name);
      employeeId = employee?.id || null;
      employeeName = employee?.employee_name || item?.user_name || "";
    } catch {
      // Keep bootstrap event even if DB isn't reachable.
    }

    const event = {
      id: `bootstrap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      source: "k20-bootstrap",
      timestamp: timestamp.toISOString(),
      deviceUserId,
      uid,
      punch: item?.punch ?? null,
      status: item?.status ?? null,
      action,
      employeeId,
      employeeName,
      persisted: false,
      error: null,
    };
    normalized.push(event);
  }

  // Keep newest first in recent list
  normalized.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  for (const event of normalized) {
    pushRecent(event);
  }

  publishAttendanceBootstrap(getRecentRealtimeEvents(25));

  log("Bootstrap events ingested:", normalized.length);
  return normalized;
}

export async function persistBootstrapPunches(rawEvents = []) {
  if (!Array.isArray(rawEvents) || !rawEvents.length) return null;

  const punches = rawEvents
    .map((item) => {
      const timestamp = item?.timestamp;
      if (!timestamp) return null;
      const punch = Number(item?.punch);
      const type = punch === 1 || punch === 5 ? "OUT" : "IN";
      return {
        employeeCode: String(item?.device_user_id ?? item?.user_id ?? "").trim(),
        timestamp,
        type,
      };
    })
    .filter(Boolean);

  if (!punches.length) return null;

  const syncResult = await syncAttendanceFromPunches({
    punches,
    dryRun: false,
    testConnectivity: false,
  });

  log("Bootstrap punches synced:", {
    punches: punches.length,
    groupedRecords: syncResult?.groupedRecords,
    created: syncResult?.created,
    updated: syncResult?.updated,
    unresolvedPunches: syncResult?.unresolvedPunches,
  });

  return syncResult;
}

export async function getRealtimeBootstrapEvents(limit = 25) {
  if (recentEvents.length) return getRecentRealtimeEvents(limit);

  const rows = await prisma.attendance.findMany({
    orderBy: { date: "desc" },
    take: Math.min(Number(limit) || 25, 100),
    include: {
      employee: {
        select: {
          employee_name: true,
          employee_code: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: `db_${row.id}`,
    source: "db",
    timestamp: (row.check_out || row.check_in || row.date)?.toISOString(),
    deviceUserId: row.employee?.employee_code || String(row.employeeId),
    uid: "",
    punch: row.check_out ? 1 : 0,
    status: row.status || null,
    action: row.check_out ? "checkout" : "checkin",
    employeeId: row.employeeId,
    employeeName: row.employee?.employee_name || "",
    persisted: true,
    error: null,
  }));
}

// X-13: the self-hosted socket.io server is RETIRED. Realtime attendance is
// projected onto the `hr:attendance` Redis stream and the gateway SSE spine is
// the single delivery pipe to browsers. This periodic health beat replaces the
// old per-socket health emit: it publishes a health snapshot onto the stream on
// an interval so a freshly-connected SSE consumer sees liveness. Best-effort:
// the publisher is fail-soft and the timer is unref'd so it never holds the
// process open on its own.
export function startRealtimeHealthBroadcast({ intervalMs = 15000 } = {}) {
  if (healthInterval) clearInterval(healthInterval);
  healthInterval = setInterval(async () => {
    const health = await buildHealthSnapshot();
    publishAttendanceHealth(health);
  }, intervalMs);
  if (healthInterval && typeof healthInterval.unref === "function") {
    healthInterval.unref();
  }
  // Emit an initial status + bootstrap so a consumer attaching right after boot
  // gets state without waiting a full interval.
  publishAttendanceStatus(getRealtimeListenerState());
  buildHealthSnapshot().then((health) => publishAttendanceHealth(health)).catch(() => {});
  return {
    stop() {
      if (healthInterval) {
        clearInterval(healthInterval);
        healthInterval = null;
      }
    },
  };
}
