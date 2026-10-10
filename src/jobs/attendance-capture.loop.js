import { drainCapture } from "../services/attendanceCaptureWorker.service.js";
import {
  monitorCaptureDevices,
  reconcileCaptureIdentities,
} from "../services/attendanceCapture.service.js";
import logger from "../lib/logger.js";

export function startAttendanceCaptureWorker() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.ATTENDANCE_CAPTURE_WORKER_ENABLED === "false"
  )
    return { async stop() {} };
  let running = null,
    stopped = false,
    lastSweep = 0,
    deviceCursor,
    identityCursor;
  const tick = () => {
    if (running || stopped) return;
    running = (async () => {
      if (Date.now() - lastSweep > 60000) {
        lastSweep = Date.now();
        deviceCursor = (await monitorCaptureDevices({ afterId: deviceCursor }))
          .nextCursor;
        identityCursor = (
          await reconcileCaptureIdentities({ afterId: identityCursor })
        ).nextCursor;
      }
      return drainCapture();
    })()
      .catch((err) => logger.error({ err }, "Attendance capture worker failed"))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
