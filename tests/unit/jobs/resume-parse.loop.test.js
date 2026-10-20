// Phase 2 — the resume parse worker's boot gate: off unless
// HR_RESUME_PARSE_WORKER_ENABLED === "true", never under NODE_ENV=test, and
// a stop handle either way.
import { jest, describe, it, expect } from "@jest/globals";

const runResumeParseWorkerTick = jest.fn(async () => ({ scanned: 0 }));
jest.unstable_mockModule("../../../src/services/resume-parse-worker.service.js", () => ({
    runResumeParseWorkerTick,
    defaultWorkerId: () => "resume-parse:host:1",
}));

const { startResumeParseWorker } = await import("../../../src/jobs/resume-parse.loop.js");

describe("startResumeParseWorker", () => {
    it("is a no-op handle unless enabled, and under tests", async () => {
        const startLoop = jest.fn();
        for (const env of [{}, { HR_RESUME_PARSE_WORKER_ENABLED: "1" }, { NODE_ENV: "test", HR_RESUME_PARSE_WORKER_ENABLED: "true" }]) {
            const handle = startResumeParseWorker({ env, startLoop });
            expect(handle.enabled).toBe(false);
            await expect(handle.stop()).resolves.toBeUndefined();
        }
        expect(startLoop).not.toHaveBeenCalled();
    });

    it("drives the tick on the outbox loop with a stable worker id and returns its stop", async () => {
        const stop = jest.fn(async () => {});
        const startLoop = jest.fn(() => ({ stop }));
        const handle = startResumeParseWorker({
            env: { NODE_ENV: "production", HR_RESUME_PARSE_WORKER_ENABLED: "true", HR_RESUME_PARSE_WORKER_INTERVAL_MS: "5000" },
            startLoop,
        });
        expect(handle).toMatchObject({ enabled: true, workerId: "resume-parse:host:1" });
        const { run, intervalMs } = startLoop.mock.calls[0][0];
        expect(intervalMs).toBe(5000);
        await run();
        expect(runResumeParseWorkerTick).toHaveBeenCalledWith({ workerId: "resume-parse:host:1" });
        await handle.stop();
        expect(stop).toHaveBeenCalled();
    });
});
