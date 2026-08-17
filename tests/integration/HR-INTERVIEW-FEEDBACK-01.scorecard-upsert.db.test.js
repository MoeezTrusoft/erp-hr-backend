// HR-INTERVIEW-FEEDBACK-01 — "Score and feed back" must be re-submittable.
//
// Reported (live capture, /hr/interview-management → Submit Feedback):
//   hr_interview_update -> updateInterview() ->
//     Invalid `prisma.interviewScorecard.create()` invocation:
//     Unique constraint failed on the (not available)
// …for any interview that ALREADY has a scorecard, permanently blocking edits.
//
// Root cause proven here: updateInterview() looks the scorecard up with
// findUnique(interviewId_reviewerId) and creates when the lookup misses. The
// tenantScope extension injects `where.tenantId = <caller tenant>` into that
// findUnique, so a scorecard row whose tenantId is NULL (seeded / written
// before the tenant backfill) is INVISIBLE to the read — while the database's
// unique index (interviewId, reviewerId) is tenant-blind and still rejects the
// insert. Read misses, write collides.
//
// Cases:
//   1. legacy NULL-tenant scorecard  -> adopt + update (was: P2002)   [the bug]
//   2. same-tenant scorecard         -> update in place, no duplicate
//   3. no scorecard yet              -> create, stamped with the tenant
//   4. another tenant's scorecard    -> refuse loudly, never overwrite
//
// Skips when the database is unreachable so a bare checkout stays green.
// dotenv first: the prisma singleton reads DATABASE_URL at module load, and the
// jest setup does not load .env (without this every .db test silently skips).
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../src/lib/prisma.js';
import { mcpCtx } from '../../src/mcp/context.js';
import * as svc from '../../src/services/interview.service.js';
import { mcpUpdateInterview } from '../../src/mcp/controllers/recruitmentMcpController.js';

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

const asTenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId } }, fn);
const asSystem = (fn) => mcpCtx.run({ system: true }, fn);

const FEEDBACK = {
    ratings: { technical: 4, problemSolving: 0, communication: 0, cultureFit: 0 },
    decision: 'Move to next round',
    recommendation: 'Move to next round',
    comments: '',
};

let ready = false;
const made = { interviews: [], applications: [], candidates: [], requisitions: [], employees: [] };

/** Seed the FK chain an Interview needs, all under `tenantId`. */
async function seedInterview(tenantId) {
    return asSystem(async () => {
        const reviewer = await prisma.employee.create({
            data: { tenant_id: tenantId, first_name: 'Rev', last_name: 'Iewer', status: 'active' },
        });
        const requisition = await prisma.jobRequisition.create({
            data: { tenantId, title: 'HR-INTERVIEW-FEEDBACK-01 role', requestedById: reviewer.id },
        });
        const candidate = await prisma.candidate.create({
            data: {
                tenantId,
                firstName: 'Hassan',
                lastName: 'Malik',
                email: `hf01.${Date.now()}.${made.candidates.length}@example.test`,
            },
        });
        const application = await prisma.application.create({
            data: { tenantId, candidateId: candidate.id, jobRequisitionId: requisition.id },
        });
        const interview = await prisma.interview.create({
            data: {
                tenantId,
                applicationId: application.id,
                interviewType: 'TECHNICAL',
                scheduledAt: new Date(),
                status: 'SCHEDULED',
            },
        });
        made.employees.push(reviewer.id);
        made.requisitions.push(requisition.id);
        made.candidates.push(candidate.id);
        made.applications.push(application.id);
        made.interviews.push(interview.id);
        return { reviewerId: reviewer.id, interviewId: interview.id };
    });
}

// NB: await INSIDE the mcpCtx.run callback — a PrismaPromise is lazy, so
// awaiting it outside the run scope would lose the async-local tenant context.
const scorecardsOf = (interviewId) =>
    asSystem(async () => prisma.interviewScorecard.findMany({ where: { interviewId }, orderBy: { id: 'asc' } }));

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        ready = true;
    } catch {
        ready = false;
    }
});

afterAll(async () => {
    if (!ready) return;
    await asSystem(async () => {
        await prisma.interviewScorecard.deleteMany({ where: { interviewId: { in: made.interviews } } });
        await prisma.interview.deleteMany({ where: { id: { in: made.interviews } } });
        await prisma.application.deleteMany({ where: { id: { in: made.applications } } });
        await prisma.candidate.deleteMany({ where: { id: { in: made.candidates } } });
        await prisma.jobRequisition.deleteMany({ where: { id: { in: made.requisitions } } });
        await prisma.employee.deleteMany({ where: { id: { in: made.employees } } });
    });
});

