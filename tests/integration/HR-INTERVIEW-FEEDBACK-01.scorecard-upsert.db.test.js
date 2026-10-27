import { randomUUID } from "node:crypto";
import pg from "pg";
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
import { tenantTransaction } from '../../src/lib/rlsTenant.js';
import { mcpCtx } from '../../src/mcp/context.js';
import * as svc from '../../src/services/interview.service.js';
import { mcpUpdateInterview } from '../../src/mcp/controllers/recruitmentMcpController.js';

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

const asTenant = (tenantId, reviewerId, fn) => mcpCtx.run({
    actorVerified: true,
    permissions: ["hr.recruitment.read", "hr.recruitment.update"],
    user: { tenantId, userId: reviewerId, employeeId: reviewerId, roles: ["HR_ADMIN"] },
}, fn);
const asSystem = (fn) => mcpCtx.run({ system: true }, fn);

const FEEDBACK = {
    ratings: { technical: 4, problemSolving: 1, communication: 1, cultureFit: 1 },
    decision: 'Move to next round',
    recommendation: 'Move to next round',
    comments: '',
};

let ready = false;
// Phase 3.4 — the lock writes `amendmentLog` / `lastAmendedAt`. Those ship in
// migration 20260920200000_recruitment_scorecard_amendment_log; until it has been
// applied to THIS database the client knows the columns but Postgres does not, so
// the lock cases are skipped the same way the whole suite skips an unreachable DB
// (rather than failing on a schema the migration has not reached yet).
let lockColumnsReady = false;
const made = { interviews: [], applications: [], candidates: [], requisitions: [], employees: [] };

