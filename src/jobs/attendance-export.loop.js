import { drainAttendanceExports } from "../services/attendanceWorkspace.service.js";
import logger from "../lib/logger.js";
export function startAttendanceExportWorker({
  enabled = process.env.NODE_ENV !== "test" &&
    process.env.ATTENDANCE_EXPORT_WORKER_ENABLED !== "false",
  intervalMs = 2000,
} = {}) {
  if (!enabled) return { async stop() {} };
  let running = null,
    stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = drainAttendanceExports()
      .catch((error) =>
        logger.error(
          { err: { message: error.message } },
          "Attendance export worker needs retry",
        ),
      )
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
