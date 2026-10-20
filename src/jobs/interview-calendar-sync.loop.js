// src/jobs/interview-calendar-sync.loop.js — Recruitment Phase 3a worker.
//
// Drives runInterviewCalendarSyncTick (src/services/interview-calendar-sync
// .service.js) on startOutboxDispatchLoop: every pass writes the interviews
// marked PENDING (or due for a retry) to calendars through the Communication
// module.
//
// Env-gated like the other workers: nothing starts under NODE_ENV=test or
// unless HR_INTERVIEW_CALENDAR_WORKER_ENABLED=true. The `calendarSync` flag is
// read on every pass, so an operator can stop calendar writes without
// stopping the worker. Best-effort: a boot error is logged and a no-op handle
// returned; the HTTP server never depends on this worker.
import logger from "../lib/logger.js";
import { startOutboxDispatchLoop } from "./outbox.loop.js";
import { generateWorkerId, sanitiseWorkerId } from "./outbox.dispatcher.js";
import { runInterviewCalendarSyncTick } from "../services/interview-calendar-sync.service.js";

export const DEFAULT_CALENDAR_SYNC_INTERVAL_MS = 30_000;

/**
 * @returns {{ enabled: boolean, stop: () => Promise<void> }}
 */
export function startInterviewCalendarSyncWorker({
    env = process.env,
    startLoop = startOutboxDispatchLoop,
    runTick = runInterviewCalendarSyncTick,
} = {}) {
    const noop = { enabled: false, stop: async () => {} };
    if (env.NODE_ENV === "test" || env.HR_INTERVIEW_CALENDAR_WORKER_ENABLED !== "true") return noop;
    try {
        const workerId = sanitiseWorkerId(env.HR_INTERVIEW_CALENDAR_WORKER_ID) || generateWorkerId();
        const intervalMs = Number.parseInt(env.HR_INTERVIEW_CALENDAR_SYNC_INTERVAL_MS ?? "", 10) || DEFAULT_CALENDAR_SYNC_INTERVAL_MS;
        const loop = startLoop({ intervalMs, logger, run: () => runTick({ workerId }) });
        logger.info({ workerId, intervalMs }, "interview calendar sync worker: started");
        return {
            enabled: true,
            async stop() {
                await loop.stop();
            },
        };
    } catch (err) {
        logger.error({ errMessage: err?.message }, "interview calendar sync worker: failed to start");
        return noop;
    }
}

export default startInterviewCalendarSyncWorker;
