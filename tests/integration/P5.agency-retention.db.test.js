// Recruitment Phase 5 exit gate, against a real PostgreSQL.
//
//   1. "An agency user sees only assigned rows": two agencies in one tenant,
//      each with its own login, requisition assignment, candidate and
//      application, next to an internal candidate. Through the request hook
//      the MCP router uses (withAgencyContext), each agency login reads only
//      its own agency's applications and candidates, gets the agency
//      projection (no offer, interviews or internal requisition row), lists
//      only its assigned requisitions on the portal, and is refused the
//      tenant-wide pipeline board. A revoked login and the flag off read
//      nothing.
//   2. "Retention apply stays off until a signed-off dry-run": with the env
//      mode at apply and the retention flag on, a tenant that has not signed
//      off only ever dry-runs (the scheduled run and a direct apply both
//      refuse); after the sign-off the next run erases; disabling apply goes
//      back to dry-runs.
//
// Runs only when the database is reachable (a bare checkout stays green). Every
// row lives under throwaway tenants and is deleted afterwards.
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';

const TENANT = randomUUID();
const RETENTION_TENANT = randomUUID();
const FLAGS = {
    HR_RECRUITMENT_AGENCY_PORTAL: 'true',
    HR_RECRUITMENT_RETENTION_AUTOMATION: 'true',
};
const saved = {};
for (const [key, value] of Object.entries(FLAGS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
}

const { default: prisma } = await import('../../src/lib/prisma.js');
const { mcpCtx } = await import('../../src/mcp/context.js');
const { withAgencyContext } = await import('../../src/lib/agency-access.util.js');
const { resolveRecruitmentScope } = await import('../../src/lib/recruitmentAccess.js');
const { listApplications, getApplication } = await import('../../src/services/applicationService.js');
const { listCandidates, getCandidate } = await import('../../src/services/candidateService.js');
const { registerAgencyPortalTools } = await import('../../src/mcp/tools/agency-portal.tools.js');
const { registerCandidatePipelineTools } = await import('../../src/mcp/tools/candidatePipelineTools.js');
const { applyRetention } = await import('../../src/services/candidatePrivacy.service.js');
const { runTenantRetention, signOffRetentionRun, disableRetentionApply } = await import('../../src/services/retention-run.service.js');

const asSystem = (fn) => mcpCtx.run({ system: true }, async () => await fn());

const handlers = new Map();
const server = { tool: (name, _d, _s, handler) => handlers.set(name, handler) };
registerAgencyPortalTools(server);
registerCandidatePipelineTools(server);

const AGENCY_PERMS = { 'hr:recruitment_agency': ['VIEW', 'CREATE'], 'hr:recruitment': ['VIEW'] };
const agencyUser = (userId) => ({ userId, roles: ['AGENCY'], employeeId: null, tenantId: TENANT, isAdmin: false });

// The router's path: attach the membership, then run under that context.
async function asAgency(user, fn) {
    const ctx = await withAgencyContext({ user, permissions: AGENCY_PERMS });
    return mcpCtx.run(ctx, async () => await fn(ctx.user, resolveRecruitmentScope(ctx.user)));
}
async function callTool(user, name, args = {}) {
    const ctx = await withAgencyContext({ user, permissions: AGENCY_PERMS });
    const res = await mcpCtx.run(ctx, async () => await handlers.get(name)(args));
    return { isError: Boolean(res.isError), body: JSON.parse(res.content[0].text) };
}

const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);

