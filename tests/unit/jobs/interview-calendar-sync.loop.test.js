// Recruitment Phase 3a — the calendar sync worker starter: env-gated, off
// under tests, drives the tick with a stable worker id, never throws.
import { jest, describe, it, expect } from "@jest/globals";

const { startInterviewCalendarSyncWorker, DEFAULT_CALENDAR_SYNC_INTERVAL_MS } = await import("../../../src/jobs/interview-calendar-sync.loop.js");

const loopStub = () => {
    const stop = jest.fn(async () => {});
    const startLoop = jest.fn(() => ({ stop }));
    return { startLoop, stop };
};

describe("startInterviewCalendarSyncWorker", () => {
    it("is a no-op unless HR_INTERVIEW_CALENDAR_WORKER_ENABLED is exactly 'true'", async () => {
        const { startLoop } = loopStub();
        for (const env of [{}, { HR_INTERVIEW_CALENDAR_WORKER_ENABLED: "1" }, { HR_INTERVIEW_CALENDAR_WORKER_ENABLED: "true", NODE_ENV: "test" }]) {
            const handle = startInterviewCalendarSyncWorker({ env, startLoop });
            expect(handle.enabled).toBe(false);
            await expect(handle.stop()).resolves.toBeUndefined();
        }
        expect(startLoop).not.toHaveBeenCalled();
    });

    it("starts the loop with the configured interval and worker id, and stops it", async () => {
        const { startLoop, stop } = loopStub();
        const runTick = jest.fn(async () => ({}));
        const handle = startInterviewCalendarSyncWorker({
            env: { HR_INTERVIEW_CALENDAR_WORKER_ENABLED: "true", NODE_ENV: "production", HR_INTERVIEW_CALENDAR_WORKER_ID: "cal-1", HR_INTERVIEW_CALENDAR_SYNC_INTERVAL_MS: "45000" },
            startLoop,
            runTick,
        });
        expect(handle.enabled).toBe(true);
        const { intervalMs, run } = startLoop.mock.calls[0][0];
        expect(intervalMs).toBe(45000);
        await run();
        expect(runTick).toHaveBeenCalledWith({ workerId: "cal-1" });
        await handle.stop();
        expect(stop).toHaveBeenCalled();
    });

    it("defaults the interval and survives a boot failure", () => {
        const { startLoop } = loopStub();
        startInterviewCalendarSyncWorker({ env: { HR_INTERVIEW_CALENDAR_WORKER_ENABLED: "true", NODE_ENV: "production" }, startLoop });
        expect(startLoop.mock.calls[0][0].intervalMs).toBe(DEFAULT_CALENDAR_SYNC_INTERVAL_MS);
        const broken = startInterviewCalendarSyncWorker({
            env: { HR_INTERVIEW_CALENDAR_WORKER_ENABLED: "true", NODE_ENV: "production" },
            startLoop: () => { throw new Error("no redis"); },
        });
        expect(broken.enabled).toBe(false);
    });
});
