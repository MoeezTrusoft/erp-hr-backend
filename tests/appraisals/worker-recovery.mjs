import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";
process.env.DATABASE_URL =
  "postgresql://appraisal_runtime@127.0.0.1:55443/performance_appraisals_test";
process.env.NODE_ENV = "test";
const redisUrl = process.env.APPRAISAL_TEST_REDIS_URL;
assert.equal(
  redisUrl,
  "redis://127.0.0.1:56379",
  "Only the isolated test Redis tunnel is allowed",
);
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { launchWork, reconcileLaunches } =
  await import("../../src/services/appraisals/jobs.js");
test(
  "Real BullMQ restores a lost launch job and retries a failure after commit without duplicating reviews",
  { timeout: 60000 },
  async () => {
    const tenant = randomUUID(),
      runId = randomUUID(),
      jobId = "launch-" + runId;
    const db = (fn) =>
      mcpCtx.run({ user: { tenantId: tenant } }, () =>
        tenantTransaction(prisma, fn, { tenantId: tenant, txOptions:{timeout:30000} }),
      );
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const name = "appraisal-recovery-" + randomUUID();
    const queue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    let worker,
      cycle,
      crashed = false;
    try {
      await events.waitUntilReady();
      cycle = await db(async (tx) => {
        const manager=await tx.employee.create({data:{tenant_id:tenant,employee_code:tenant.slice(0,8)+'-MGR',employement_status:'Active'}});
        const people=await tx.employee.createManyAndReturn({data:Array.from({length:501},(_,index)=>({
          tenant_id:tenant,employee_code:tenant.slice(0,8)+'-'+index,employement_status:'Active',managerId:manager.id,
        })),select:{id:true}});
        await tx.perfConfiguration.create({
          data: {
            tenantId: tenant,
            coreEnabled: true,
            policy: { schemaVersion: 1 },
          },
        });
        const template = await tx.perfTemplateVersion.create({
          data: {
            tenantId: tenant,
            name: "Recovery fixture",
            createdBy: manager.id,
            rubric: { schemaVersion: 1 },
            status: "PUBLISHED",
            publishedAt: new Date(),
          },
        });
        const cycle = await tx.perfCycle.create({
          data: {
            tenantId: tenant,
            name: "Recovery fixture",
            templateId: template.id,
            policy: { schemaVersion: 1 },
            status: "ACTIVE",
            timezone: "UTC",
            periodStart: "2070-01-01",
            periodEnd: "2070-12-31",
            selfDue: new Date("2070-06-01T00:00:00Z"),
            managerDue: new Date("2070-06-15T00:00:00Z"),
          },
        });
        await tx.perfParticipant.createMany({
          data: people.map(person => ({
            tenantId: tenant,
            cycleId: cycle.id,
            employeeId: person.id,
            managerId: manager.id,
            snapshot: {
              employeeId: person.id,
              managerId: manager.id,
              fixture: true,
            },
            originalSelfDue: cycle.selfDue,
            originalManagerDue: cycle.managerDue,
          })),
        });
        await tx.perfLaunchRun.create({
          data: {
            id: runId,
            tenantId: tenant,
            cycleId: cycle.id,
            total: 501,
            jobId,
          },
        });
        return cycle;
      });
      // A committed first batch survives even when no corresponding Redis job exists.
      assert.equal(
        (await launchWork(tenant, { cycleId: cycle.id })).processed,
        250,
      );
      assert.equal(await queue.getJob(jobId), undefined);
      await reconcileLaunches(queue, tenant);
      await reconcileLaunches(queue, tenant);
      const job = await queue.getJob(jobId);
      assert.equal(job.id, jobId);
      assert.equal(await queue.getWaitingCount(), 1);
      worker = new Worker(
        name,
        async (current) => {
          for (;;) {
            const result = await launchWork(current.data.tenantId, {
              cycleId: current.data.cycleId,
            });
            if (!crashed) {
              crashed = true;
              throw new Error(
                "Test: acknowledgement lost after committed batch",
              );
            }
            if (result.done) return result;
          }
        },
        { connection, concurrency: 1 },
      );
      worker.on("error", () => {});
      const result = await job.waitUntilFinished(events, 45000);
      assert.equal(result.processed, 501);
      const final = await db(async (tx) => ({
        run: await tx.perfLaunchRun.findFirst({ where: { id: runId } }),
        batches: await tx.perfLaunchBatch.findMany({
          where: { runId },
          orderBy: { batchNo: "asc" },
        }),
        reviews: await tx.perfReview.count({ where: { cycleId: cycle.id } }),
        completedEvents: await tx.outboxEvent.count({
          where: {
            tenantId: tenant,
            eventName: "hr.performance.cycle.launched.v1",
          },
        }),
      }));
      assert.equal(final.run.state, "SUCCEEDED");
      assert.equal(final.reviews, 501);
      assert.deepEqual(
        final.batches.map((b) => b.count),
        [250, 250, 1],
      );
      assert.equal(final.completedEvents, 1);
      assert.equal((await queue.getJob(jobId)).attemptsMade, 2);
    } finally {
      await worker?.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
      await prisma.$disconnect();
    }
  },
);
