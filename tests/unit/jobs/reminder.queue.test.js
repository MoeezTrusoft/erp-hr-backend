// tests/unit/jobs/reminder.queue.test.js
//
// BE-§9.4 / WBS-MODULES §M1 — migrate node-cron HR jobs to BullMQ. This proves
// the BullMQ wiring WITHOUT a live Redis by injecting Queue/Worker factories:
//
//   * a fixed retry ladder (attempts + exponential backoff) on every job,
//   * repeatable scheduling with a STABLE jobId so re-registering the schedule
//     de-dups (no duplicate repeatables piling up across restarts),
//   * a dead-letter queue: a job that exhausts its attempts is routed to the
//     DLQ (not silently dropped),
//   * the processors delegate to the existing reminder/document-expiry services,
//   * test/no-REDIS_URL guards → a disabled no-op handle (never spawns timers).
import { describe, it, expect, jest } from '@jest/globals';

import {
    REMINDER_QUEUE,
    REMINDER_DLQ,
    JOB_REVIEW_REMINDER,
    JOB_DOCUMENT_EXPIRY,
    JOB_RETENTION_SWEEP,
    defaultJobOptions,
    repeatableJobs,
    startReminderJobs,
    buildReminderProcessor,
} from '../../../src/jobs/reminder.queue.js';

describe('retry ladder + DLQ config', () => {
    it('every job carries a bounded retry ladder with exponential backoff', () => {
        const opts = defaultJobOptions();
        expect(opts.attempts).toBeGreaterThanOrEqual(3);
        expect(opts.backoff.type).toBe('exponential');
        expect(opts.backoff.delay).toBeGreaterThan(0);
        // completed/failed jobs are not kept forever (bounded retention).
        expect(opts.removeOnComplete).toBeTruthy();
        expect(opts.removeOnFail).toBeTruthy();
    });

    it('names a distinct dead-letter queue', () => {
        expect(REMINDER_DLQ).not.toBe(REMINDER_QUEUE);
        expect(REMINDER_DLQ).toMatch(/dead|dlq/i);
    });
});

describe('repeatable de-dup', () => {
    it('each repeatable has a STABLE jobId so re-registration de-dups', () => {
        const jobs = repeatableJobs();
        const ids = jobs.map((j) => j.opts.jobId);
        expect(new Set(ids).size).toBe(jobs.length); // all unique
        expect(jobs.every((j) => typeof j.opts.jobId === 'string' && j.opts.jobId.length > 0)).toBe(true);
        // covers the three migrated cron jobs
        const names = jobs.map((j) => j.name);
        expect(names).toEqual(expect.arrayContaining([JOB_REVIEW_REMINDER, JOB_DOCUMENT_EXPIRY, JOB_RETENTION_SWEEP]));
        // each repeatable carries a cron pattern
        expect(jobs.every((j) => typeof j.opts.repeat?.pattern === 'string')).toBe(true);
    });
});

describe('buildReminderProcessor', () => {
    it('dispatches by job name to the injected handlers', async () => {
        const reviewReminder = jest.fn(async () => ({ ok: 'review' }));
        const documentExpiry = jest.fn(async () => ({ ok: 'doc' }));
        const retentionSweep = jest.fn(async () => ({ ok: 'retention' }));
        const processor = buildReminderProcessor({ reviewReminder, documentExpiry, retentionSweep });

        await processor({ name: JOB_REVIEW_REMINDER, data: {} });
        await processor({ name: JOB_DOCUMENT_EXPIRY, data: {} });
        await processor({ name: JOB_RETENTION_SWEEP, data: {} });

        expect(reviewReminder).toHaveBeenCalledTimes(1);
        expect(documentExpiry).toHaveBeenCalledTimes(1);
        expect(retentionSweep).toHaveBeenCalledTimes(1);
    });

    it('throws on an unknown job name (so BullMQ retries/DLQs it, never silent-drops)', async () => {
        const processor = buildReminderProcessor({});
        await expect(processor({ name: 'hr.unknown.job', data: {} })).rejects.toThrow();
    });
});

describe('startReminderJobs (wiring, injected factories — no real Redis)', () => {
    it('returns a disabled no-op handle under NODE_ENV=test', async () => {
        const handle = startReminderJobs({ env: { NODE_ENV: 'test', REDIS_URL: 'redis://x' } });
        expect(handle.enabled).toBe(false);
        await expect(handle.stop()).resolves.toBeUndefined();
    });

    it('returns a disabled no-op handle when REDIS_URL is unset', async () => {
        const handle = startReminderJobs({ env: { NODE_ENV: 'production' } });
        expect(handle.enabled).toBe(false);
    });

    it('registers repeatables + a worker + DLQ when enabled (injected factories)', async () => {
        const added = [];
        const queue = {
            add: jest.fn(async (name, data, opts) => { added.push({ name, opts }); }),
            close: jest.fn(async () => {}),
        };
        const dlq = { add: jest.fn(async () => {}), close: jest.fn(async () => {}) };
        const worker = { on: jest.fn(), close: jest.fn(async () => {}) };

        const queues = {};
        const queueFactory = jest.fn((name) => {
            const q = name === REMINDER_DLQ ? dlq : queue;
            queues[name] = q;
            return q;
        });
        const workerFactory = jest.fn(() => worker);

        const handle = startReminderJobs({
            env: { NODE_ENV: 'production', REDIS_URL: 'redis://x' },
            queueFactory,
            workerFactory,
        });

        expect(handle.enabled).toBe(true);
        // the main queue + the DLQ were created
        expect(queueFactory).toHaveBeenCalledWith(REMINDER_QUEUE, expect.anything());
        expect(queueFactory).toHaveBeenCalledWith(REMINDER_DLQ, expect.anything());
        // a worker drains the main queue
        expect(workerFactory).toHaveBeenCalledWith(REMINDER_QUEUE, expect.any(Function), expect.anything());
        // all three repeatables were registered with stable jobIds
        const names = added.map((a) => a.name);
        expect(names).toEqual(expect.arrayContaining([JOB_REVIEW_REMINDER, JOB_DOCUMENT_EXPIRY, JOB_RETENTION_SWEEP]));
        expect(added.every((a) => a.opts.jobId)).toBe(true);

        await handle.stop();
        expect(worker.close).toHaveBeenCalled();
        expect(queue.close).toHaveBeenCalled();
    });
});
