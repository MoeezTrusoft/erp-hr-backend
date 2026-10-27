// Recruitment Phase 7 (C8, C10) — the agency upload refusals each carry their
// own code and a coded reason (the portal no longer reads the message), the
// HR submission rows say which DUPLICATE case they are, and the HR agency
// reads name the employees behind their ids (one lookup per read, the
// caller's tenant only, never an email).
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { makeAgencyDb } from "./helpers/agency.fake.js";

let fake = makeAgencyDb();
const events = [];

// Employee rows key the tenant as tenant_id: a small delegate beside the fake,
// recording every lookup with the tenant it ran under.
const employees = [];
const employeeQueries = [];
let requestCtx = null; // set once the context module is imported below
const employeeDelegate = {
    findMany: ({ where, select }) => {
        const tenant = requestCtx.getStore()?.user?.tenantId ?? null;
        employeeQueries.push({ where, tenant });
        const ids = where?.id?.in ?? [];
        return Promise.resolve(employees
            .filter((e) => e.tenant_id === where.tenant_id && e.tenant_id === tenant && ids.includes(e.id))
            .map((e) => Object.fromEntries(Object.keys(select).map((k) => [k, e[k]]))));
    },
};
const proxy = new Proxy({}, { get: (_t, key) => (key === "employee" ? employeeDelegate : fake.db[key]) });

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
const uploadFileToDAM = jest.fn(async () => [{ id: 901 }]);
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM, deleteDamAsset: async () => ({ ok: true }) }));

const { mcpCtx } = await import("../../../src/lib/requestContext.js");
requestCtx = mcpCtx;
const { AGENCY_MEMBERSHIP, resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");
const svc = await import("../../../src/services/agency-submission.service.js");
const admin = await import("../../../src/services/recruitment-agency.service.js");
const { toJsonRpcError } = await import("../../../src/mcp/utils/mcpErrorMap.js");
const { ONBOARDING_UPLOAD_MAX_BASE64_LENGTH, ONBOARDING_UPLOAD_MAX_BYTES } = await import("../../../src/lib/onboarding-upload.util.js");

const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const RECRUITER = { userId: "r-1", roles: ["RECRUITER"], employeeId: 7, tenantId: T };
const asTenant = (fn) => mcpCtx.run({ user: RECRUITER, permissions: {} }, fn);
const agencyScope = (agencyId, requisitionIds) =>
    resolveRecruitmentScope({ userId: "u-1", roles: ["AGENCY"], tenantId: T, [AGENCY_MEMBERSHIP]: { agencyId, tenantId: T, userId: "u-1", requisitionIds } });
const previousFlag = process.env.HR_RECRUITMENT_AGENCY_PORTAL;

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n").toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64");
const resume = (over = {}) => ({ fileName: "cv.pdf", mimeType: "application/pdf", contentBase64: PDF, ...over });

let W;
beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_AGENCY_PORTAL = "true";
    fake = makeAgencyDb();
    events.length = 0;
    employees.length = 0;
    employeeQueries.length = 0;
    employees.push(
        { id: 7, tenant_id: T, first_name: "Rita", last_name: "Recruiter", employee_name: null, work_email: "rita@acme.test" },
        { id: 8, tenant_id: T, first_name: "", last_name: "", employee_name: "Omar Ops" },
        { id: 9, tenant_id: T2, first_name: "Foreign", last_name: "Person" },
    );
    const agency = fake.seed("recruitmentAgency", { tenantId: T, name: "Alpha", ownershipDays: 30, createdById: 7 });
    const other = fake.seed("recruitmentAgency", { tenantId: T, name: "Beta", ownershipDays: 30, createdById: 9 });
    const open = fake.seed("jobRequisition", { tenantId: T, title: "Engineer", status: "POSTED", requestedById: 3, recruiterId: 7 });
    fake.seed("jobPosting", { tenantId: T, requisitionId: open.id, isActive: true });
    fake.seed("requisitionAgencyAssignment", { tenantId: T, agencyId: agency.id, requisitionId: open.id, status: "ACTIVE", maxSubmissions: 5, assignedById: 8 });
    W = { agency, other, open, scope: agencyScope(agency.id, [open.id]) };
});

