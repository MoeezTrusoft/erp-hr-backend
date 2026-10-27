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
    candidateRetentionPolicy: { findMany: jest.fn() },
};

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../../src/config/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../../src/services/documentExpiryAlert.service.js', () => ({
    generateDocumentExpiryAlerts: jest.fn(async () => [{ id: 1 }, { id: 2 }]),
}));
// Phase 10 (remainder) — the candidate-retention job delegates the erasure itself
// to the privacy service, which is mocked here so these tests cover the JOB's
// rules (mode gating, tenant discovery, isolation) rather than the erasure.
const applyRetention = jest.fn();
jest.unstable_mockModule('../../../src/services/candidatePrivacy.service.js', () => ({ applyRetention, assertCommunicationsAllowed: jest.fn(), computeRetentionUntil: jest.fn() }));

const {
    runReviewReminderJob,
    runDocumentExpiryJob,
    runRetentionSweepJob,
    runCandidateRetentionJob,
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

describe('Phase 10 (remainder) — candidate retention job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.HR_CANDIDATE_RETENTION_MODE = '';
    });

    it('is a DRY RUN by default: a scheduled job must not erase without an explicit mode', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([
            { tenantId: 'tenant-a', appliesTo: 'APPLICANT', retentionMonths: 6 },
        ]);
        applyRetention.mockResolvedValue({ wouldAnonymize: [1, 2], suspendedByLegalHold: [] });

        const result = await runCandidateRetentionJob();

        expect(applyRetention).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-a', dryRun: true, limit: 100 }),
        );
        expect(result).toMatchObject({ mode: 'dry-run', tenants: 1, wouldAnonymize: 2, anonymized: 0 });
    });

    it('erases ONLY when the mode is explicitly apply', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([
            { tenantId: 'tenant-a', appliesTo: 'APPLICANT', retentionMonths: 6 },
        ]);
        applyRetention.mockResolvedValue({ anonymized: [1], suspendedByLegalHold: [] });

        const result = await runCandidateRetentionJob({ mode: 'apply' });

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
        expect(result).toMatchObject({ mode: 'apply', anonymized: 1 });
    });

    it('falls back to dry-run on an unrecognized mode — a typo can never turn on erasure', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([]);

        const result = await runCandidateRetentionJob({ mode: 'APPLY_NOW' });

        expect(result.mode).toBe('dry-run');
    });

    it('does nothing when the mode is off, without even reading the policies', async () => {
        const result = await runCandidateRetentionJob({ mode: 'off' });

        expect(result).toMatchObject({ mode: 'off', tenants: 0 });
        expect(prismaMock.candidateRetentionPolicy.findMany).not.toHaveBeenCalled();
        expect(applyRetention).not.toHaveBeenCalled();
    });

    it('runs only for tenants that HAVE an active policy — no policy, no tenant, no window', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([]);

        const result = await runCandidateRetentionJob({ mode: 'apply' });

        expect(applyRetention).not.toHaveBeenCalled();
        expect(result).toMatchObject({ tenants: 0, anonymized: 0 });
    });

    it('de-duplicates tenants and keeps going when ONE tenant fails', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([
            { tenantId: 'tenant-a', appliesTo: 'APPLICANT', retentionMonths: 6 },
            { tenantId: 'tenant-a', appliesTo: 'TALENT_POOL', retentionMonths: 24 },
            { tenantId: 'tenant-b', appliesTo: 'APPLICANT', retentionMonths: 6 },
        ]);
        applyRetention
            .mockRejectedValueOnce(new Error('DB blip'))
            .mockResolvedValueOnce({ anonymized: [9], suspendedByLegalHold: [{ id: 3 }] });

        const result = await runCandidateRetentionJob({ mode: 'apply' });

        expect(result.tenants).toBe(2);
        expect(result.anonymized).toBe(1);
        expect(result.suspendedByLegalHold).toBe(1);
        expect(result.perTenant).toEqual([
            { tenantId: 'tenant-a', error: 'DB blip' },
            { tenantId: 'tenant-b', anonymized: 1, suspendedByLegalHold: 1 },
        ]);
    });
});
