// Recruitment Phase 6 — the talent pool invitation link: minting at send time
// (only the hash and its expiry are stored), the candidate's read and answer
// through the SAME respondToInvitation path the recruiter uses (respondedVia,
// single-use claim, nurture intake), uniform nulls for every dead link, and
// the token cleared on every terminal status.
import { createHash } from "node:crypto";
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createInvitationLinksDb } from "./helpers/invitation-links.fake.js";

const { db, state } = createInvitationLinksDb();
const flags = new Set();
const getRecruitmentSettings = jest.fn();
const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));
const intakeAcceptedNurtureInvitation = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/recruitment-flags.util.js", () => ({ isRecruitmentFlagEnabled: (key) => flags.has(key) }));
jest.unstable_mockModule("../../../src/lib/recruitment-ops-metrics.util.js", () => ({ recordRetentionRun: jest.fn() }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/services/talent-nurture.service.js", () => ({ intakeAcceptedNurtureInvitation }));

const svc = await import("../../../src/services/invitation-response.service.js");
const { respondToInvitation, withdrawInvitation, expireInvitations, listInvitations, inviteToApply } = await import("../../../src/services/talent-pool-invitation.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T09:00:00.000Z");
const DAY = 86_400_000;
const sha = (t) => createHash("sha256").update(t).digest("hex");
const asTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const asPortal = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId }, portal: true }, async () => await fn());
const invitation = (id) => state.invitations.find((i) => i.id === id);
const tokenOf = (link) => new URL(link.url).searchParams.get("token");

function seed() {
    for (const key of Object.keys(state)) state[key] = [];
    state.candidates.push(
        { id: 5, tenantId: TENANT, firstName: "Ayesha", email: "ayesha@example.com", anonymizedAt: null },
        { id: 6, tenantId: OTHER, firstName: "Eve", email: "eve@example.com", anonymizedAt: null },
    );
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer", status: "POSTED" });
    state.invitations.push(
        // A nurture invitation for a role.
        { id: 700, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, status: "INVITED", invitedAt: NOW, expiresAt: new Date(NOW.getTime() + 14 * DAY), nurtureRunId: 3, responseNote: null, responseTokenHash: null, responseTokenExpiresAt: null, respondedVia: null },
        // A general "keep in touch" invitation with no expiry.
        { id: 701, tenantId: TENANT, candidateId: 5, jobRequisitionId: null, status: "INVITED", invitedAt: NOW, expiresAt: null, nurtureRunId: null, responseNote: null, responseTokenHash: null, responseTokenExpiresAt: null, respondedVia: null },
        { id: 702, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, status: "DECLINED", invitedAt: NOW, expiresAt: null, responseTokenHash: null, responseTokenExpiresAt: null },
        { id: 800, tenantId: OTHER, candidateId: 6, jobRequisitionId: null, status: "INVITED", invitedAt: NOW, expiresAt: null, responseTokenHash: null, responseTokenExpiresAt: null },
    );
}

const issue = (invitationId, opts = {}) => asTenant(() => svc.issueInvitationResponseLink({ tenantId: TENANT, invitationId, now: NOW, ...opts }));
const read = (token, opts = {}) => asPortal(() => svc.getInvitationForCandidate({ tenantId: TENANT, token, now: NOW, ...opts }), opts.tenantId ?? TENANT);
const answer = (token, body, opts = {}) => asPortal(() => svc.respondViaInvitationLink({ tenantId: TENANT, token, body, now: NOW, ...opts }), opts.tenantId ?? TENANT);

beforeEach(() => {
    seed();
    db.contextLog.length = 0;
    jest.clearAllMocks();
    flags.clear();
    flags.add("invitationLinks");
    getRecruitmentSettings.mockResolvedValue({ portalBaseUrl: "https://careers.acme.test/", companyName: "Acme" });
    intakeAcceptedNurtureInvitation.mockResolvedValue({ applicationId: 901, created: true, preScreened: true });
});

