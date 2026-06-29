// tests/unit/services/reminderProcessors.test.js
//
// BE-§9.4 — the cron job BODIES, extracted from node-cron into reusable async
// processors that BullMQ drives. Proves they are idempotent-aware and return a
// bounded summary (so a BullMQ job result is meaningful), using a mocked prisma.
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const prismaMock = {
    performanceReview: { findMany: jest.fn() },
    reviewReminder: { findFirst: jest.fn(), create: jest.fn() },
    outboxEvent: { deleteMany: jest.fn() },
};

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../../src/config/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../../src/services/documentExpiryAlert.service.js', () => ({
    generateDocumentExpiryAlerts: jest.fn(async () => [{ id: 1 }, { id: 2 }]),
}));

const {
    runReviewReminderJob,
    runDocumentExpiryJob,
    runRetentionSweepJob,
} = await import('../../../src/services/reminderScheduler.service.js');

describe('reminder job processors', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('runReviewReminderJob creates a reminder only for reviews not already reminded today', async () => {
        prismaMock.performanceReview.findMany.mockResolvedValue([
            { id: 1, employeeId: 10 },
            { id: 2, employeeId: 20 },
        ]);
        // first review already reminded; second not.
        prismaMock.reviewReminder.findFirst
            .mockResolvedValueOnce({ id: 99 })
            .mockResolvedValueOnce(null);
        prismaMock.reviewReminder.create.mockResolvedValue({ id: 100 });

        const res = await runReviewReminderJob();

        expect(res.scanned).toBe(2);
        expect(res.created).toBe(1);
        expect(prismaMock.reviewReminder.create).toHaveBeenCalledTimes(1);
    });

    it('runDocumentExpiryJob delegates to the fleet-wide expiry sweep', async () => {
        const res = await runDocumentExpiryJob();
        expect(res.created).toBe(2);
    });

    it('runRetentionSweepJob prunes published outbox rows past the window', async () => {
        prismaMock.outboxEvent.deleteMany.mockResolvedValue({ count: 7 });
        const res = await runRetentionSweepJob({ retentionDays: 30 });
        expect(res.deleted).toBe(7);
        const where = prismaMock.outboxEvent.deleteMany.mock.calls[0][0].where;
        expect(where.publishedAt.not).toBeNull();
        expect(where.publishedAt.lt).toBeInstanceOf(Date);
    });
});
