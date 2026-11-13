import { drainCapture } from "../services/attendanceCaptureWorker.service.js";
import {
  monitorCaptureDevices,
  reconcileCaptureIdentities,
} from "../services/attendanceCapture.service.js";
import logger from "../lib/logger.js";
import {planAttendanceFinalization,drainAttendanceFinalization} from '../services/attendanceFinalization.service.js';

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
        const plan=await planAttendanceFinalization();
        if(plan.failures.length)logger.error({failures:plan.failures},'Attendance planning needs retry');
        deviceCursor = (await monitorCaptureDevices({ afterId: deviceCursor }))
          .nextCursor;
        identityCursor = (
          await reconcileCaptureIdentities({ afterId: identityCursor })
        ).nextCursor;
      }
      const concurrency=Math.min(4,Math.max(1,Number(process.env.ATTENDANCE_EVALUATION_CONCURRENCY)||2));
      const capture=await Promise.all(Array.from({length:concurrency},()=>drainCapture({limit:5})));
      const finalization=await Promise.all(Array.from({length:concurrency},()=>drainAttendanceFinalization({limit:10})));
      return {capture,finalization};
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