describe("issueInvitationResponseLink", () => {
    it("stores only the token's hash, with the invitation's own expiry", async () => {
        const link = await issue(700);
        expect(link.ok).toBe(true);
        expect(link.url).toMatch(/^https:\/\/careers\.acme\.test\/invitations\/respond\?token=[A-Za-z0-9_-]{43}$/);
        const token = tokenOf(link);
        const row = invitation(700);
        expect(row.responseTokenHash).toBe(sha(token));
        expect(link.tokenHash).toBe(sha(token));
        expect(row.responseTokenExpiresAt).toEqual(new Date(NOW.getTime() + 14 * DAY));
        expect(JSON.stringify(state)).not.toContain(token);
        expect(db.contextLog.every((q) => q.tenantId === TENANT && !q.system)).toBe(true);
    });

    it("an invitation with no expiry gets a 30-day link", async () => {
        await issue(701);
        expect(invitation(701).responseTokenExpiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    });

    it("a second send mints a new link and the first one stops working", async () => {
        const first = tokenOf(await issue(700));
        const second = tokenOf(await issue(700));
        expect(second).not.toBe(first);
        await expect(read(first)).resolves.toBeNull();
        await expect(read(second)).resolves.toMatchObject({ jobTitle: "Backend Engineer" });
    });

    it("refuses an answered, other-tenant or lapsed invitation and writes nothing", async () => {
        await expect(issue(702)).resolves.toEqual({ ok: false, reason: "INVITATION_CLOSED" });
        await expect(issue(800)).resolves.toEqual({ ok: false, reason: "INVITATION_CLOSED" });
        await expect(issue(700, { now: new Date(NOW.getTime() + 15 * DAY) })).resolves.toEqual({ ok: false, reason: "INVITATION_CLOSED" });
        expect(invitation(700).responseTokenHash).toBeNull();
        expect(invitation(800).responseTokenHash).toBeNull();
    });

    it("flag off and a missing portal address mint nothing (the latter is retryable)", async () => {
        const saved = process.env.HR_PORTAL_BASE_URL;
        delete process.env.HR_PORTAL_BASE_URL;
        getRecruitmentSettings.mockResolvedValue({ portalBaseUrl: null });
        await expect(issue(700)).resolves.toEqual({ ok: false, reason: "NO_PORTAL_URL", retry: true });
        flags.delete("invitationLinks");
        await expect(issue(700)).resolves.toEqual({ ok: false, reason: "INVITATION_LINKS_DISABLED" });
        expect(invitation(700).responseTokenHash).toBeNull();
        if (saved !== undefined) process.env.HR_PORTAL_BASE_URL = saved;
    });
});

describe("getInvitationForCandidate", () => {
    it("shows the role title and the link's expiry only", async () => {
        const token = tokenOf(await issue(700));
        const view = await read(token);
        expect(view).toEqual({ jobTitle: "Backend Engineer", expiresAt: new Date(NOW.getTime() + 14 * DAY).toISOString() });
        // A general invitation has no role title.
        const general = tokenOf(await issue(701));
        await expect(read(general)).resolves.toMatchObject({ jobTitle: null });
    });

    it("is the same null for malformed, unknown, other-tenant, expired and erased", async () => {
        const token = tokenOf(await issue(700));
        await expect(read("short")).resolves.toBeNull();
        await expect(read(undefined)).resolves.toBeNull();
        await expect(read("A".repeat(43))).resolves.toBeNull();
        await expect(read(token, { tenantId: OTHER })).resolves.toBeNull();
        await expect(read(token, { now: new Date(NOW.getTime() + 15 * DAY) })).resolves.toBeNull();
        state.candidates[0].anonymizedAt = NOW;
        await expect(read(token)).resolves.toBeNull();
    });

    it("answers 503 HR-RECRUITMENT-INVITATION-LINKS-DISABLED with the flag off", async () => {
        flags.delete("invitationLinks");
        await expect(read("A".repeat(43))).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-INVITATION-LINKS-DISABLED" });
    });
});

describe("respondViaInvitationLink", () => {
    it("declines through the recruiter's path with respondedVia CANDIDATE_LINK, once", async () => {
        const token = tokenOf(await issue(701));
        await expect(answer(token, { answer: "decline", note: "<b>Not</b> now" })).resolves.toEqual({ answer: "DECLINED", applicationReceived: false });
        const row = invitation(701);
        expect(row).toMatchObject({ status: "DECLINED", respondedVia: "CANDIDATE_LINK", responseNote: "Not now", responseTokenHash: null, responseTokenExpiresAt: null });
        // Used: the same null as any dead link.
        await expect(answer(token, { answer: "ACCEPT" })).resolves.toBeNull();
        await expect(read(token)).resolves.toBeNull();
    });

    it("accepting a nurture invitation creates the application as the recruiter path does", async () => {
        flags.add("talentNurture");
        const token = tokenOf(await issue(700));
        await expect(answer(token, { answer: "ACCEPT" })).resolves.toEqual({ answer: "ACCEPTED", applicationReceived: true });
        expect(intakeAcceptedNurtureInvitation).toHaveBeenCalledWith({ tenantId: TENANT, invitation: expect.objectContaining({ id: 700, nurtureRunId: 3 }) });
        expect(invitation(700)).toMatchObject({ status: "ACCEPTED", respondedVia: "CANDIDATE_LINK", responseTokenHash: null });
    });

    it("a closed role is a 409 and leaves the invitation and its link open", async () => {
        flags.add("talentNurture");
        intakeAcceptedNurtureInvitation.mockRejectedValue(Object.assign(new Error("closed"), { status: 409, code: "HR-RECRUITMENT-APPLICATIONS-CLOSED" }));
        const token = tokenOf(await issue(700));
        await expect(answer(token, { answer: "ACCEPT" })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-INVITATION-ROLE-CLOSED" });
        expect(invitation(700)).toMatchObject({ status: "INVITED", responseTokenHash: sha(token) });
        // Declining still works.
        await expect(answer(token, { answer: "DECLINE" })).resolves.toMatchObject({ answer: "DECLINED" });
    });

    it("a do-not-contact refusal looks like a dead link; an outage is not hidden", async () => {
        flags.add("talentNurture");
        const token = tokenOf(await issue(700));
        intakeAcceptedNurtureInvitation.mockRejectedValueOnce(Object.assign(new Error("dnc"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        await expect(answer(token, { answer: "ACCEPT" })).resolves.toBeNull();
        intakeAcceptedNurtureInvitation.mockRejectedValueOnce(new Error("db down"));
        await expect(answer(token, { answer: "ACCEPT" })).rejects.toThrow("db down");
    });

    it("two answers racing through one link: exactly one lands", async () => {
        const token = tokenOf(await issue(701));
        const results = await Promise.all([answer(token, { answer: "ACCEPT" }), answer(token, { answer: "DECLINE" })]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(["ACCEPTED", "DECLINED"]).toContain(invitation(701).status);
    });

    it("validates the body before looking at the token", async () => {
        await expect(answer("A".repeat(43), { answer: "MAYBE" })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-INVITATION-RESPONSE-INVALID" });
        await expect(answer("A".repeat(43), { answer: "ACCEPT", note: "x".repeat(501) })).rejects.toMatchObject({ status: 400 });
        await expect(answer("A".repeat(43), { answer: "ACCEPT", note: 7 })).rejects.toMatchObject({ code: "HR-RECRUITMENT-INVITATION-NOTE-INVALID" });
        expect(db.talentPoolInvitation.findFirst).not.toHaveBeenCalled();
    });

    it("another tenant's portal cannot answer the link", async () => {
        const token = tokenOf(await issue(701));
        await expect(answer(token, { answer: "ACCEPT" }, { tenantId: OTHER })).resolves.toBeNull();
        expect(invitation(701).status).toBe("INVITED");
    });
});

describe("the recruiter path and terminal statuses", () => {
    it("a recruiter's answer is RECRUITER and kills the link", async () => {
        const token = tokenOf(await issue(701));
        await asTenant(() => respondToInvitation({ tenantId: TENANT, invitationId: 701, response: "ACCEPTED" }));
        expect(invitation(701)).toMatchObject({ status: "ACCEPTED", respondedVia: "RECRUITER", responseTokenHash: null, responseTokenExpiresAt: null });
        await expect(answer(token, { answer: "DECLINE" })).resolves.toBeNull();
    });

    it("no recruiter-facing result carries the link's hash", async () => {
        await issue(700);
        const listed = await asTenant(() => listInvitations({ tenantId: TENANT }));
        expect(listed.items.length).toBeGreaterThan(0);
        expect(JSON.stringify(listed)).not.toContain("responseTokenHash");
        const reused = await asTenant(() => inviteToApply({ tenantId: TENANT, candidateId: 5, jobRequisitionId: 21 }));
        expect(reused).toMatchObject({ reused: true, invitation: { id: 700 } });
        expect(reused.invitation).not.toHaveProperty("responseTokenHash");
        const answered = await asTenant(() => respondToInvitation({ tenantId: TENANT, invitationId: 700, response: "DECLINED" }));
        expect(answered).not.toHaveProperty("responseTokenHash");
    });

    it("withdrawal and expiry clear the link without recording a responder", async () => {
        await issue(701);
        await asTenant(() => withdrawInvitation({ tenantId: TENANT, invitationId: 701, reason: "Role on hold" }));
        expect(invitation(701)).toMatchObject({ status: "WITHDRAWN", respondedVia: null, responseTokenHash: null, responseTokenExpiresAt: null });

        await issue(700);
        await asTenant(() => expireInvitations({ tenantId: TENANT, asOf: new Date(NOW.getTime() + 15 * DAY), dryRun: false }));
        expect(invitation(700)).toMatchObject({ status: "EXPIRED", responseTokenHash: null, responseTokenExpiresAt: null });
    });
});
