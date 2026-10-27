// Recruitment Phase 4 exit gate, against a real PostgreSQL.
//
// "Acceptance creates everything day one needs, and failures page someone":
//   1. an ACCEPTED offer's handoff produces the employee (server-allocated
//      code), employment terms, the payroll assignment, the checklist and its
//      tasks, the orientation sessions (invites queued) and the IT
//      provisioning requests, all in one transaction, with their events;
//   2. replaying the handoff changes nothing;
//   3. two days before the start the readiness job finds the open gaps and
//      alerts once;
//   4. an induced failure (a new hire with no employee category) records
//      FAILED, emits handoff_failed and counts outcome="failed" on the
//      counter the alert rule watches.
//
// Runs only when the database is reachable (a bare checkout stays green). Every
// row lives under a throwaway tenant and is deleted afterwards.
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import client from 'prom-client';

const TENANT = randomUUID();
const FLAGS = {
    HR_RECRUITMENT_OFFER_HANDOFF: 'true',
    HR_ONBOARDING_AUTOMATION: 'true',
    HR_RECRUITMENT_CALENDAR_SYNC: 'true',
};
const saved = {};
// Salaries are C4 data: a throwaway key when the environment has none (the
// rows are deleted afterwards), as the C4 at-rest suite does.
if (!process.env.HR_C4_ENCRYPTION_KEY) {
    FLAGS.HR_C4_ENCRYPTION_KEY = randomBytes(32).toString('base64');
}
for (const [key, value] of Object.entries(FLAGS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
}

const { default: prisma } = await import('../../src/lib/prisma.js');
const { mcpCtx } = await import('../../src/mcp/context.js');
const { runOfferHandoff } = await import('../../src/services/recruitment-handoff.service.js');
const { runOnboardingReadinessJob } = await import('../../src/services/onboarding-readiness.service.js');

const asSystem = (fn) => mcpCtx.run({ system: true }, async () => await fn());
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT, employeeId: null } }, async () => await fn());

// A Monday at least two weeks out, so the sessions land on working days and
// the readiness window can be reached by moving `now`.
const START = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 14 + ((8 - d.getUTCDay()) % 7));
    return d;
})();

let ready = false;
const seeded = {};

async function seedOffer({ email, category }) {
    return asSystem(async () => {
        const candidate = await prisma.candidate.create({
            data: { tenantId: TENANT, firstName: 'Ayesha', lastName: 'Khan', email },
        });
        const application = await prisma.application.create({
            data: { tenantId: TENANT, candidateId: candidate.id, jobRequisitionId: seeded.requisition.id, stage: 'offer' },
        });
        return prisma.offer.create({
            data: {
                tenantId: TENANT,
                applicationId: application.id,
                candidateId: candidate.id,
                jobRequisitionId: seeded.requisition.id,
                salary: 150000,
                currency: 'PKR',
                status: 'ACCEPTED',
                startDate: START,
                employmentType: 'FULL_TIME',
                ...(category ? { employeeCategory: category } : {}),
                createdById: seeded.recruiter.id,
            },
        });
    });
}

const failedCount = async () => {
    const metric = client.register.getSingleMetric('hr_recruitment_handoffs_total');
    if (!metric) return 0;
    const { values } = await metric.get();
    return values.filter((v) => v.labels.outcome === 'failed').reduce((sum, v) => sum + v.value, 0);
};

const outbox = (eventName) =>
    asSystem(async () => await prisma.outboxEvent.findMany({ where: { tenantId: TENANT, eventName } }));

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1 FROM onboarding_provisioning_requests LIMIT 1`;
        ready = true;
    } catch {
        ready = false;
        return;
    }
    await asSystem(async () => {
        seeded.recruiter = await prisma.employee.create({
            data: {
                tenant_id: TENANT,
                first_name: 'Rec',
                last_name: 'Ruiter',
                status: 'active',
                employeeCategory: 'EMPLOYEE',
                employee_code: `T-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
            },
        });
        seeded.requisition = await prisma.jobRequisition.create({
            data: { tenantId: TENANT, title: 'P4 exit gate role', requestedById: seeded.recruiter.id },
        });
    });
}, 60_000);

afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    if (!ready) {
        await prisma.$disconnect();
        return;
    }
    // Delete every row of the throwaway tenant: each table with a tenant
    // column, repeated until the foreign keys stop refusing.
    const tables = await prisma.$queryRaw`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tenantId', 'tenant_id')`;
    for (let pass = 0; pass < 6; pass++) {
        let refused = 0;
        for (const { table_name: table, column_name: column } of tables) {
            try {
                await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}"::text = $1`, TENANT);
            } catch {
                refused += 1;
            }
        }
        if (!refused) break;
    }
    await prisma.$disconnect();
}, 120_000);

