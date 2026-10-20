// src/jobs/resume-parse.loop.js
//
// Phase 2 — the in-process driver of the asynchronous resume parse worker. It
// runs runResumeParseWorkerTick on the outbox loop's recursive-setTimeout
// cadence (best effort: a failing tick logs and backs off, it never takes the
// HTTP server down), with one worker id per process for claim attribution.
//
// Off unless HR_RESUME_PARSE_WORKER_ENABLED === "true" (the env idiom of
// src/services/separation/automation.js), and never under NODE_ENV=test. Each
// tick also re-checks the parseWorker and ai flags, so switching AI off stops
// parsing without a restart.
import { startOutboxDispatchLoop } from "./outbox.loop.js";
import { defaultWorkerId, runResumeParseWorkerTick } from "../services/resume-parse-worker.service.js";

export const DEFAULT_RESUME_PARSE_INTERVAL_MS = 10_000;
const ERROR_BACKOFF_MS = 30_000;

/**
 * @param {{ env?: object, startLoop?: Function }} [deps]  injectable for tests
 * @returns {{ enabled: boolean, workerId?: string, stop: () => Promise<void> }}
 */
export function startResumeParseWorker({ env = process.env, startLoop = startOutboxDispatchLoop } = {}) {
    if (String(env.NODE_ENV).toLowerCase() === "test" || env.HR_RESUME_PARSE_WORKER_ENABLED !== "true") {
        return { enabled: false, stop: async () => {} };
    }
    const workerId = defaultWorkerId();
    const intervalMs = Number.parseInt(env.HR_RESUME_PARSE_WORKER_INTERVAL_MS ?? "", 10) || DEFAULT_RESUME_PARSE_INTERVAL_MS;
    const loop = startLoop({
        run: () => runResumeParseWorkerTick({ workerId }),
        intervalMs,
        errorBackoffMs: ERROR_BACKOFF_MS,
    });
    return { enabled: true, workerId, stop: () => loop.stop() };
}

export default startResumeParseWorker;