describe('HR-INTERVIEW-FEEDBACK-01 — interview feedback is re-submittable', () => {
    it('adopts a legacy NULL-tenant scorecard instead of failing on the unique index', async () => {
        if (!ready) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);

        // The seeded/legacy shape: a scorecard row that predates the tenant
        // backfill. `interview_scorecards_tenantId_tenant_not_null_staged` is a
        // NOT VALID check, so production still carries rows like this while
        // blocking new ones — reproduce that by dropping and re-adding it
        // NOT VALID around the insert, exactly as the migration left it.
        await asSystem(async () => {
            await prisma.$executeRawUnsafe(
                'ALTER TABLE "interview_scorecards" DROP CONSTRAINT "interview_scorecards_tenantId_tenant_not_null_staged"',
            );
            await prisma.$executeRawUnsafe(
                `INSERT INTO "interview_scorecards" ("interviewId","reviewerId","scores","overallScore","notes","tenantId")
                 VALUES (${interviewId}, ${reviewerId}, '{"technical":2}'::jsonb, 2, 'seeded', NULL)`,
            );
            await prisma.$executeRawUnsafe(
                'ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_tenantId_tenant_not_null_staged" CHECK ("tenantId" IS NOT NULL) NOT VALID',
            );
        });

        await asTenant(TENANT_A, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].scores).toEqual(FEEDBACK.ratings);
        expect(rows[0].notes).toBeNull();          // comments '' -> null
        expect(rows[0].recommendation).toBe(FEEDBACK.recommendation);
        expect(rows[0].tenantId).toBe(TENANT_A);   // adopted, not left dangling
    });

    it('updates an existing same-tenant scorecard in place, twice, without duplicating', async () => {
        if (!ready) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);

        await asTenant(TENANT_A, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));
        await asTenant(TENANT_A, async () =>
            svc.updateInterview(
                interviewId,
                {
                    feedback: {
                        ...FEEDBACK,
                        ratings: { technical: 5, problemSolving: 5, communication: 5, cultureFit: 5 },
                        comments: 'revised',
                    },
                    reviewerId,
                },
                TENANT_A,
            ),
        );

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].overallScore).toBe(5);
        expect(rows[0].notes).toBe('revised');
    });

    it('creates the scorecard stamped with the caller tenant when none exists', async () => {
        if (!ready) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);

        await asTenant(TENANT_A, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(TENANT_A);
        expect(rows[0].overallScore).toBe(1);      // avg of 4,0,0,0
        expect(rows[0].submittedAt).toBeInstanceOf(Date);
    });

    it('survives a second submit through the hr_interview_update dispatch chain', async () => {
        if (!ready) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);
        // Exactly what the tool handler does: mcpUpdateInterview(user, id, { feedback, reviewerId }).
        const user = { userId: reviewerId, employeeId: reviewerId, tenantId: TENANT_A, isAdmin: true, roles: ['HR_ADMIN'] };

        const first = await asTenant(TENANT_A, async () =>
            mcpUpdateInterview(user, interviewId, { feedback: FEEDBACK, reviewerId }));
        const second = await asTenant(TENANT_A, async () =>
            mcpUpdateInterview(user, interviewId, {
                feedback: { ...FEEDBACK, ratings: { technical: 3, problemSolving: 3, communication: 3, cultureFit: 3 }, comments: 'second pass' },
                reviewerId,
            }));

        // runController returns the controller envelope: { success, message, data }.
        expect(first.data.scorecards).toHaveLength(1);
        expect(second.data.scorecards).toHaveLength(1);
        expect(second.data.scorecards[0].notes).toBe('second pass');
        expect(second.data.scorecards[0].overallScore).toBe(3);
        expect(second.data.scorecards[0].tenantId).toBe(TENANT_A);
    });

    it('refuses to overwrite a scorecard owned by another tenant', async () => {
        if (!ready) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);
        await asSystem(async () =>
            prisma.interviewScorecard.create({
                data: { interviewId, reviewerId, scores: { technical: 1 }, overallScore: 1, notes: 'other tenant', tenantId: TENANT_B },
            }),
        );

        await expect(
            asTenant(TENANT_A, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A)),
        ).rejects.toThrow(/another tenant/i);

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].notes).toBe('other tenant');
        expect(rows[0].tenantId).toBe(TENANT_B);
    });
});
