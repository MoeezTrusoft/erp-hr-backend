// Recruitment Phase 5 (plan 6.2) — the internal job board, internal
// applications and employee referrals, against an in-memory Prisma that
// enforces the tenant context at await time.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

import { makeInternalMobilityDb } from "./helpers/internal-mobility.fake.js";

const fake = { current: null };
const dbProxy = new Proxy({}, { get: (_t, key) => fake.current.db[key] });

const DNC = new Set();
const checkIntakeDnc = jest.fn(async ({ email }) => (DNC.has(email) ? { blocked: true, reason: "REQUESTED" } : { blocked: false, reason: null }));
const logIntakeSuppressed = jest.fn();
const logAction = jest.fn(async () => undefined);

// The gated creation path, as far as these flows rely on it: the DNC refusal,
// the one-application-per-candidate rule, the row and the created event.
const createApplicationInTx = jest.fn(async (tx, args) => {
    const candidate = await tx.candidate.findFirst({ where: { id: args.candidateId, tenantId: args.tenantId } });
    if (DNC.has(candidate.email)) throw Object.assign(new Error("dnc"), { status: 409, code: "HR-RECRUITMENT-CANDIDATE-DNC" });
    const dup = await tx.application.findFirst({ where: { candidateId: args.candidateId, jobRequisitionId: args.jobRequisitionId } });
    if (dup) throw Object.assign(new Error("unique"), { code: "P2002" });
    const app = await tx.application.create({
        data: {
            tenantId: args.tenantId,
            candidateId: args.candidateId,
            jobRequisitionId: args.jobRequisitionId,
            createdById: args.createdById,
            sourceChannel: args.sourceChannel,
            sourceDetail: args.sourceDetail ?? null,
            sourcePostingId: args.sourcePostingId ?? null,
            applicantEmployeeId: args.applicantEmployeeId ?? null,
        },
    });
    await tx.outboxEvent.create({ data: { payload: { name: "hr.recruitment.application_created.v1", payload: { applicationId: String(app.id) } } } });
    return app;
});

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: dbProxy, prisma: dbProxy }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: dbProxy }));
jest.unstable_mockModule("../../../src/services/intake-dnc.service.js", () => ({ checkIntakeDnc, logIntakeSuppressed }));
jest.unstable_mockModule("../../../src/services/applicationService.js", () => ({ createApplicationInTx }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));

