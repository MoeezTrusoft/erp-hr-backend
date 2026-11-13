import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";
import {
  receiveCapture,
  captureHeartbeat,
} from "./attendanceCapture.service.js";
import {
  publishAttendanceEvent,
  publishAttendanceStatus,
  publishAttendanceHealth,
  publishAttendanceBootstrap,
} from "./attendanceRealtime.publisher.js";
const recentEvents = [];
let healthInterval;
const listenerState = {
  enabled: false,
  running: false,
  connected: false,
  lastEventAt: null,
  lastError: null,
  received: 0,
  persisted: 0,
};
const rawLine = (event) =>
  `${event.device_user_id ?? event.user_id ?? ""}\t${event.timestamp ?? ""}\t${event.punch ?? "INVALID"}\t${event.status ?? 0}\t0`;
function serial(event) {
  const sn = event?.sn || process.env.ATTENDANCE_DEVICE_SN;
  if (!sn)
    throw new Error("ATTENDANCE_DEVICE_SN must identify a registered device");
  return sn;
}
export async function ingestRealtimeDeviceEvent(rawEvent) {
  const summary = await receiveCapture({
    sn: serial(rawEvent),
    source: "DEVICE_LISTENER",
    rows: [rawLine(rawEvent)],
  });
  const event = {
    id: summary.receiptId,
    source: "device",
    timestamp: new Date().toISOString(),
    persisted: true,
    processed: false,
    summary,
  };
  listenerState.lastEventAt = new Date().toISOString();
  listenerState.received++;
  listenerState.persisted++;
  recentEvents.unshift(event);
  recentEvents.splice(300);
  // This notification explicitly means RECEIVED. Evaluated attendance changes
  // are published from the worker's transactional outbox after commit.
  publishAttendanceEvent(event);
  return event;
}
export async function persistBootstrapPunches(events = []) {
  const receipts = [];
  for (let i = 0; i < events.length; i += 500)
    receipts.push(
      await receiveCapture({
        sn: serial(events[i]),
        source: "DEVICE_LISTENER",
        rows: events.slice(i, i + 500).map(rawLine),
      }),
    );
  return receipts;
}
export async function ingestBootstrapDeviceEvents(events = []) {
  const receipts = await persistBootstrapPunches(events);
  publishAttendanceBootstrap({
    received: events.length,
    receipts,
    processed: false,
  });
  return receipts;
}
export function updateListenerState(patch) {
  Object.assign(listenerState, patch);
  publishAttendanceStatus(getRealtimeListenerState());
}
export function getRealtimeListenerState() {
  return { ...listenerState };
}
export function getRecentRealtimeEvents(limit = 50) {
  return recentEvents.slice(0, Math.min(300, Math.max(1, Number(limit) || 50)));
}
export async function getRealtimeBootstrapEvents(limit = 25) {
  return getRecentRealtimeEvents(limit);
}
export function startRealtimeHealthBroadcast({ intervalMs = 15000 } = {}) {
  clearInterval(healthInterval);
  healthInterval = setInterval(
    () =>
      publishAttendanceHealth({
        liveWorking: !!(listenerState.running && listenerState.connected),
        lastRealtimeEventAt: listenerState.lastEventAt,
        lastError: listenerState.lastError,
      }),
    intervalMs,
  );
  healthInterval.unref();
  publishAttendanceStatus(getRealtimeListenerState());
  return {
    stop() {
      clearInterval(healthInterval);
    },
  };
}

export async function ingestListenerHeartbeat(event) {
  return mcpCtx.run({ system: true }, async () => {
    const device = await prisma.attendanceCaptureDevice.findUnique({
      where: { sn: serial(event) },
    });
    if (!device?.active)
      throw new Error("Listener device must be registered and active");
    return captureHeartbeat({ device, deviceTime: event.deviceTime });
  });
}
