// src/server.js
//
// Runtime entrypoint. This file is intentionally thin: it loads env,
// builds the testable Express app via the factory in src/app.js, then
// attaches all of the things that should NOT run during a unit test --
// the HTTP server, the socket.io transport, the attendance bootstrap,
// the reminder scheduler, the attendance device listener, and the
// SIGINT/SIGTERM lifecycle hooks. Anything that does real I/O lives in
// this file. Anything that wires up an Express request pipeline lives
// in src/app.js.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import logger from "./lib/logger.js";
import { createApp } from "./app.js";
import { bootstrapAttendanceData } from "./services/attendance.bootstrap.service.js";
import { startReviewReminderScheduler } from "./services/reminderScheduler.service.js";
import { startAttendanceListener, stopAttendanceListener } from "./services/attendance.listener.service.js";
import { bindRealtimeSocketServer } from "./services/attendance.realtime.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const app = createApp();
const httpServer = createServer(app);

startReviewReminderScheduler();

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.ATTENDANCE_SOCKET_CORS_ORIGIN || "*",
    credentials: true,
  },
});

bindRealtimeSocketServer(io);

logger.info({
  attendanceListenerEnabled: String(process.env.ATTENDANCE_LISTENER_ENABLED ?? "true"),
  attendanceDeviceHost: process.env.ATTENDANCE_DEVICE_HOST || "103.245.195.202",
  attendanceDevicePort: process.env.ATTENDANCE_DEVICE_PORT || "4370",
}, "attendance subsystem configured");

const PORT = process.env.PORT || 3003;
const server = httpServer.listen(PORT, async () => {
  logger.info({ port: PORT }, "HR Service listening");
  await bootstrapAttendanceData();
  startAttendanceListener();
});

function gracefulShutdown() {
  stopAttendanceListener();
  server.close(() => process.exit(0));
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