afterAll(() => {
    if (previousFlag === undefined) delete process.env.HR_RECRUITMENT_AGENCY_PORTAL;
    else process.env.HR_RECRUITMENT_AGENCY_PORTAL = previousFlag;
});

const submit = (over = {}) =>
    asTenant(() => svc.submitAgencyCandidate({
        tenantId: T,
        scope: W.scope,
        userId: "u-1",
        input: { requisitionId: W.open.id, firstName: "Ann", lastName: "A", email: "ann@example.com", note: "fit", ...over },
        now: NOW,
    }));

describe("C8: every resume refusal has its own code and reason", () => {
    const refusal = (fn) => {
        try {
            fn();
        } catch (err) {
            return err;
        }
        throw new Error("expected a refusal");
    };

    it.each([
        ["a non-PDF type", resume({ mimeType: "image/png", fileName: "a.png", contentBase64: PNG }), "HR-RECRUITMENT-AGENCY-RESUME-NOT-PDF", "NOT_PDF"],
        ["a PDF type with another file's bytes", resume({ contentBase64: PNG }), "HR-RECRUITMENT-AGENCY-RESUME-NOT-PDF", "NOT_PDF"],
        ["a PDF type with another extension", resume({ fileName: "cv.exe" }), "HR-RECRUITMENT-AGENCY-RESUME-NOT-PDF", "NOT_PDF"],
        ["a file over 10 MB", resume({ contentBase64: "A".repeat(ONBOARDING_UPLOAD_MAX_BASE64_LENGTH + 4) }), "HR-RECRUITMENT-AGENCY-RESUME-TOO-LARGE", "TOO_LARGE"],
        ["an empty body", resume({ contentBase64: "" }), "HR-RECRUITMENT-AGENCY-RESUME-EMPTY", "EMPTY"],
        ["a body of line breaks only", resume({ contentBase64: "\r\n" }), "HR-RECRUITMENT-AGENCY-RESUME-EMPTY", "EMPTY"],
        ["no body at all", resume({ contentBase64: undefined }), "HR-RECRUITMENT-AGENCY-RESUME-EMPTY", "EMPTY"],
        ["a body that is not base64", resume({ contentBase64: "@@@@" }), "HR-RECRUITMENT-AGENCY-RESUME-INVALID", "MALFORMED"],
        ["a body that is not text", resume({ contentBase64: 42 }), "HR-RECRUITMENT-AGENCY-RESUME-INVALID", "MALFORMED"],
        ["a resume that is not an object", "x", "HR-RECRUITMENT-AGENCY-RESUME-INVALID", "MALFORMED"],
        ["a resume that is an array", [PDF], "HR-RECRUITMENT-AGENCY-RESUME-INVALID", "MALFORMED"],
    ])("%s", (_label, input, code, reason) => {
        const err = refusal(() => svc.normalizeAgencyResume(input));
        expect(err).toMatchObject({ status: 400, code, details: expect.objectContaining({ reason }) });
    });

    it("says how large a file may be on TOO_LARGE, and the message names 10 MB", () => {
        const err = refusal(() => svc.normalizeAgencyResume(resume({ contentBase64: "A".repeat(ONBOARDING_UPLOAD_MAX_BASE64_LENGTH + 4) })));
        expect(err.details).toEqual({ reason: "TOO_LARGE", maxBytes: ONBOARDING_UPLOAD_MAX_BYTES });
        expect(err.message).toMatch(/10 MB/);
    });

    it("reaches the client as HR-1001 with the domain code and the reason in details", async () => {
        const err = await submit({ resume: resume({ contentBase64: "" }) }).catch((e) => e);
        expect(toJsonRpcError(err).data).toEqual({ code: "HR-1001", details: { reason: "EMPTY", code: "HR-RECRUITMENT-AGENCY-RESUME-EMPTY" } });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
        expect(fake.all("agencySubmission")).toHaveLength(0);
    });

    it("still accepts a valid PDF", async () => {
        expect(svc.normalizeAgencyResume(resume())).toMatchObject({ mimeType: "application/pdf", fileName: "cv.pdf" });
        await submit({ resume: resume() });
        expect(fake.all("agencySubmission")[0].candidateSnapshot).toMatchObject({ resumeMediaId: 901, resumeSource: "AGENCY_UPLOAD" });
    });
});

