// tests/unit/services/reminderProcessors.test.js
//
// BE-§9.4 — the cron job BODIES, extracted from node-cron into reusable async
// processors that BullMQ drives. Proves they are idempotent-aware and return a
// bounded summary (so a BullMQ job result is meaningful), using a mocked prisma.
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const prismaMock = {
    performanceReview: { findMany: jest.fn() },
    reviewReminder: { findFirst: jest.fn(), create: jest.fn() },
    outboxEvent: { deleteMany: jest.fn() },
    candidateRetentionPolicy: { findMany: jest.fn() },
    // Recruitment Phase 5 — each tenant's run is recorded and reads the
    // tenant's apply switch (src/services/retention-run.service.js).
    tenantRecruitmentSettings: { findUnique: jest.fn() },
    candidateRetentionRun: { create: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(async (fn) => fn(prismaMock)),
    $executeRaw: jest.fn(async () => 1),
};
prismaMock.outboxEvent.create = jest.fn(async ({ data }) => ({ id: 1, ...data }));

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../../src/config/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../../src/services/documentExpiryAlert.service.js', () => ({
    generateDocumentExpiryAlerts: jest.fn(async () => [{ id: 1 }, { id: 2 }]),
}));
// Phase 10 (remainder) — the candidate-retention job delegates the erasure itself
// to the privacy service, which is mocked here so these tests cover the JOB's
// rules (mode gating, tenant discovery, isolation) rather than the erasure.
const applyRetention = jest.fn();
jest.unstable_mockModule('../../../src/services/candidatePrivacy.service.js', () => ({ applyRetention }));
// The scheduler also hosts the D-07 recruitment sweeps; their services are
// covered by tests/unit/jobs/recruitment-sweeps.job.test.js and stubbed here so
// this suite's module graph stays limited to the reminder processors.
jest.unstable_mockModule('../../../src/services/requisitionPublication.service.js', () => ({
    autoCloseFilledRequisitions: jest.fn(async () => []),
    autoPublishApprovedRequisitions: jest.fn(async () => ({ published: [], skipped: [], failed: [] })),
    closePostingsPastClosesAt: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../../src/services/talentPoolInvitation.service.js', () => ({
    expireInvitations: jest.fn(async () => ({ dryRun: false, expired: [] })),
}));

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

// Tenants are RBAC Company UUIDs: the dry-run report event's envelope requires one.
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('Phase 10 (remainder) — candidate retention job', () => {
    let nextRunId = 1;
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.HR_CANDIDATE_RETENTION_MODE = '';
        delete process.env.HR_RECRUITMENT_RETENTION_AUTOMATION;
        nextRunId = 1;
        prismaMock.tenantRecruitmentSettings.findUnique.mockResolvedValue(null);
        prismaMock.candidateRetentionRun.create.mockImplementation(async ({ data }) => ({ id: nextRunId++, ...data }));
        prismaMock.candidateRetentionRun.updateMany.mockResolvedValue({ count: 1 });
    });
    afterEach(() => {
        delete process.env.HR_RECRUITMENT_RETENTION_AUTOMATION;
    });
    // Recruitment Phase 5 — apply needs the flag AND the tenant's signed-off switch.
    const signedOffTenant = () => {
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = 'true';
        prismaMock.tenantRecruitmentSettings.findUnique.mockResolvedValue({ retentionApplyEnabled: true, dataPolicyOwnerId: 42, version: 2 });
    };

    it('is a DRY RUN by default: a scheduled job must not erase without an explicit mode', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([
            { tenantId: TENANT_A, appliesTo: 'APPLICANT', retentionMonths: 6 },
        ]);
        applyRetention.mockResolvedValue({ wouldAnonymize: [1, 2], suspendedByLegalHold: [] });

        const result = await runCandidateRetentionJob();

        expect(applyRetention).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: TENANT_A, dryRun: true, limit: 100 }),
        );
        expect(result).toMatchObject({ mode: 'dry-run', tenants: 1, wouldAnonymize: 2, anonymized: 0 });
        // Recruitment Phase 5 — the run is recorded and its report is sent.
        expect(prismaMock.candidateRetentionRun.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ tenantId: TENANT_A, mode: 'DRY_RUN', wouldAnonymize: 2 }) }),
        );
        expect(result.perTenant).toEqual([
            { tenantId: TENANT_A, runId: 1, mode: 'DRY_RUN', wouldAnonymize: 2, suspendedByLegalHold: 0, reportSent: true },
        ]);
    });

    it('erases ONLY when the mode is explicitly apply (and the tenant signed off)', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([
            { tenantId: TENANT_A, appliesTo: 'APPLICANT', retentionMonths: 6 },
        ]);
        signedOffTenant();
        applyRetention.mockResolvedValue({ dryRun: false, anonymized: [1], suspendedByLegalHold: [] });

        const result = await runCandidateRetentionJob({ mode: 'apply' });

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
        expect(result).toMatchObject({ mode: 'apply', anonymized: 1 });
    });

    it('dry-runs a tenant in apply mode until its data-policy owner signs off', async () => {
        prismaMock.candidateRetentionPolicy.findMany.mockResolvedValue([
            { tenantId: TENANT_A, appliesTo: 'APPLICANT', retentionMonths: 6 },
        ]);
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = 'true';
        applyRetention.mockResolvedValue({ dryRun: true, wouldAnonymize: [1], suspendedByLegalHold: [] });

        const result = await runCandidateRetentionJob({ mode: 'apply' });

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
        expect(result).toMatchObject({ mode: 'apply', anonymized: 0, wouldAnonymize: 1 });
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
            { tenantId: TENANT_A, appliesTo: 'APPLICANT', retentionMonths: 6 },
            { tenantId: TENANT_A, appliesTo: 'TALENT_POOL', retentionMonths: 24 },
            { tenantId: TENANT_B, appliesTo: 'APPLICANT', retentionMonths: 6 },
        ]);
        signedOffTenant();
        applyRetention
            .mockRejectedValueOnce(new Error('DB blip'))
            .mockResolvedValueOnce({ dryRun: false, anonymized: [9], suspendedByLegalHold: [{ id: 3 }] });

        const result = await runCandidateRetentionJob({ mode: 'apply' });

        expect(result.tenants).toBe(2);
        expect(result.anonymized).toBe(1);
        expect(result.suspendedByLegalHold).toBe(1);
        expect(result.perTenant).toEqual([
            { tenantId: TENANT_A, runId: 1, error: 'DB blip' },
            { tenantId: TENANT_B, runId: 2, mode: 'APPLY', anonymized: 1, suspendedByLegalHold: 1 },
        ]);
        // The failure is recorded too.
        expect(prismaMock.candidateRetentionRun.create.mock.calls[0][0].data).toMatchObject({ tenantId: TENANT_A, status: 'FAILED', error: 'DB blip' });
    });
});
