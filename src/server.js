// src/server.js
//
// Runtime entrypoint. This file is intentionally thin: it loads env,
// builds the testable Express app via the factory in src/app.js, then
// attaches all of the things that should NOT run during a unit test --
// the HTTP server, the attendance realtime Redis-stream transport, the
// attendance bootstrap, the reminder scheduler, the attendance device
// listener, and the SIGINT/SIGTERM lifecycle hooks. Anything that does
// real I/O lives in this file. Anything that wires up an Express request
// pipeline lives in src/app.js.
//
// X-13 (ARCH-01 §7.7/§13 + BE-audit §7.2): the self-hosted socket.io server
// is RETIRED. Attendance realtime is published onto the `hr:attendance` Redis
// stream (the fleet fabric); the gateway SSE spine is the single delivery pipe
// to browsers. HR owns the producer, never the socket transport.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import Redis from "ioredis";
import logger from "./lib/logger.js";
import { createApp } from "./app.js";
import { bootstrapAttendanceData } from "./services/attendance.bootstrap.service.js";
import { startReminderJobs } from "./jobs/reminder.queue.js";
import { startAttendanceListener, stopAttendanceListener } from "./services/attendance.listener.service.js";
import { startRealtimeHealthBroadcast } from "./services/attendance.realtime.service.js";
import {
  bindAttendanceRealtimeTransport,
  createAttendanceStreamPublisher,
} from "./services/attendanceRealtime.publisher.js";
import { startHrOutboxDispatcher } from "./jobs/outbox.loop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const app = createApp();
const httpServer = createServer(app);

// BullMQ reminder/retention/document-expiry jobs (replaces node-cron; BE-§9.4).
// Best-effort: a Redis/boot failure logs and returns a disabled handle — it
// never takes down the HTTP server.
const reminderJobs = startReminderJobs();

// X-13: wire the attendance realtime transport to the Redis Streams fabric.
// Best-effort: when REDIS_URL is unset the transport stays unbound and every
// publish is a no-op (the DB remains the source of truth; realtime is a
// best-effort projection).
let attendanceRedis = null;
let realtimeHealth = null;
if (process.env.REDIS_URL) {
  try {
    attendanceRedis = new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    attendanceRedis.on?.("error", (err) =>
      logger.warn({ err: { message: err?.message } }, "attendance realtime: redis error"));
    bindAttendanceRealtimeTransport(createAttendanceStreamPublisher({ redis: attendanceRedis }));
    realtimeHealth = startRealtimeHealthBroadcast();
    logger.info({ stream: "hr:attendance" }, "attendance realtime: Redis stream transport bound");
  } catch (err) {
    logger.error({ err: { message: err?.message } }, "attendance realtime: failed to bind Redis transport — realtime disabled");
  }
} else {
  logger.warn("attendance realtime: REDIS_URL not configured — realtime projection disabled");
}

logger.info({
  attendanceListenerEnabled: String(process.env.ATTENDANCE_LISTENER_ENABLED ?? "true"),
  attendanceDeviceHost: process.env.ATTENDANCE_DEVICE_HOST || "103.245.195.202",
  attendanceDevicePort: process.env.ATTENDANCE_DEVICE_PORT || "4370",
}, "attendance subsystem configured");

// A.4 (WBS worker-wiring / T-P3.x) — auto-start the HR OutboxEvent dispatcher
// as an in-process drain loop so hr.employee.lifecycle.v1 relays live to the
// `hr:events` Redis stream without an external cron. Best-effort: a boot/Redis
// failure logs via pino and returns a disabled handle — it does NOT take down
// the HTTP server. Self-guards (no-op under NODE_ENV=test or when REDIS_URL is
// unset). Mirrors how comms wires startRealtimeBridge / the gateway wires
// startNotifyConsumer.
const outboxDispatcher = startHrOutboxDispatcher();

const PORT = process.env.PORT || 3003;
const server = httpServer.listen(PORT, async () => {
  logger.info({ port: PORT }, "HR Service listening");
  await bootstrapAttendanceData();
  startAttendanceListener();
});

let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAttendanceListener();
  // Stop the realtime health beat + release the attendance Redis client.
  try { realtimeHealth?.stop?.(); } catch { /* best effort */ }
  try { await attendanceRedis?.quit?.(); } catch { /* best effort */ }
  // Stop the BullMQ reminder jobs (close queues/workers + their Redis clients).
  try {
    await reminderJobs?.stop?.();
  } catch (err) {
    logger.warn({ err: { message: err?.message } }, "hr reminder jobs: stop failed during shutdown");
  }
  // Stop the outbox loop (halts further drains, releases its Redis client)
  // before we close the HTTP server. Best-effort: never block shutdown on it.
  try {
    await outboxDispatcher.stop();
  } catch (err) {
    logger.warn({ err: { message: err?.message } }, "hr outbox loop: stop failed during shutdown");
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