describe("C8: the HR side names the DUPLICATE case", () => {
    it("codes the stored reason text (unchanged wording)", () => {
        expect(svc.duplicateReasonCode(svc.duplicateReasonFor({ application: { id: 5, sourceDetail: null }, submissionId: 1 }))).toBe("IN_PROCESS");
        const owned = svc.duplicateReasonFor({ candidate: { ownerAgencyId: 2, ownershipExpiresAt: new Date(NOW.getTime() + DAY) }, agencyId: 1, submissionId: 1, now: NOW });
        expect(owned).toMatch(/^Candidate owned by agency 2 until /);
        expect(svc.duplicateReasonCode(owned)).toBe("AGENCY_OWNED");
        expect(svc.duplicateReasonCode("Not a fit")).toBeNull();
        expect(svc.duplicateReasonCode(null)).toBeNull();
    });

    it("returns reasonCode on review and duplicateReasonCode on the HR list", async () => {
        fake.seed("candidate", { tenantId: T, firstName: "Ann", email: "ann@example.com", ownerAgencyId: W.other.id, ownershipExpiresAt: new Date(NOW.getTime() + DAY) });
        const sub = await submit();
        const out = await asTenant(() => svc.reviewAgencySubmission({ tenantId: T, actorId: 7, id: sub.id, decision: "ACCEPT", now: NOW }));
        expect(out).toMatchObject({ outcome: "DUPLICATE", reasonCode: "AGENCY_OWNED" });

        const list = await asTenant(() => svc.listAgencySubmissions({ tenantId: T }));
        expect(list.items[0]).toMatchObject({ status: "DUPLICATE", duplicateReasonCode: "AGENCY_OWNED", reviewedById: 7, reviewedByName: "Rita Recruiter" });
        // The agency's own view is unchanged: a neutral REJECTED, no code, no names.
        const own = await asTenant(() => svc.listOwnAgencySubmissions({ tenantId: T, scope: W.scope }));
        expect(own.items[0]).toMatchObject({ status: "REJECTED", rejectionReason: svc.AGENCY_NEUTRAL_REJECTION });
        expect(JSON.stringify(own.items[0])).not.toMatch(/AGENCY_OWNED|Rita|reviewedBy/);
    });

    it("a non-duplicate row has duplicateReasonCode null", async () => {
        await submit();
        const list = await asTenant(() => svc.listAgencySubmissions({ tenantId: T }));
        expect(list.items[0]).toMatchObject({ status: "PENDING_REVIEW", duplicateReasonCode: null, reviewedByName: null });
        // No reviewer yet: no employee lookup at all.
        expect(employeeQueries).toHaveLength(0);
    });
});

describe("C10: agency reads name the employees behind their ids", () => {
    it("lists agencies with createdByName; a foreign or unknown id reads null; one lookup", async () => {
        const page = await asTenant(() => admin.listAgencies({ tenantId: T }));
        const byName = Object.fromEntries(page.items.map((a) => [a.name, a]));
        expect(byName.Alpha).toMatchObject({ createdById: 7, createdByName: "Rita Recruiter" });
        // Employee 9 is another tenant's: the id stays, the name does not leak.
        expect(byName.Beta).toMatchObject({ createdById: 9, createdByName: null });
        expect(employeeQueries).toHaveLength(1);
        expect(employeeQueries[0]).toMatchObject({ tenant: T, where: { tenant_id: T } });
        expect(JSON.stringify(page)).not.toContain("rita@acme.test");
    });

    it("gets an agency with createdByName and assignedByName on each assignment, in one lookup", async () => {
        const agency = await asTenant(() => admin.getAgency({ tenantId: T, id: W.agency.id }));
        expect(agency).toMatchObject({ createdById: 7, createdByName: "Rita Recruiter" });
        expect(agency.assignments[0]).toMatchObject({ assignedById: 8, assignedByName: "Omar Ops" });
        expect(employeeQueries).toHaveLength(1);
        expect(employeeQueries[0].where.id.in.sort()).toEqual([7, 8]);
    });
});