describe('Phase 4 exit gate: an accepted offer creates everything day one needs', () => {
    it('provisions the employee, terms, assignment, checklist, sessions and IT requests in one handoff', async () => {
        if (!ready) return;
        const offer = await seedOffer({ email: `p4.${Date.now()}@example.test`, category: 'EMPLOYEE' });
        seeded.offer = offer;
        const out = await asTenant(() => runOfferHandoff({ offerId: offer.id, tenantId: TENANT, actorId: seeded.recruiter.id }));
        expect(out.replayed).toBe(false);
        expect(out.handoff.status).toBe('COMPLETED');

        const { employeeId, checklistId } = out.handoff;
        const rows = await asSystem(async () => ({
            employee: await prisma.employee.findFirst({ where: { id: employeeId } }),
            terms: await prisma.employmentTerms.findMany({ where: { employeeId } }),
            assignments: await prisma.payrollAssignment.findMany({ where: { employeeId } }),
            tasks: await prisma.onboardingTask.findMany({ where: { checklistId } }),
            sessions: await prisma.onboardingSession.findMany({ where: { checklistId } }),
            requests: await prisma.onboardingProvisioningRequest.findMany({ where: { checklistId } }),
            attempts: await prisma.offerHandoffAttempt.findMany({ where: { handoffId: out.handoff.id } }),
        }));
        expect(rows.employee.employee_code).toMatch(/\d/);
        expect(rows.employee.tenant_id).toBe(TENANT);
        expect(rows.terms.length + rows.assignments.length).toBeGreaterThan(0);
        expect(rows.tasks.length).toBeGreaterThan(0);
        expect(rows.sessions.length).toBeGreaterThan(0);
        for (const session of rows.sessions) {
            expect(session.templateKey).toBeTruthy();
            expect(session.calendarSyncStatus).toBe('PENDING');
            expect(session.calendarSyncAction).toBe('CREATE');
            expect([0, 6]).not.toContain(new Date(session.sessionDate).getUTCDay());
        }
        expect(rows.requests.length).toBeGreaterThan(0);
        for (const request of rows.requests) {
            expect(request.status).toBe('REQUESTED');
            expect(request.employeeId).toBe(employeeId);
            expect(rows.tasks.map((t) => t.id)).toContain(request.taskId);
        }
        const steps = rows.attempts.map((a) => a.step);
        expect(steps).toEqual(expect.arrayContaining(['employee', 'employment_terms', 'payroll_assignment', 'onboarding_checklist', 'orientation_sessions', 'provisioning_requests']));

        expect(await outbox('hr.recruitment.handoff_completed.v1')).toHaveLength(1);
        expect(await outbox('hr.onboarding.sessions_scheduled.v1')).toHaveLength(1);
        expect(await outbox('hr.onboarding.provisioning_requested.v1')).toHaveLength(rows.requests.length);
        seeded.counts = { sessions: rows.sessions.length, requests: rows.requests.length, tasks: rows.tasks.length };
        seeded.checklistId = checklistId;
    }, 60_000);

    it('a replayed handoff changes nothing', async () => {
        if (!ready || !seeded.offer) return;
        const again = await asTenant(() => runOfferHandoff({ offerId: seeded.offer.id, tenantId: TENANT, actorId: seeded.recruiter.id }));
        expect(again.replayed).toBe(true);
        const counts = await asSystem(async () => ({
            sessions: await prisma.onboardingSession.count({ where: { checklistId: seeded.checklistId } }),
            requests: await prisma.onboardingProvisioningRequest.count({ where: { checklistId: seeded.checklistId } }),
            tasks: await prisma.onboardingTask.count({ where: { checklistId: seeded.checklistId } }),
        }));
        expect(counts).toEqual(seeded.counts);
    }, 60_000);

    it('two days before the start, the readiness check finds the open gaps and alerts once', async () => {
        if (!ready || !seeded.checklistId) return;
        const now = new Date(START.getTime() - 2 * 86_400_000 + 3 * 3_600_000);
        await runOnboardingReadinessJob({ now });
        await runOnboardingReadinessJob({ now: new Date(now.getTime() + 3_600_000) });
        const checklist = await asSystem(async () => await prisma.onboardingChecklist.findFirst({ where: { id: seeded.checklistId } }));
        expect(checklist.readinessStatus).toBe('AT_RISK');
        expect(Array.isArray(checklist.readinessGaps) && checklist.readinessGaps.length).toBeTruthy();
        expect(checklist.readinessGaps.map((g) => g.kind)).toEqual(expect.arrayContaining(['PROVISIONING']));
        expect(await outbox('hr.onboarding.readiness_at_risk.v1')).toHaveLength(1);
    }, 60_000);

    it('an induced failure records FAILED, emits handoff_failed and counts for the alert', async () => {
        if (!ready) return;
        const before = await failedCount();
        const offer = await seedOffer({ email: `p4.fail.${Date.now()}@example.test`, category: null });
        await expect(asTenant(() => runOfferHandoff({ offerId: offer.id, tenantId: TENANT, actorId: seeded.recruiter.id })))
            .rejects.toMatchObject({ code: 'HR-RECRUITMENT-HANDOFF-CATEGORY-REQUIRED' });
        const handoff = await asSystem(async () => await prisma.offerHandoff.findFirst({ where: { offerId: offer.id } }));
        expect(handoff.status).toBe('FAILED');
        // Rolled back: no employee was created for the failed hire.
        const employees = await asSystem(async () => await prisma.employee.count({ where: { tenant_id: TENANT, email: { startsWith: 'p4.fail.' } } }));
        expect(employees).toBe(0);
        expect(await outbox('hr.recruitment.handoff_failed.v1')).toHaveLength(1);
        expect(await failedCount()).toBe(before + 1);
    }, 60_000);
});
