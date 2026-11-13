// F-03 / ARCH-01 §9 — boot wiring and clean shutdown.
import { jest, describe, it, expect } from "@jest/globals";

const { startSystemAccountProvisioningWorker } = await import(
  "../../../src/jobs/system-account-provisioning.loop.js"
);

describe("F-03 provisioning worker lifecycle", () => {
  it("auto-starts one best-effort loop and delegates clean shutdown", async () => {
    const stop = jest.fn(async () => {});
    const startLoop = jest.fn(() => ({ stop }));
    const runBatch = jest.fn(async () => ({}));
    const prismaClient = { systemAccountProvisioning: {} };
    const workerLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    const handle = startSystemAccountProvisioningWorker({
      env: {
        NODE_ENV: "production",
        HR_ACCOUNT_PROVISIONING_INTERVAL_MS: "2500",
        HR_ACCOUNT_PROVISIONING_LEASE_MS: "45000",
        HR_ACCOUNT_PROVISIONING_BATCH: "11",
      },
      prismaClient,
      workerLogger,
      startLoop,
      runBatch,
    });

    expect(handle.enabled).toBe(true);
    expect(startLoop).toHaveBeenCalledTimes(1);
    const loopOptions = startLoop.mock.calls[0][0];
    expect(loopOptions.intervalMs).toBe(2500);
    await loopOptions.run();
    expect(runBatch).toHaveBeenCalledWith(expect.objectContaining({
      prisma: prismaClient,
      workerId: handle.workerId,
      leaseMs: 45000,
      batchSize: 11,
    }));
    await handle.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not start timers in tests or when explicitly disabled", () => {
    const startLoop = jest.fn();
    expect(startSystemAccountProvisioningWorker({ env: { NODE_ENV: "test" }, startLoop }).enabled).toBe(false);
    expect(startSystemAccountProvisioningWorker({
      env: { NODE_ENV: "production", HR_ACCOUNT_PROVISIONING_ENABLED: "false" }, startLoop,
    }).enabled).toBe(false);
    expect(startLoop).not.toHaveBeenCalled();
  });
});