const svc = await import("../../../src/services/internal-board.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const ME = 101;
const MGR = 102;
const REC = 103;
const LEFT = 104;
const COLLEAGUE = 105;
const NOW = new Date("2026-10-20T09:00:00Z");

const asUser = (fn, { tenantId = T1, employeeId = ME } = {}) =>
    mcpCtx.run({ user: { tenantId, employeeId } }, async () => await fn());

const failure = async (promise) => {
    try {
        await promise;
    } catch (err) {
        return { status: err.status, code: err.code, message: err.message, details: err.details };
    }
    throw new Error("expected a failure");
};

let ids;
let f;
function seedWorld() {
    f = makeInternalMobilityDb();
    fake.current = f;
    const person = (id, extra = {}) => f.seed("employee", { id, tenant_id: T1, first_name: `P${id}`, last_name: "Test", work_email: `p${id}@acme.test`, email: null, status: "Active", separatedAt: null, ...extra });
    person(ME, { first_name: "Sara", last_name: "Ali", work_email: "Sara.Ali@acme.test", email: "sara.personal@mail.test", work_phone: "+92 300 1234567" });
    person(MGR);
    person(REC);
    person(LEFT, { status: "Terminated" });
    person(COLLEAGUE, { work_email: "colleague@acme.test", email: "colleague.home@mail.test" });
    f.seed("employee", { id: 201, tenant_id: T2, first_name: "Other", work_email: "x@other.test" });

    const req = (extra = {}, postings = [{ channel: "INTERNAL" }]) => {
        const r = f.seed("jobRequisition", {
            tenantId: T1, title: "Backend Engineer", departmentId: 7, location: "Lahore", employmentType: "FULL_TIME", openings: 1,
            requestedById: MGR, recruiterId: REC, gradeLevelId: 3, budgetedAmount: "900000", budgetCurrency: "PKR",
            costCenterRef: "CC-1", approvalChainSnapshot: { steps: ["x"] }, description: "Legacy JD text",
            jobContent: { schemaVersion: 1, summary: "Build services.", responsibilities: ["Own the API"], requirements: ["Node.js"], skills: ["SQL"], benefits: [], hiringProcess: ["internal: fast track"] },
            ...extra,
        });
        for (const p of postings) f.seed("jobPosting", { tenantId: r.tenantId, requisitionId: r.id, ...p });
        return r.id;
    };
    ids = {
        internal: req({ title: "Backend Engineer", publishedAt: new Date("2026-10-10T00:00:00Z") }, [{ channel: "INTERNAL", postedAt: new Date("2026-10-11T00:00:00Z") }]),
        career: req({ title: "Data Analyst", recruiterId: null, jobContent: null, publishedAt: new Date("2026-10-05T00:00:00Z") }, [{ channel: "CAREER_SITE" }, { channel: "LINKEDIN", externalUrl: "https://li.test/1" }]),
        linkedinOnly: req({ title: "Agency role" }, [{ channel: "LINKEDIN", externalUrl: "https://li.test/2" }]),
        mine: req({ requestedById: ME }),
        recruiting: req({ recruiterId: ME }),
        replacing: req({ replacementEmployeeId: ME }),
        windowClosed: req({ closesAt: new Date("2026-10-19T00:00:00Z") }),
        postingClosed: req({}, [{ channel: "INTERNAL", isActive: false, closedAt: new Date("2026-10-15T00:00:00Z") }]),
        draft: req({ status: "DRAFT" }),
        otherTenant: req({ tenantId: T2, requestedById: 201, recruiterId: null }),
    };
    return f;
}

beforeEach(() => {
    jest.clearAllMocks();
    DNC.clear();
    seedWorld();
});

describe("the board", () => {
    it("lists only open roles with a live CAREER_SITE or INTERNAL posting, never the caller's own", async () => {
        const page = await asUser(() => svc.listInternalJobs({ tenantId: T1, employeeId: ME, now: NOW }));
        expect(page.items.map((j) => j.id)).toEqual([ids.internal, ids.career]);
        expect(page.total).toBe(2);
    });

    it("shows the public fields and a plain description, never bands, budget, approval or internal notes", async () => {
        const { items } = await asUser(() => svc.listInternalJobs({ tenantId: T1, employeeId: ME, now: NOW }));
        const job = items[0];
        expect(Object.keys(job).sort()).toEqual(
            ["applied", "closesAt", "departmentId", "departmentName", "description", "employmentType", "id", "location", "openings", "postedAt", "title"].sort(),
        );
        expect(job).toMatchObject({ title: "Backend Engineer", departmentId: 7, location: "Lahore", employmentType: "FULL_TIME", postedAt: "2026-10-11T00:00:00.000Z", applied: false });
        expect(job.description).toContain("Build services.");
        expect(job.description).toContain("- Own the API");
        expect(job.description).not.toContain("fast track");
        expect(JSON.stringify(items)).not.toMatch(/900000|CC-1|gradeLevel|approval|budget/i);
        // No job content: the legacy description stands in.
        expect(items[1].description).toBe("Legacy JD text");
    });

    it("searches the title and pages", async () => {
        const hit = await asUser(() => svc.listInternalJobs({ tenantId: T1, employeeId: ME, q: "analyst", now: NOW }));
        expect(hit.items.map((j) => j.id)).toEqual([ids.career]);
        const second = await asUser(() => svc.listInternalJobs({ tenantId: T1, employeeId: ME, page: 2, pageSize: 1, now: NOW }));
        expect(second).toMatchObject({ total: 2, page: 2, pageSize: 1 });
        expect(second.items.map((j) => j.id)).toEqual([ids.career]);
    });

    it("answers one job, and the same 404 for anything not on the caller's board", async () => {
        const job = await asUser(() => svc.getInternalJob({ tenantId: T1, employeeId: ME, requisitionId: ids.career, now: NOW }));
        expect(job.id).toBe(ids.career);
        for (const id of [ids.linkedinOnly, ids.mine, ids.recruiting, ids.replacing, ids.windowClosed, ids.postingClosed, ids.draft, ids.otherTenant, 999999, "abc"]) {
            const err = await failure(asUser(() => svc.getInternalJob({ tenantId: T1, employeeId: ME, requisitionId: id, now: NOW })));
            expect(err).toMatchObject({ status: 404, code: "HR-RECRUITMENT-INTERNAL-JOB-NOT-FOUND" });
        }
        // The hiring manager's board does not hide it from anyone else.
        const forMgr = await asUser(() => svc.getInternalJob({ tenantId: T1, employeeId: MGR, requisitionId: ids.mine, now: NOW }), { employeeId: MGR });
        expect(forMgr.id).toBe(ids.mine);
    });

    it("never runs a query outside the caller's tenant", async () => {
        await asUser(() => svc.listInternalJobs({ tenantId: T1, employeeId: ME, now: NOW }));
        expect(f.state.ops.every((op) => op.tenant === T1)).toBe(true);
    });
});

describe("applying internally", () => {
    const apply = (extra = {}, as = {}) =>
        asUser(() => svc.applyToInternalJob({ tenantId: T1, employeeId: ME, requisitionId: ids.internal, consent: true, policyVersion: "v3", now: NOW, ...extra }), as);

    it("creates the candidate from the work email and an INTERNAL application through the gated path", async () => {
        const res = await apply();
        expect(res).toMatchObject({ applied: true, requisitionId: ids.internal });
        const [candidate] = f.all("candidate");
        expect(candidate).toMatchObject({ tenantId: T1, email: "sara.ali@acme.test", firstName: "Sara", lastName: "Ali", consentStatus: "GRANTED", source: "Internal", phone: "+92 300 1234567" });
        const [app] = f.all("application");
        expect(app).toMatchObject({ id: res.applicationId, candidateId: candidate.id, jobRequisitionId: ids.internal, sourceChannel: "INTERNAL", applicantEmployeeId: ME, createdById: ME });
        const internalPosting = f.all("jobPosting").find((p) => p.requisitionId === ids.internal);
        expect(app.sourcePostingId).toBe(internalPosting.id);
        expect(f.all("candidateConsent")).toEqual([
            expect.objectContaining({ candidateId: candidate.id, purpose: "PROCESSING", status: "GRANTED", policyVersion: "v3", source: "internal-board", recordedById: ME }),
        ]);
        expect(f.events().map((e) => e.name)).toEqual(["hr.recruitment.application_created.v1"]);
        // Every write ran in one transaction under the caller's tenant.
        const writes = f.state.ops.filter((op) => ["create", "updateMany"].includes(op.op));
        expect(writes.every((op) => op.tx != null && op.tenant === T1)).toBe(true);

        const board = await asUser(() => svc.listInternalJobs({ tenantId: T1, employeeId: ME, now: NOW }));
        expect(board.items.find((j) => j.id === ids.internal).applied).toBe(true);
    });

    it("allows one application per requisition", async () => {
        const first = await apply();
        const err = await failure(apply());
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-INTERNAL-ALREADY-APPLIED", details: { applicationId: first.applicationId } });
        expect(f.all("application")).toHaveLength(1);
    });

    it("reuses a candidate matched by the personal email and gives consent again", async () => {
        const old = f.seed("candidate", { tenantId: T1, email: "sara.personal@mail.test", firstName: "Sara", consentStatus: "WITHDRAWN" });
        await apply();
        expect(f.all("candidate")).toHaveLength(1);
        expect(f.all("candidate")[0]).toMatchObject({ id: old.id, consentStatus: "GRANTED", version: 1 });
        expect(f.all("application")[0].candidateId).toBe(old.id);
    });

    it("treats an earlier external application to the same job as already applied", async () => {
        const old = f.seed("candidate", { tenantId: T1, email: "sara.ali@acme.test", firstName: "Sara" });
        const earlier = f.seed("application", { tenantId: T1, candidateId: old.id, jobRequisitionId: ids.internal });
        const err = await failure(apply());
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-INTERNAL-ALREADY-APPLIED", details: { applicationId: earlier.id } });
    });

    it("refuses without consent, for a former employee, on an archived record and on a job not on the board", async () => {
        expect(await failure(apply({ consent: false }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-INTERNAL-CONSENT-REQUIRED" });
        expect(await failure(apply({ employeeId: LEFT }, { employeeId: LEFT }))).toMatchObject({ status: 403, code: "HR-RECRUITMENT-INTERNAL-NOT-EMPLOYED" });
        expect(await failure(apply({ requisitionId: ids.mine }))).toMatchObject({ status: 404, code: "HR-RECRUITMENT-INTERNAL-JOB-NOT-FOUND" });
        f.seed("candidate", { tenantId: T1, email: "sara.ali@acme.test", firstName: "Sara", status: "archived", archivedAt: new Date("2026-01-01") });
        expect(await failure(apply())).toMatchObject({ status: 409, code: "HR-RECRUITMENT-INTERNAL-CANDIDATE-ARCHIVED" });
        expect(f.all("application")).toHaveLength(0);
    });

    it("keeps the do-not-contact refusal and rolls the whole intake back", async () => {
        DNC.add("sara.ali@acme.test");
        expect(await failure(apply())).toMatchObject({ status: 409, code: "HR-RECRUITMENT-CANDIDATE-DNC" });
        expect(f.all("candidate")).toHaveLength(0);
        expect(f.all("candidateConsent")).toHaveLength(0);
        expect(f.all("application")).toHaveLength(0);
    });
});

describe("referrals", () => {
    const form = (extra = {}) => ({ firstName: "Omar", lastName: "Khan", email: "Omar.Khan@mail.test", phone: "+92 321 7654321", relationship: "Former colleague", note: "Great engineer", consent: true, ...extra });
    const refer = (extra = {}, as = {}) =>
        asUser(() => svc.createReferral({ tenantId: T1, employeeId: as.employeeId ?? ME, requisitionId: ids.internal, now: NOW, ...form(extra) }), as);

    it("creates the contact, the referral and a REFERRAL application, and tells the recruiter", async () => {
        const res = await refer();
        expect(Object.keys(res).sort()).toEqual(["bonusStatus", "id", "jobTitle", "relationship", "requisitionId", "status", "submittedAt"]);
        expect(res).toMatchObject({ status: "SUBMITTED", bonusStatus: "NOT_ELIGIBLE", jobTitle: "Backend Engineer", relationship: "Former colleague" });

        const [candidate] = f.all("candidate");
        expect(candidate).toMatchObject({ email: "omar.khan@mail.test", firstName: "Omar", source: "Referral", createdById: ME, consentStatus: "GRANTED" });
        const [referral] = f.all("internalReferral");
        const [app] = f.all("application");
        expect(app).toMatchObject({ candidateId: candidate.id, sourceChannel: "REFERRAL", sourceDetail: `referral:${referral.id}`, applicantEmployeeId: null });
        expect(referral).toMatchObject({ id: res.id, tenantId: T1, referrerEmployeeId: ME, candidateId: candidate.id, applicationId: app.id, status: "SUBMITTED", note: "Great engineer" });
        expect(f.all("candidateConsent")[0]).toMatchObject({ source: "referral", recordedById: ME, purpose: "PROCESSING" });

        const submitted = f.events().find((e) => e.name === "hr.recruitment.referral_submitted.v1");
        expect(submitted).toMatchObject({
            tenantId: T1,
            payload: { referralId: String(referral.id), requisitionId: String(ids.internal), referrerEmployeeId: String(ME), candidateId: String(candidate.id), applicationId: String(app.id), status: "SUBMITTED", recruiterId: String(REC), requestedById: String(MGR) },
        });
        // ids only: no address, name or note leaves in the event.
        expect(JSON.stringify(submitted)).not.toMatch(/omar|great engineer|colleague/i);
    });

    it("records a DUPLICATE referral and no second application for a contact already in process", async () => {
        const existing = f.seed("candidate", { tenantId: T1, email: "Omar.Khan@MAIL.test", firstName: "O." });
        f.seed("application", { tenantId: T1, candidateId: existing.id, jobRequisitionId: ids.internal, stage: "screening" });
        const res = await refer();
        expect(res.status).toBe("DUPLICATE");
        expect(f.all("application")).toHaveLength(1);
        expect(f.all("internalReferral")[0]).toMatchObject({ candidateId: existing.id, applicationId: null, status: "DUPLICATE" });
        expect(f.all("candidate")[0].firstName).toBe("O."); // the referrer's typing never overwrites the record
        expect(f.events().find((e) => e.name === "hr.recruitment.referral_submitted.v1").payload.status).toBe("DUPLICATE");
    });

    it("answers the same referral when the referrer sends the contact again", async () => {
        const first = await refer();
        const again = await refer();
        expect(again.id).toBe(first.id);
        expect(f.all("internalReferral")).toHaveLength(1);
        expect(f.all("application")).toHaveLength(1);
    });

    it("lets a second employee refer the same contact as a DUPLICATE", async () => {
        await refer();
        const second = await refer({}, { employeeId: COLLEAGUE });
        expect(second.status).toBe("DUPLICATE");
    });

    it("does not process a contact on the register or with withdrawn consent, and does not say why", async () => {
        DNC.add("omar.khan@mail.test");
        const res = await refer();
        expect(Object.keys(res).sort()).toEqual(["bonusStatus", "id", "jobTitle", "relationship", "requisitionId", "status", "submittedAt"]);
        // Phase 6: the referrer cannot tell a suppressed referral from a fresh one.
        expect(res.status).toBe("SUBMITTED");
        expect(f.all("candidate")).toHaveLength(0);
        expect(f.all("application")).toHaveLength(0);
        expect(f.all("internalReferral")[0]).toMatchObject({ candidateId: null, applicationId: null, status: "REJECTED" });
        expect(f.events()).toHaveLength(0);
        expect(logIntakeSuppressed).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1, path: "internal.referral", reason: "REQUESTED" }));

        DNC.clear();
        f.seed("candidate", { tenantId: T1, email: "lina@mail.test", firstName: "Lina", consentStatus: "WITHDRAWN" });
        const withdrawn = await refer({ email: "lina@mail.test", firstName: "Lina" });
        expect(withdrawn.status).toBe("SUBMITTED");
        expect(f.all("application")).toHaveLength(0);
    });

    it("refuses colleagues (the referrer included), a missing consent, a bad form and a job not on the board", async () => {
        expect(await failure(refer({ email: "COLLEAGUE.home@mail.test" }))).toMatchObject({ status: 422, code: "HR-RECRUITMENT-REFERRAL-EMPLOYEE" });
        expect(await failure(refer({ email: "sara.ali@acme.test" }))).toMatchObject({ status: 422, code: "HR-RECRUITMENT-REFERRAL-EMPLOYEE" });
        expect(await failure(refer({ consent: undefined }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-CONSENT-REQUIRED" });
        expect(await failure(refer({ email: "nope" }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-INPUT-INVALID" });
        expect(await failure(refer({ phone: "call me" }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-INPUT-INVALID" });
        expect(await failure(refer({ note: "x".repeat(2001) }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-INPUT-INVALID" });
        expect(await failure(asUser(() => svc.createReferral({ tenantId: T1, employeeId: ME, requisitionId: ids.linkedinOnly, now: NOW, ...form() })))).toMatchObject({ status: 404 });
        expect(await failure(asUser(() => svc.createReferral({ tenantId: T1, employeeId: LEFT, requisitionId: ids.internal, now: NOW, ...form() }), { employeeId: LEFT }))).toMatchObject({ status: 403 });
        expect(f.all("internalReferral")).toHaveLength(0);
    });

    it("lists only the caller's own referrals with status and bonus status", async () => {
        await refer();
        await refer({ email: "nadia@mail.test", firstName: "Nadia" }, { employeeId: COLLEAGUE });
        f.seed("internalReferral", { tenantId: T2, requisitionId: ids.otherTenant, referrerEmployeeId: ME, status: "HIRED" });
        const mine = await asUser(() => svc.listMyReferrals({ tenantId: T1, employeeId: ME }));
        expect(mine.total).toBe(1);
        expect(mine.items).toEqual([
            { id: expect.any(Number), requisitionId: ids.internal, jobTitle: "Backend Engineer", relationship: "Former colleague", status: "SUBMITTED", bonusStatus: "NOT_ELIGIBLE", submittedAt: expect.any(String) },
        ]);
    });

    // Phase 6 — the self list cannot tell a suppressed referral from a fresh one.
    it("shows a suppressed referral exactly like a fresh one in the referrer's own list", async () => {
        await refer();
        DNC.add("hidden@mail.test");
        await refer({ email: "hidden@mail.test", firstName: "Hidden" });
        const rows = f.all("internalReferral");
        expect(rows.map((r) => r.status).sort()).toEqual(["REJECTED", "SUBMITTED"]); // HR keeps the truth
        const mine = await asUser(() => svc.listMyReferrals({ tenantId: T1, employeeId: ME }));
        expect(mine.total).toBe(2);
        const strip = ({ id, submittedAt, ...rest }) => rest;
        expect(strip(mine.items[0])).toEqual(strip(mine.items[1]));
        for (const item of mine.items) {
            expect(Object.keys(item).sort()).toEqual(["bonusStatus", "id", "jobTitle", "relationship", "requisitionId", "status", "submittedAt"]);
            expect(item).toMatchObject({ status: "SUBMITTED", bonusStatus: "NOT_ELIGIBLE" });
        }
    });

    // Phase 6 — the agency rule at referral intake.
    it("records a DUPLICATE with no application for a contact an agency owns inside its window", async () => {
        const owned = f.seed("candidate", {
            tenantId: T1, email: "omar.khan@mail.test", firstName: "O.", status: "active",
            ownerAgencyId: 4, ownershipExpiresAt: new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000),
        });
        const res = await refer();
        expect(res.status).toBe("DUPLICATE");
        expect(f.all("application")).toHaveLength(0);
        expect(f.all("internalReferral")[0]).toMatchObject({ candidateId: owned.id, applicationId: null, status: "DUPLICATE" });
        const event = f.events().find((e) => e.name === "hr.recruitment.referral_submitted.v1");
        expect(event.payload).toMatchObject({ status: "DUPLICATE", duplicateReason: "AGENCY_OWNERSHIP" });
    });

    it("takes an expired agency window as free and refers the contact normally", async () => {
        f.seed("candidate", {
            tenantId: T1, email: "omar.khan@mail.test", firstName: "O.", status: "active",
            ownerAgencyId: 4, ownershipExpiresAt: new Date(NOW.getTime() - 1000),
        });
        const res = await refer();
        expect(res.status).toBe("SUBMITTED");
        expect(f.all("application")).toHaveLength(1);
    });
});
