// Recruitment Phase 6 exit gate, against a real PostgreSQL.
//
// "A candidate answers an invitation from the emailed link, once":
//   1. issuing the link stores only the token's hash and its expiry on the
//      invitation (the raw token is only in the returned URL);
//   2. the candidate's view of a live link shows the role title and nothing
//      else; a malformed, unknown or expired token reads as no link;
//   3. accepting through the link records ACCEPTED with respondedVia
//      CANDIDATE_LINK and clears the token, and the same link is then dead;
//   4. a second invitation declined through its link records DECLINED.
//
// Runs only when the database is reachable (a bare checkout stays green). Every
// row lives under a throwaway tenant and is deleted afterwards.
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';

const TENANT = randomUUID();
const FLAGS = {
    HR_RECRUITMENT_INVITATION_LINKS: 'true',
    HR_PORTAL_BASE_URL: 'https://careers.example.test',
};
const saved = {};
for (const [key, value] of Object.entries(FLAGS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
}

const { default: prisma } = await import('../../src/lib/prisma.js');
const { mcpCtx } = await import('../../src/mcp/context.js');
const {
    issueInvitationResponseLink,
    getInvitationForCandidate,
    respondViaInvitationLink,
    hashInvitationToken,
} = await import('../../src/services/invitation-response.service.js');

const asSystem = (fn) => mcpCtx.run({ system: true }, async () => await fn());
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT, employeeId: null } }, async () => await fn());
const tokenOf = (url) => new URL(url).searchParams.get('token');

let ready = false;
const W = {};

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT "responseTokenHash" FROM talent_pool_invitations LIMIT 1`;
        ready = true;
    } catch {
        ready = false;
        return;
    }
    await asSystem(async () => {
        W.recruiter = await prisma.employee.create({
            data: {
                tenant_id: TENANT,
                first_name: 'Rec',
                last_name: 'Ruiter',
                status: 'active',
                employeeCategory: 'EMPLOYEE',
                employee_code: `T-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
            },
        });
        W.requisition = await prisma.jobRequisition.create({
            data: { tenantId: TENANT, title: 'P6 invitation role', requestedById: W.recruiter.id },
        });
        const invite = async (firstName, jobRequisitionId) => {
            const candidate = await prisma.candidate.create({
                data: { tenantId: TENANT, firstName, lastName: 'Pool', email: `p6.${firstName.toLowerCase()}.${Date.now()}@example.test` },
            });
            return prisma.talentPoolInvitation.create({
                data: {
                    tenantId: TENANT,
                    candidateId: candidate.id,
                    jobRequisitionId,
                    status: 'INVITED',
                    invitedById: W.recruiter.id,
                    expiresAt: new Date(Date.now() + 10 * 86_400_000),
                },
            });
        };
        // A general "keep in touch" invitation (no role) and a role invitation.
        W.general = await invite('Accepting', null);
        W.role = await invite('Declining', W.requisition.id);
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

const row = (id) => asSystem(async () => await prisma.talentPoolInvitation.findFirst({ where: { id } }));

describe('Phase 6 exit gate: a candidate answers an invitation from the emailed link, once', () => {
    it('stores only the hash and expiry, and shows the live link with nothing but the role', async () => {
        if (!ready) return;
        const link = await asTenant(() => issueInvitationResponseLink({ tenantId: TENANT, invitationId: W.general.id }));
        expect(link.ok).toBe(true);
        expect(link.url.startsWith('https://careers.example.test/invitations/respond?token=')).toBe(true);
        const token = tokenOf(link.url);
        const stored = await row(W.general.id);
        expect(stored.responseTokenHash).toBe(hashInvitationToken(token));
        expect(stored.responseTokenHash).not.toContain(token);
        expect(stored.responseTokenExpiresAt).toBeInstanceOf(Date);
        W.generalToken = token;

        const view = await asTenant(() => getInvitationForCandidate({ tenantId: TENANT, token }));
        expect(Object.keys(view).sort()).toEqual(['expiresAt', 'jobTitle']);
        expect(view.jobTitle).toBeNull();
        expect(await asTenant(() => getInvitationForCandidate({ tenantId: TENANT, token: 'not-a-token' }))).toBeNull();
        expect(await asTenant(() => getInvitationForCandidate({ tenantId: TENANT, token: token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) }))).toBeNull();
        const later = new Date(stored.responseTokenExpiresAt.getTime() + 60_000);
        expect(await asTenant(() => getInvitationForCandidate({ tenantId: TENANT, token, now: later }))).toBeNull();
    }, 60_000);

    it('accepts once through the link: ACCEPTED, CANDIDATE_LINK, token cleared, then a dead link', async () => {
        if (!ready || !W.generalToken) return;
        const out = await asTenant(() => respondViaInvitationLink({ tenantId: TENANT, token: W.generalToken, body: { answer: 'ACCEPT' } }));
        expect(out).toMatchObject({ answer: 'ACCEPTED' });
        const stored = await row(W.general.id);
        expect(stored).toMatchObject({ status: 'ACCEPTED', respondedVia: 'CANDIDATE_LINK', responseTokenHash: null, responseTokenExpiresAt: null });
        expect(stored.respondedAt).toBeInstanceOf(Date);
        expect(await asTenant(() => respondViaInvitationLink({ tenantId: TENANT, token: W.generalToken, body: { answer: 'DECLINE' } }))).toBeNull();
        expect((await row(W.general.id)).status).toBe('ACCEPTED');
    }, 60_000);

    it('declines a role invitation through its own link', async () => {
        if (!ready) return;
        const link = await asTenant(() => issueInvitationResponseLink({ tenantId: TENANT, invitationId: W.role.id }));
        const view = await asTenant(() => getInvitationForCandidate({ tenantId: TENANT, token: tokenOf(link.url) }));
        expect(view.jobTitle).toBe('P6 invitation role');
        const out = await asTenant(() => respondViaInvitationLink({ tenantId: TENANT, token: tokenOf(link.url), body: { answer: 'DECLINE', note: 'Not now <b>thanks</b>' } }));
        expect(out).toMatchObject({ answer: 'DECLINED', applicationReceived: false });
        const stored = await row(W.role.id);
        expect(stored).toMatchObject({ status: 'DECLINED', respondedVia: 'CANDIDATE_LINK', responseTokenHash: null });
        expect(stored.responseNote).toBe('Not now thanks');
    }, 60_000);
});
