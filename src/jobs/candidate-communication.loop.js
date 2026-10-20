// src/jobs/candidate-communication.loop.js — Recruitment Phase 2 worker.
//
// Boots the two halves of candidate communications in-process:
//   * the hr:events consumer that turns recruitment events into QUEUED rows
//     (src/services/candidate-communication.consumer.js), and
//   * the delivery loop that sends due rows through the Notification Hub
//     (runCandidateCommunicationDeliveryTick on startOutboxDispatchLoop).
//
// Env-gated like the other workers: nothing starts under NODE_ENV=test or
// unless HR_CANDIDATE_COMMS_WORKER_ENABLED=true. The `communications` flag is
// read by both halves on every pass, so an operator can stop messages without
// stopping the worker. Best-effort: a boot error is logged and a no-op handle
// returned; the HTTP server never depends on this worker.
import logger from "../lib/logger.js";
import { startOutboxDispatchLoop } from "./outbox.loop.js";
import { generateWorkerId, sanitiseWorkerId } from "./outbox.dispatcher.js";
import { startCandidateCommunicationConsumer } from "../services/candidate-communication.consumer.js";
import { runCandidateCommunicationDeliveryTick } from "../services/candidate-communication.delivery.js";

export const DEFAULT_DELIVERY_INTERVAL_MS = 15_000;

/**
 * @returns {{ enabled: boolean, stop: () => Promise<void> }}
 */
export function startCandidateCommunicationWorker({
    env = process.env,
    startConsumer = startCandidateCommunicationConsumer,
    startLoop = startOutboxDispatchLoop,
    runTick = runCandidateCommunicationDeliveryTick,
} = {}) {
    const noop = { enabled: false, stop: async () => {} };
    if (env.NODE_ENV === "test" || env.HR_CANDIDATE_COMMS_WORKER_ENABLED !== "true") return noop;
    try {
        const workerId = sanitiseWorkerId(env.HR_CANDIDATE_COMMS_WORKER_ID) || generateWorkerId();
        const intervalMs = Number.parseInt(env.HR_CANDIDATE_COMMS_DELIVERY_INTERVAL_MS ?? "", 10) || DEFAULT_DELIVERY_INTERVAL_MS;
        const consumer = startConsumer({ env });
        const delivery = startLoop({ intervalMs, logger, run: () => runTick({ workerId }) });
        logger.info({ workerId, intervalMs, consumer: consumer.enabled }, "candidate communication worker: started");
        return {
            enabled: true,
            async stop() {
                await Promise.allSettled([consumer.stop(), delivery.stop()]);
            },
        };
    } catch (err) {
        logger.error({ errMessage: err?.message }, "candidate communication worker: failed to start");
        return noop;
    }
}

export default startCandidateCommunicationWorker;
