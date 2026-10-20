// Recruitment Phase 2 — the candidate communication worker boots the hr:events
// consumer and the delivery loop together, only when switched on.
import { jest, describe, it, expect } from "@jest/globals";

jest.unstable_mockModule("../../../src/services/candidate-communication.consumer.js", () => ({
    startCandidateCommunicationConsumer: jest.fn(() => ({ enabled: false, stop: async () => {} })),
}));
jest.unstable_mockModule("../../../src/services/candidate-communication.delivery.js", () => ({
    runCandidateCommunicationDeliveryTick: jest.fn(async () => ({ scanned: 0 })),
}));

const { startCandidateCommunicationWorker } = await import("../../../src/jobs/candidate-communication.loop.js");

const deps = () => {
    const consumerStop = jest.fn(async () => {});
    const loopStop = jest.fn(async () => {});
    return {
        consumerStop,
        loopStop,
        startConsumer: jest.fn(() => ({ enabled: true, stop: consumerStop })),
        startLoop: jest.fn(() => ({ stop: loopStop })),
        runTick: jest.fn(async () => ({})),
    };
};

describe("startCandidateCommunicationWorker", () => {
    it("is a no-op under test or without the worker switch", async () => {
        for (const env of [{ NODE_ENV: "test", HR_CANDIDATE_COMMS_WORKER_ENABLED: "true" }, { HR_CANDIDATE_COMMS_WORKER_ENABLED: "yes" }, {}]) {
            const d = deps();
            const handle = startCandidateCommunicationWorker({ env, ...d });
            expect(handle.enabled).toBe(false);
            await handle.stop();
            expect(d.startConsumer).not.toHaveBeenCalled();
            expect(d.startLoop).not.toHaveBeenCalled();
        }
    });

    it("starts the consumer and the delivery loop, and stops both", async () => {
        const d = deps();
        const env = { HR_CANDIDATE_COMMS_WORKER_ENABLED: "true", HR_CANDIDATE_COMMS_WORKER_ID: "hr-1", HR_CANDIDATE_COMMS_DELIVERY_INTERVAL_MS: "5000" };
        const handle = startCandidateCommunicationWorker({ env, ...d });
        expect(handle.enabled).toBe(true);
        expect(d.startConsumer).toHaveBeenCalledWith({ env });
        const [{ intervalMs, run }] = d.startLoop.mock.calls[0];
        expect(intervalMs).toBe(5000);
        await run();
        expect(d.runTick).toHaveBeenCalledWith({ workerId: "hr-1" });
        await handle.stop();
        expect(d.consumerStop).toHaveBeenCalled();
        expect(d.loopStop).toHaveBeenCalled();
    });

    it("returns a no-op handle when boot throws", () => {
        const d = deps();
        d.startLoop.mockImplementation(() => {
            throw new Error("boom");
        });
        expect(startCandidateCommunicationWorker({ env: { HR_CANDIDATE_COMMS_WORKER_ENABLED: "true" }, ...d }).enabled).toBe(false);
    });
});