/** Seed the FK chain an Interview needs, all under `tenantId`. */
async function seedInterview(tenantId) {
    return asSystem(async () => {
        const reviewer = await prisma.employee.create({
            data: { employee_code: randomUUID().toUpperCase(), employeeCategory: "EMPLOYEE", tenant_id: tenantId, first_name: 'Rev', last_name: 'Iewer', status: 'active' },
        });
        await prisma.employee.update({ where: { id: reviewer.id }, data: { userId: reviewer.id } });
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
                interviewers: { create: { tenantId, employeeId: reviewer.id } },
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
        const cols = await prisma.$queryRaw`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'interview_scorecards'
              AND column_name IN ('amendmentLog', 'lastAmendedAt')`;
        lockColumnsReady = Array.isArray(cols) && cols.length === 2;
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
        // Only fixture DDL uses the isolated owner connection. The application client,
        // service call and all assertions continue to use the restricted DATABASE_URL.
        if (!process.env.HR_TEST_FIXTURE_ADMIN_URL) throw new Error('Legacy scorecard fixture requires HR_TEST_FIXTURE_ADMIN_URL');
        const fixtureOwner = new pg.Client({ connectionString: process.env.HR_TEST_FIXTURE_ADMIN_URL });
        await fixtureOwner.connect();
        try {
            await fixtureOwner.query('BEGIN');
            await fixtureOwner.query('ALTER TABLE "interview_scorecards" DROP CONSTRAINT "interview_scorecards_tenantId_tenant_not_null_staged"');
            await fixtureOwner.query(
                'INSERT INTO "interview_scorecards" ("interviewId","reviewerId","scores","overallScore","notes","tenantId") VALUES ($1,$2,$3::jsonb,2,$4,NULL)',
                [interviewId, reviewerId, JSON.stringify({ technical: 2 }), 'seeded'],
            );
            await fixtureOwner.query('ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_tenantId_tenant_not_null_staged" CHECK ("tenantId" IS NOT NULL) NOT VALID');
            await fixtureOwner.query('COMMIT');
        } catch (error) {
            await fixtureOwner.query('ROLLBACK');
            throw error;
        } finally {
            await fixtureOwner.end();
        }

        // A foreign company cannot read or claim the unowned legacy row.
        await asTenant(TENANT_B, reviewerId, () => tenantTransaction(prisma, async (tx) => {
            expect(await tx.$queryRawUnsafe('SELECT id FROM interview_scorecards WHERE "interviewId"=$1', interviewId)).toEqual([]);
            expect(await tx.$executeRawUnsafe('UPDATE interview_scorecards SET "tenantId"=$1::uuid WHERE "interviewId"=$2', TENANT_B, interviewId)).toBe(0);
        }, { tenantId: TENANT_B }));
        await asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].scores).toEqual(FEEDBACK.ratings);
        expect(rows[0].notes).toBeNull();          // comments '' -> null
        expect(rows[0].recommendation).toBe(FEEDBACK.recommendation);
        expect(rows[0].tenantId).toBe(TENANT_A);   // adopted, not left dangling
    });

    it('never duplicates the row when the same feedback is submitted twice', async () => {
        if (!ready || !lockColumnsReady) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);

        await asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));
        // Phase 3.4 — identical resubmit: a no-op, not an error (retry/double-click).
        await asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].overallScore).toBe(1.75);
        expect(rows[0].lastAmendedAt).toBeNull();
    });

    it('REFUSES to change a submitted scorecard without an amendment reason', async () => {
        if (!ready) return;
        // The refusal happens before any column write, so this case is meaningful
        // even before the amendment-log migration is applied.
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);

        await asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));

        await expect(
            asTenant(TENANT_A, reviewerId, async () =>
                svc.updateInterview(
                    interviewId,
                    {
                        feedback: { ...FEEDBACK, ratings: { technical: 5, problemSolving: 5, communication: 5, cultureFit: 5 }, comments: 'revised' },
                        reviewerId,
                    },
                    TENANT_A,
                ),
            ),
        ).rejects.toMatchObject({ code: 'HR-6102', status: 409 });

        // The evidence on record is untouched by the refused attempt.
        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].overallScore).toBe(1.75);
        expect(rows[0].notes).toBeNull();
    });

    it('applies a changed scorecard through the amendment path and keeps the trail', async () => {
        if (!ready || !lockColumnsReady) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);

        await asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));
        await asTenant(TENANT_A, reviewerId, async () =>
            svc.updateInterview(
                interviewId,
                {
                    feedback: { ...FEEDBACK, ratings: { technical: 5, problemSolving: 5, communication: 5, cultureFit: 5 }, comments: 'revised' },
                    reviewerId,
                    amendmentReason: 'Debrief changed the panel consensus',
                },
                TENANT_A,
            ),
        );

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].overallScore).toBe(5);
        expect(rows[0].notes).toBe('revised');
        expect(rows[0].lastAmendedAt).toBeInstanceOf(Date);
        // submittedAt is the ORIGINAL evidence timestamp and must survive.
        expect(rows[0].submittedAt).toBeInstanceOf(Date);
        const log = rows[0].amendmentLog;
        expect(Array.isArray(log)).toBe(true);
        expect(log).toHaveLength(1);
        expect(log[0].reason).toBe('Debrief changed the panel consensus');
        expect(log[0].replaced).toMatchObject({ overallScore: 1.75, scores: { technical: 4 } });
    });

    it('creates the scorecard stamped with the caller tenant when none exists', async () => {
        if (!ready) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);

        await asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A));

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(TENANT_A);
        expect(rows[0].overallScore).toBe(1.75);      // avg of 4,1,1,1
        expect(rows[0].submittedAt).toBeInstanceOf(Date);
    });

    it('survives a resubmit through the hr_interview_update dispatch chain, and locks afterwards', async () => {
        if (!ready || !lockColumnsReady) return;
        const { interviewId, reviewerId } = await seedInterview(TENANT_A);
        // Exactly what the tool handler does: mcpUpdateInterview(user, id, { feedback, reviewerId }).
        const user = { userId: reviewerId, employeeId: reviewerId, tenantId: TENANT_A, isAdmin: true, roles: ['HR_ADMIN'] };

        const first = await asTenant(TENANT_A, reviewerId, async () =>
            mcpUpdateInterview(user, interviewId, { feedback: FEEDBACK, reviewerId }));
        // Identical payload through the chain: no duplicate, no lock error.
        const second = await asTenant(TENANT_A, reviewerId, async () =>
            mcpUpdateInterview(user, interviewId, { feedback: FEEDBACK, reviewerId }));

        // runController returns the controller envelope: { success, message, data }.
        expect(first.data.scorecards).toHaveLength(1);
        expect(second.data.scorecards).toHaveLength(1);
        expect(second.data.scorecards[0].tenantId).toBe(TENANT_A);

        // A changed payload through the same chain is refused…
        await expect(
            asTenant(TENANT_A, reviewerId, async () =>
                mcpUpdateInterview(user, interviewId, {
                    feedback: { ...FEEDBACK, ratings: { technical: 3, problemSolving: 3, communication: 3, cultureFit: 3 }, comments: 'second pass' },
                    reviewerId,
                })),
        ).rejects.toMatchObject({ code: 'HR-6102' });

        // …and passes with the amendment reason the tool now declares.
        const amended = await asTenant(TENANT_A, reviewerId, async () =>
            mcpUpdateInterview(user, interviewId, {
                feedback: { ...FEEDBACK, ratings: { technical: 3, problemSolving: 3, communication: 3, cultureFit: 3 }, comments: 'second pass' },
                reviewerId,
                amendmentReason: 'Corrected after the calibration session',
            }));

        expect(amended.data.scorecards).toHaveLength(1);
        expect(amended.data.scorecards[0].notes).toBe('second pass');
        expect(amended.data.scorecards[0].overallScore).toBe(3);
        expect(amended.data.scorecards[0].tenantId).toBe(TENANT_A);
    });

    it('refuses to file feedback when the caller has no reviewer identity', async () => {
        if (!ready) return;
        const { interviewId } = await seedInterview(TENANT_A);
        const reviewerId = null;

        // Previously `Number(reviewerId || 1)` silently attributed the scorecard
        // to employee id 1 whenever the token carried no employeeId.
        await expect(
            asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK }, TENANT_A)),
        ).rejects.toThrow(/linked employee account is required/i);

        expect(await scorecardsOf(interviewId)).toHaveLength(0);
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
            asTenant(TENANT_A, reviewerId, async () => svc.updateInterview(interviewId, { feedback: FEEDBACK, reviewerId }, TENANT_A)),
        ).rejects.toThrow(/another tenant/i);

        const rows = await scorecardsOf(interviewId);
        expect(rows).toHaveLength(1);
        expect(rows[0].notes).toBe('other tenant');
        expect(rows[0].tenantId).toBe(TENANT_B);
    });
});
