// src/jobs/onboarding-calendar-sync.loop.js — Recruitment Phase 4 worker.
//
// Drives runOnboardingCalendarSyncTick (src/services/onboarding-calendar-sync
// .service.js) on startOutboxDispatchLoop: every pass writes the onboarding
// sessions marked PENDING (or due for a retry) to the new hire's and the
// host's calendars through the Communication module.
//
// Env-gated like the interview calendar worker: nothing starts under
// NODE_ENV=test or unless HR_ONBOARDING_CALENDAR_WORKER_ENABLED=true. The
// onboardingAutomation and calendarSync flags are read on every pass, so an
// operator can stop invites without stopping the worker. Best-effort: a boot
// error is logged and a no-op handle returned; the HTTP server never depends
// on this worker.
import logger from "../lib/logger.js";
import { startOutboxDispatchLoop } from "./outbox.loop.js";
import { generateWorkerId, sanitiseWorkerId } from "./outbox.dispatcher.js";
import { runOnboardingCalendarSyncTick } from "../services/onboarding-calendar-sync.service.js";

export const DEFAULT_ONBOARDING_CALENDAR_SYNC_INTERVAL_MS = 30_000;

/**
 * @returns {{ enabled: boolean, stop: () => Promise<void> }}
 */
export function startOnboardingCalendarSyncWorker({
    env = process.env,
    startLoop = startOutboxDispatchLoop,
    runTick = runOnboardingCalendarSyncTick,
} = {}) {
    const noop = { enabled: false, stop: async () => {} };
    if (env.NODE_ENV === "test" || env.HR_ONBOARDING_CALENDAR_WORKER_ENABLED !== "true") return noop;
    try {
        const workerId = sanitiseWorkerId(env.HR_ONBOARDING_CALENDAR_WORKER_ID) || generateWorkerId();
        const intervalMs = Number.parseInt(env.HR_ONBOARDING_CALENDAR_SYNC_INTERVAL_MS ?? "", 10) || DEFAULT_ONBOARDING_CALENDAR_SYNC_INTERVAL_MS;
        const loop = startLoop({ intervalMs, logger, run: () => runTick({ workerId }) });
        logger.info({ workerId, intervalMs }, "onboarding calendar sync worker: started");
        return {
            enabled: true,
            async stop() {
                await loop.stop();
            },
        };
    } catch (err) {
        logger.error({ errMessage: err?.message }, "onboarding calendar sync worker: failed to start");
        return noop;
    }
}

export default startOnboardingCalendarSyncWorker;