let ready = false;
const W = {};

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1 FROM recruitment_agencies LIMIT 1`;
        await prisma.$queryRaw`SELECT 1 FROM candidate_retention_runs LIMIT 1`;
        ready = true;
    } catch {
        ready = false;
        return;
    }
    const code = () => `T-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    await asSystem(async () => {
        W.recruiter = await prisma.employee.create({
            data: { tenant_id: TENANT, first_name: 'Rec', last_name: 'Ruiter', status: 'active', employeeCategory: 'EMPLOYEE', employee_code: code() },
        });
        const req = (title) =>
            prisma.jobRequisition.create({ data: { tenantId: TENANT, title, requestedById: W.recruiter.id, status: 'POSTED' } });
        W.r1 = await req('P5 agency role one');
        W.r2 = await req('P5 agency role two');
        W.a1 = await prisma.recruitmentAgency.create({ data: { tenantId: TENANT, name: 'Agency One' } });
        W.a2 = await prisma.recruitmentAgency.create({ data: { tenantId: TENANT, name: 'Agency Two' } });
        await prisma.recruitmentAgencyUser.createMany({
            data: [
                { tenantId: TENANT, agencyId: W.a1.id, userId: 'p5-agency-one' },
                { tenantId: TENANT, agencyId: W.a2.id, userId: 'p5-agency-two' },
                { tenantId: TENANT, agencyId: W.a1.id, userId: 'p5-agency-revoked', status: 'REVOKED' },
            ],
        });
        await prisma.requisitionAgencyAssignment.createMany({
            data: [
                { tenantId: TENANT, requisitionId: W.r1.id, agencyId: W.a1.id },
                { tenantId: TENANT, requisitionId: W.r2.id, agencyId: W.a2.id },
            ],
        });
        const candidate = (firstName, ownerAgencyId) =>
            prisma.candidate.create({
                data: { tenantId: TENANT, firstName, lastName: 'Test', email: `p5.${firstName.toLowerCase()}.${Date.now()}@example.test`, ownerAgencyId },
            });
        W.c1 = await candidate('Owned', W.a1.id);
        W.c2 = await candidate('Other', W.a2.id);
        W.cInternal = await candidate('Internal', null);
        const application = (candidateId, jobRequisitionId, ownerAgencyId) =>
            prisma.application.create({ data: { tenantId: TENANT, candidateId, jobRequisitionId, stage: 'screening', ownerAgencyId } });
        W.app1 = await application(W.c1.id, W.r1.id, W.a1.id);
        W.app2 = await application(W.c2.id, W.r2.id, W.a2.id);
        W.appInternal = await application(W.cInternal.id, W.r1.id, null);

        W.owner = await prisma.employee.create({
            data: { tenant_id: RETENTION_TENANT, first_name: 'Data', last_name: 'Owner', status: 'active', employeeCategory: 'EMPLOYEE', employee_code: code() },
        });
        W.due = await prisma.candidate.create({
            data: {
                tenantId: RETENTION_TENANT,
                firstName: 'Expired',
                lastName: 'Applicant',
                email: `p5.retention.${Date.now()}@example.test`,
                retentionUntil: new Date(Date.now() - 30 * 86_400_000),
                retentionPopulation: 'APPLICANT',
            },
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
    // Delete every row of the throwaway tenants: each table with a tenant
    // column, repeated until the foreign keys stop refusing.
    const tables = await prisma.$queryRaw`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tenantId', 'tenant_id')`;
    for (const tenant of [TENANT, RETENTION_TENANT]) {
        for (let pass = 0; pass < 6; pass++) {
            let refused = 0;
            for (const { table_name: table, column_name: column } of tables) {
                try {
                    await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}"::text = $1`, tenant);
                } catch {
                    refused += 1;
                }
            }
            if (!refused) break;
        }
    }
    await prisma.$disconnect();
}, 120_000);

describe('Phase 5 exit gate: an agency user sees only its own rows', () => {
    it('each agency login reads only its agency\'s applications and candidates', async () => {
        if (!ready) return;
        for (const [userId, own, other] of [
            ['p5-agency-one', { app: W.app1, cand: W.c1 }, { app: W.app2, cand: W.c2 }],
            ['p5-agency-two', { app: W.app2, cand: W.c2 }, { app: W.app1, cand: W.c1 }],
        ]) {
            const seen = await asAgency(agencyUser(userId), async (user, scope) => ({
                scope,
                apps: await listApplications({ tenantId: TENANT, scope, limit: 100 }),
                cands: await listCandidates({ tenantId: TENANT, scope, limit: 100 }),
                ownApp: await getApplication({ id: own.app.id, tenantId: TENANT, scope }),
                otherApp: await getApplication({ id: other.app.id, tenantId: TENANT, scope }),
                internalApp: await getApplication({ id: W.appInternal.id, tenantId: TENANT, scope }),
                ownCand: await getCandidate({ id: own.cand.id, tenantId: TENANT, scope }),
                otherCand: await getCandidate({ id: other.cand.id, tenantId: TENANT, scope }),
            }));
            expect(seen.scope.level).toBe('AGENCY');
            expect(ids(seen.apps.items)).toEqual([own.app.id]);
            expect(seen.apps.total).toBe(1);
            const candItems = seen.cands.items ?? seen.cands.data ?? seen.cands;
            expect(ids(candItems)).toEqual([own.cand.id]);
            expect(seen.ownApp?.id).toBe(own.app.id);
            // The agency projection: none of the internal siblings ride along.
            for (const key of ['offer', 'interviews', 'score', 'answers']) expect(seen.ownApp[key]).toBeUndefined();
            for (const key of ['budgetedAmount', 'approvalChainSnapshot', 'requestedById']) {
                expect(seen.ownApp.jobRequisition?.[key]).toBeUndefined();
            }
            expect(seen.otherApp).toBeNull();
            expect(seen.internalApp).toBeNull();
            expect(seen.ownCand?.id).toBe(own.cand.id);
            expect(seen.otherCand).toBeNull();
        }
    }, 60_000);

    it('the portal lists only the assigned requisition, and the tenant-wide board is refused', async () => {
        if (!ready) return;
        const portal = await callTool(agencyUser('p5-agency-one'), 'hr_recruitment_agency_portal_requisitions_list');
        expect(portal.isError).toBe(false);
        const rows = portal.body.items ?? portal.body.data ?? portal.body;
        expect(rows.map((r) => Number(r.id))).toEqual([W.r1.id]);
        expect(rows[0].budgetedAmount).toBeUndefined();

        const board = await callTool(agencyUser('p5-agency-one'), 'hr_candidate_pipeline_get');
        expect(board.isError).toBe(true);
        expect(JSON.stringify(board.body)).toContain('HR-RECRUITMENT-AGENCY-SCOPE-FORBIDDEN');
    }, 60_000);

    it('a revoked login, and any login with the flag off, reads nothing', async () => {
        if (!ready) return;
        const revoked = await asAgency(agencyUser('p5-agency-revoked'), async (_user, scope) =>
            await listApplications({ tenantId: TENANT, scope, limit: 100 }));
        expect(revoked.items).toEqual([]);

        process.env.HR_RECRUITMENT_AGENCY_PORTAL = 'false';
        try {
            const off = await asAgency(agencyUser('p5-agency-one'), async (_user, scope) => ({
                apps: await listApplications({ tenantId: TENANT, scope, limit: 100 }),
                app: await getApplication({ id: W.app1.id, tenantId: TENANT, scope }),
            }));
            expect(off.apps.items).toEqual([]);
            expect(off.app).toBeNull();
        } finally {
            process.env.HR_RECRUITMENT_AGENCY_PORTAL = 'true';
        }
    }, 60_000);
});

describe('Phase 6 decision: an unrecognised role sees no recruitment rows', () => {
    it('an unknown role claim, and a manager claim without an employee id, read nothing', async () => {
        if (!ready) return;
        for (const user of [
            { userId: 'p6-unknown', roles: ['SOMETHING_NEW'], employeeId: null, tenantId: TENANT, isAdmin: false },
            { userId: 'p6-manager', roles: ['HIRING_MANAGER'], employeeId: null, tenantId: TENANT, isAdmin: false },
        ]) {
            const scope = resolveRecruitmentScope(user);
            expect(scope.level).toBe('NONE');
            const seen = await mcpCtx.run({ user, permissions: AGENCY_PERMS }, async () => ({
                apps: await listApplications({ tenantId: TENANT, scope, limit: 100 }),
                app: await getApplication({ id: W.appInternal.id, tenantId: TENANT, scope }),
                cands: await listCandidates({ tenantId: TENANT, scope, limit: 100 }),
                cand: await getCandidate({ id: W.cInternal.id, tenantId: TENANT, scope }),
            }));
            expect(seen.apps.items).toEqual([]);
            expect(seen.app).toBeNull();
            expect(seen.cands.items ?? seen.cands.data ?? seen.cands).toEqual([]);
            expect(seen.cand).toBeNull();
        }
    }, 60_000);
});

describe('Phase 5 exit gate: retention apply stays off until a signed-off dry-run', () => {
    const admin = () => ({ employeeId: W.owner.id, roles: ['HR_ADMIN'], isAdmin: true, tenantId: RETENTION_TENANT });
    const ORG = resolveRecruitmentScope({ roles: ['HR_ADMIN'] });
    const asRetentionTenant = (fn) =>
        mcpCtx.run({ user: { tenantId: RETENTION_TENANT, employeeId: W.owner.id } }, async () => await fn());
    const dueCandidate = () => asSystem(async () => await prisma.candidate.findFirst({ where: { id: W.due.id } }));

    it('dry-runs only, by schedule and by direct apply, before the sign-off', async () => {
        if (!ready) return;
        const { run } = await asRetentionTenant(() => runTenantRetention({ tenantId: RETENTION_TENANT, envMode: 'apply', asOf: new Date() }));
        expect(run.mode).toBe('DRY_RUN');
        expect(run.status).toBe('COMPLETED');
        expect(run.wouldAnonymize).toBeGreaterThanOrEqual(1);
        expect(run.anonymized).toBe(0);
        W.dryRun = run;

        const direct = await asRetentionTenant(() => applyRetention({ tenantId: RETENTION_TENANT, dryRun: false }));
        expect(direct).toMatchObject({ dryRun: true, refused: true, reason: 'tenant-not-signed-off' });
        expect((await dueCandidate()).anonymizedAt).toBeNull();
    }, 60_000);

    it('erases after the sign-off, and dry-runs again once apply is disabled', async () => {
        if (!ready || !W.dryRun) return;
        const signed = await asRetentionTenant(() =>
            signOffRetentionRun({ tenantId: RETENTION_TENANT, user: admin(), scope: ORG, runId: W.dryRun.id }));
        expect(signed.retention.retentionApplyEnabled).toBe(true);

        const { run } = await asRetentionTenant(() => runTenantRetention({ tenantId: RETENTION_TENANT, envMode: 'apply', asOf: new Date() }));
        expect(run.mode).toBe('APPLY');
        expect(run.anonymized).toBeGreaterThanOrEqual(1);
        expect((await dueCandidate()).anonymizedAt).toBeInstanceOf(Date);

        await asRetentionTenant(() => disableRetentionApply({ tenantId: RETENTION_TENANT, user: admin(), scope: ORG, reason: 'exit gate' }));
        const after = await asRetentionTenant(() => runTenantRetention({ tenantId: RETENTION_TENANT, envMode: 'apply', asOf: new Date() }));
        expect(after.run.mode).toBe('DRY_RUN');
    }, 60_000);
});
