// Recruitment Phase 5 — agency administration and submissions against an
// in-memory Prisma: the caps, the open-requisition rule, the review outcomes
// (ACCEPT / REJECT / DUPLICATE), the ownership window, versioned updates and
// login reuse. Every query must run under the tenant's request context.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { makeAgencyDb } from "./helpers/agency.fake.js";

let fake = makeAgencyDb();
const events = [];
const proxy = new Proxy({}, { get: (_t, key) => fake.db[key] });

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: proxy, prisma: proxy }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: async () => undefined }));
jest.unstable_mockModule("../../../src/services/tagService.js", () => ({ upsertTags: async () => [] }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({
    computeRetentionUntil: async () => null,
    findActiveDnc: async () => null,
}));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: async (_tx, event) => {
        if (event) events.push(event);
        return event;
    },
}));

const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { AGENCY_MEMBERSHIP, resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");
const svc = await import("../../../src/services/agency-submission.service.js");
const admin = await import("../../../src/services/recruitment-agency.service.js");

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const RECRUITER = { userId: "r-1", roles: ["RECRUITER"], employeeId: 7, tenantId: T };
const asTenant = (fn, user = RECRUITER) => mcpCtx.run({ user, permissions: {} }, fn);
const agencyScope = (agencyId, requisitionIds) =>
    resolveRecruitmentScope({ userId: "u-1", roles: ["AGENCY"], tenantId: T, [AGENCY_MEMBERSHIP]: { agencyId, tenantId: T, userId: "u-1", requisitionIds } });
const previousFlag = process.env.HR_RECRUITMENT_AGENCY_PORTAL;

let W;
beforeEach(() => {
    process.env.HR_RECRUITMENT_AGENCY_PORTAL = "true";
    fake = makeAgencyDb();
    events.length = 0;
    const agency = fake.seed("recruitmentAgency", { tenantId: T, name: "Alpha", ownershipDays: 30 });
    const other = fake.seed("recruitmentAgency", { tenantId: T, name: "Beta", ownershipDays: 30 });
    const open = fake.seed("jobRequisition", { tenantId: T, title: "Engineer", status: "POSTED", requestedById: 3, recruiterId: 7 });
    const closed = fake.seed("jobRequisition", { tenantId: T, title: "Closed", status: "CLOSED", requestedById: 3 });
    const expired = fake.seed("jobRequisition", { tenantId: T, title: "Past", status: "APPROVED", closesAt: new Date(NOW.getTime() - DAY), requestedById: 3 });
    fake.seed("jobPosting", { tenantId: T, requisitionId: open.id, isActive: true });
    for (const req of [open, closed, expired]) {
        fake.seed("requisitionAgencyAssignment", { tenantId: T, agencyId: agency.id, requisitionId: req.id, status: "ACTIVE", maxSubmissions: 2 });
    }
    W = { agency, other, open, closed, expired, scope: agencyScope(agency.id, [open.id, closed.id, expired.id]) };
});

afterAll(() => {
    if (previousFlag === undefined) delete process.env.HR_RECRUITMENT_AGENCY_PORTAL;
    else process.env.HR_RECRUITMENT_AGENCY_PORTAL = previousFlag;
});

const submitInput = (over = {}) => ({ requisitionId: W.open.id, firstName: "Ann", lastName: "A", email: "Ann@Example.com", note: "fit", ...over });
const submit = (over = {}, scope = W.scope) =>
    asTenant(() => svc.submitAgencyCandidate({ tenantId: T, scope, userId: "u-1", input: submitInput(over), now: NOW }));
const review = (id, decision, reason, now = NOW) =>
    asTenant(() => svc.reviewAgencySubmission({ tenantId: T, actorId: 7, id, decision, reason, now }));
const reject = (promise, match) => expect(promise).rejects.toMatchObject(match);

describe("agency submission", () => {
    it("stores the snapshot as PENDING_REVIEW and tells the recruiter, under the tenant", async () => {
        const view = await submit();
        expect(view).toMatchObject({ status: "PENDING_REVIEW", requisitionId: W.open.id, candidate: { email: "ann@example.com" }, rejectionReason: null });
        const row = fake.all("agencySubmission")[0];
        expect(row.candidateSnapshot).toEqual({ firstName: "Ann", lastName: "A", email: "ann@example.com", phone: null, resumeMediaId: null });
        expect(row.submittedByUserId).toBe("u-1");
        expect(events.map((e) => e.eventName)).toEqual(["hr.recruitment.agency_submission_received.v1"]);
        expect(events[0].payload.recruiterId).toBe("7");
        expect(JSON.stringify(events[0].payload)).not.toMatch(/Ann|example/);
        expect(fake.state.ops.every((op) => op.tenant === T)).toBe(true);
        // Nothing enters the pipeline before review.
        expect(fake.all("candidate")).toHaveLength(0);
    });

    it("respects maxSubmissions and refuses the agency's own repeat", async () => {
        await submit();
        await reject(submit(), { status: 409, code: "HR-RECRUITMENT-AGENCY-SUBMISSION-EXISTS" });
        await submit({ email: "bob@example.com", firstName: "Bob" });
        await reject(submit({ email: "cat@example.com" }), { status: 409, code: "HR-RECRUITMENT-AGENCY-SUBMISSION-LIMIT" });
    });

    it("refuses a closed or expired requisition, an ended assignment and an unassigned one", async () => {
        await reject(submit({ requisitionId: W.closed.id }), { status: 409, code: "HR-RECRUITMENT-AGENCY-REQUISITION-NOT-OPEN" });
        await reject(submit({ requisitionId: W.expired.id }), { status: 409, code: "HR-RECRUITMENT-AGENCY-REQUISITION-NOT-OPEN" });
        fake.all("requisitionAgencyAssignment").find((a) => a.requisitionId === W.open.id).status = "ENDED";
        await reject(submit(), { status: 404 });
        await reject(submit({}, agencyScope(W.agency.id, [])), { status: 404 });
        expect(fake.all("agencySubmission")).toHaveLength(0);
    });

    it("refuses a non-agency scope and is off with the flag", async () => {
        await reject(submit({}, resolveRecruitmentScope(RECRUITER)), { status: 403, code: "HR-RECRUITMENT-AGENCY-SCOPE-REQUIRED" });
        process.env.HR_RECRUITMENT_AGENCY_PORTAL = "false";
        await reject(submit(), { status: 503, code: "HR-RECRUITMENT-AGENCY-PORTAL-DISABLED" });
    });

    it("lists only open assigned requisitions and the agency's own submissions", async () => {
        await submit();
        fake.seed("agencySubmission", { tenantId: T, agencyId: W.other.id, requisitionId: W.open.id, submittedByUserId: "u-9", candidateSnapshot: { email: "x@y.z" } });
        const reqs = await asTenant(() => svc.listAgencyRequisitions({ tenantId: T, scope: W.scope, now: NOW }));
        expect(reqs.items.map((r) => r.id)).toEqual([W.open.id]);
        expect(reqs.items[0]).toMatchObject({ maxSubmissions: 2, submittedCount: 1 });
        const subs = await asTenant(() => svc.listOwnAgencySubmissions({ tenantId: T, scope: W.scope }));
        expect(subs.total).toBe(1);
    });
});

describe("review", () => {
    it("ACCEPT creates the candidate and the AGENCY application with the ownership window", async () => {
        const sub = await submit();
        const out = await review(sub.id, "ACCEPT");
        expect(out.outcome).toBe("ACCEPTED");
        const expires = new Date(NOW.getTime() + 30 * DAY);
        const candidate = fake.all("candidate")[0];
        const application = fake.all("application")[0];
        expect(candidate).toMatchObject({ email: "ann@example.com", source: "AGENCY", ownerAgencyId: W.agency.id, ownershipExpiresAt: expires });
        expect(application).toMatchObject({ candidateId: candidate.id, jobRequisitionId: W.open.id, sourceChannel: "AGENCY", ownerAgencyId: W.agency.id, ownershipExpiresAt: expires });
        expect(fake.all("agencySubmission")[0]).toMatchObject({ status: "ACCEPTED", candidateId: candidate.id, applicationId: application.id, reviewedById: 7 });
        await reject(review(sub.id, "ACCEPT"), { status: 409, code: "HR-RECRUITMENT-AGENCY-SUBMISSION-DECIDED" });
        expect(fake.state.ops.every((op) => op.tenant === T)).toBe(true);
    });

    it("REJECT needs a reason and the agency sees only a neutral one", async () => {
        const sub = await submit();
        await reject(review(sub.id, "REJECT"), { status: 400 });
        await review(sub.id, "REJECT", "Salary expectations far above the band");
        const subs = await asTenant(() => svc.listOwnAgencySubmissions({ tenantId: T, scope: W.scope }));
        expect(subs.items[0]).toMatchObject({ status: "REJECTED", rejectionReason: svc.AGENCY_NEUTRAL_REJECTION });
    });

    it("is a DUPLICATE when the candidate is owned by another agency inside its window", async () => {
        fake.seed("candidate", { tenantId: T, firstName: "Ann", email: "ann@example.com", ownerAgencyId: W.other.id, ownershipExpiresAt: new Date(NOW.getTime() + DAY) });
        const sub = await submit();
        const out = await review(sub.id, "ACCEPT");
        expect(out.outcome).toBe("DUPLICATE");
        expect(fake.all("agencySubmission")[0].rejectionReason).toMatch(`owned by agency ${W.other.id}`);
        expect(fake.all("application")).toHaveLength(0);
        const subs = await asTenant(() => svc.listOwnAgencySubmissions({ tenantId: T, scope: W.scope, status: "REJECTED" }));
        expect(subs.items[0]).toMatchObject({ status: "REJECTED", rejectionReason: svc.AGENCY_NEUTRAL_REJECTION });
    });

    it("takes over a candidate whose other-agency window has passed", async () => {
        const cand = fake.seed("candidate", { tenantId: T, firstName: "Ann", email: "ann@example.com", ownerAgencyId: W.other.id, ownershipExpiresAt: new Date(NOW.getTime() - DAY) });
        const sub = await submit();
        expect((await review(sub.id, "ACCEPT")).outcome).toBe("ACCEPTED");
        expect(fake.all("candidate").find((c) => c.id === cand.id).ownerAgencyId).toBe(W.agency.id);
    });

    it("is a DUPLICATE when the candidate is already in process for the requisition", async () => {
        const cand = fake.seed("candidate", { tenantId: T, firstName: "Ann", email: "ann@example.com" });
        const app = fake.seed("application", { tenantId: T, candidateId: cand.id, jobRequisitionId: W.open.id, sourceChannel: "CAREER_SITE" });
        const sub = await submit();
        const out = await review(sub.id, "ACCEPT");
        expect(out).toMatchObject({ outcome: "DUPLICATE" });
        expect(out.reason).toMatch(`already in process for this requisition (application ${app.id})`);
        expect(fake.all("application")).toHaveLength(1);
    });

    it("resumes onto the application a failed earlier ACCEPT left behind", async () => {
        const sub = await submit();
        const cand = fake.seed("candidate", { tenantId: T, firstName: "Ann", email: "ann@example.com" });
        const app = fake.seed("application", { tenantId: T, candidateId: cand.id, jobRequisitionId: W.open.id, sourceChannel: "AGENCY", sourceDetail: `agency-submission:${sub.id}` });
        const out = await review(sub.id, "ACCEPT");
        expect(out).toMatchObject({ outcome: "ACCEPTED", applicationId: app.id, candidateId: cand.id });
        expect(fake.all("application")).toHaveLength(1);
    });
});

describe("agency administration", () => {
    const run = (fn) => asTenant(fn);

    it("updates at the version read and reports the current one on a conflict", async () => {
        const updated = await run(() => admin.updateAgency({ tenantId: T, id: W.agency.id, expectedVersion: 0, input: { status: "SUSPENDED", feePercent: 12.35 } }));
        expect(updated).toMatchObject({ status: "SUSPENDED", version: 1, feePercent: 12.35 });
        await reject(run(() => admin.updateAgency({ tenantId: T, id: W.agency.id, expectedVersion: 0, input: { notes: "x" } })),
            { status: 409, code: "HR-RECRUITMENT-AGENCY-VERSION-CONFLICT", details: { currentVersion: 1 } });
        await reject(run(() => admin.updateAgency({ tenantId: T, id: 999, expectedVersion: 0, input: { notes: "x" } })), { status: 404 });
    });

    it("validates the agency fields", () => {
        expect(() => admin.normalizeAgencyInput({ feePercent: 12.345 })).toThrow(/two decimals/);
        expect(() => admin.normalizeAgencyInput({ ownershipDays: 731 })).toThrow(/ownershipDays/);
        expect(() => admin.normalizeAgencyInput({}, { creating: true })).toThrow(/name is required/);
        expect(() => admin.normalizeAgencyInput({ status: "DELETED" })).toThrow(/status/);
    });

    it("refuses a duplicate name", async () => {
        await reject(run(() => admin.createAgency({ tenantId: T, input: { name: "Alpha" } })), { status: 409, code: "HR-RECRUITMENT-AGENCY-NAME-TAKEN" });
    });

    it("assigns only open requisitions to active agencies, and reactivates an ended pair", async () => {
        const fresh = fake.seed("jobRequisition", { tenantId: T, title: "New", status: "APPROVED", requestedById: 3 });
        await reject(run(() => admin.assignRequisitionToAgency({ tenantId: T, requisitionId: W.closed.id, agencyId: W.other.id, now: NOW })),
            { status: 409, code: "HR-RECRUITMENT-AGENCY-REQUISITION-NOT-OPEN" });
        const first = await run(() => admin.assignRequisitionToAgency({ tenantId: T, actorId: 7, requisitionId: fresh.id, agencyId: W.other.id, maxSubmissions: 3, now: NOW }));
        expect(first).toMatchObject({ status: "ACTIVE", maxSubmissions: 3, reactivated: false });
        await run(() => admin.unassignRequisitionFromAgency({ tenantId: T, requisitionId: fresh.id, agencyId: W.other.id, now: NOW }));
        const again = await run(() => admin.assignRequisitionToAgency({ tenantId: T, requisitionId: fresh.id, agencyId: W.other.id, now: NOW }));
        expect(again).toMatchObject({ id: first.id, status: "ACTIVE", reactivated: true, endedAt: null });
        fake.all("recruitmentAgency").find((a) => a.id === W.other.id).status = "SUSPENDED";
        await reject(run(() => admin.assignRequisitionToAgency({ tenantId: T, requisitionId: fresh.id, agencyId: W.other.id, now: NOW })),
            { status: 409, code: "HR-RECRUITMENT-AGENCY-SUSPENDED" });
    });

    it("keeps one agency per login and reactivates a revoked one", async () => {
        const login = await run(() => admin.addAgencyUser({ tenantId: T, agencyId: W.agency.id, userId: "u-1" }));
        await reject(run(() => admin.addAgencyUser({ tenantId: T, agencyId: W.other.id, userId: "u-1" })), { status: 409, code: "HR-RECRUITMENT-AGENCY-USER-CONFLICT" });
        await run(() => admin.revokeAgencyUser({ tenantId: T, id: login.id }));
        const moved = await run(() => admin.addAgencyUser({ tenantId: T, agencyId: W.other.id, userId: "u-1" }));
        expect(moved).toMatchObject({ id: login.id, agencyId: W.other.id, status: "ACTIVE", reused: true });
    });

    it("refuses writes with the flag off", async () => {
        process.env.HR_RECRUITMENT_AGENCY_PORTAL = "false";
        await reject(run(() => admin.createAgency({ tenantId: T, input: { name: "Gamma" } })), { status: 503, code: "HR-RECRUITMENT-AGENCY-PORTAL-DISABLED" });
        const list = await run(() => admin.listAgencies({ tenantId: T }));
        expect(list.total).toBe(2);
    });
});
