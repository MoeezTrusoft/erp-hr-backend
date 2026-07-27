// F-03 / ARCH-01 §9 — best-effort in-process driver for the durable projection.
import crypto from "node:crypto";
import os from "node:os";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { startOutboxDispatchLoop } from "./outbox.loop.js";
import { runSystemAccountProvisioningBatch } from "./system-account-provisioning.js";

export function startSystemAccountProvisioningWorker({
  env = process.env,
  prismaClient = prisma,
  workerLogger = logger,
  startLoop = startOutboxDispatchLoop,
  runBatch = runSystemAccountProvisioningBatch,
} = {}) {
  const noop = { enabled: false, stop: async () => {} };
  if (String(env.NODE_ENV).toLowerCase() === "test" || String(env.HR_ACCOUNT_PROVISIONING_ENABLED).toLowerCase() === "false") {
    return noop;
  }
  try {
    const workerId = `hr-acct:${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`.slice(0, 128);
    const intervalMs = Number.parseInt(env.HR_ACCOUNT_PROVISIONING_INTERVAL_MS || "3000", 10);
    const leaseMs = Number.parseInt(env.HR_ACCOUNT_PROVISIONING_LEASE_MS || "60000", 10);
    const batchSize = Number.parseInt(env.HR_ACCOUNT_PROVISIONING_BATCH || "25", 10);
    const loop = startLoop({
      intervalMs,
      logger: workerLogger,
      run: () => runBatch({ prisma: prismaClient, logger: workerLogger, workerId, leaseMs, batchSize }),
    });
    workerLogger.info?.({ workerId, intervalMs }, "F-03 system-account provisioning worker started");
    return { enabled: true, workerId, stop: () => loop.stop() };
  } catch (error) {
    workerLogger.error?.({ err: { message: error?.message } }, "F-03 system-account provisioning worker failed to start");
    return noop;
  }
}
