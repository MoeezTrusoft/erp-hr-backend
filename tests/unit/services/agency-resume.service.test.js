// Recruitment Phase 6 — an agency's resume is verified: the agency sends the
// PDF itself and this flow stores it in DAM under the tenant; a typed DAM media
// id is refused; a refused submission removes its upload; ACCEPT carries only
// a resume this flow uploaded onto the candidate.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { makeAgencyDb } from "./helpers/agency.fake.js";

let fake = makeAgencyDb();
const events = [];
const proxy = new Proxy({}, { get: (_t, key) => fake.db[key] });
const uploads = [];
const uploadFileToDAM = jest.fn(async (file, type) => {
    uploads.push({ file, type });
    return [{ id: 900 + uploads.length }];
});
const deleteDamAsset = jest.fn(async () => ({ ok: true }));

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: proxy, prisma: proxy }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: async () => undefined }));
jest.unstable_mockModule("../../../src/services/tagService.js", () => ({ upsertTags: async () => [] }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({
    computeRetentionUntil: async () => null,
    findActiveDnc: async () => null,
}));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: async (_tx, event) => {
        if (event) events.push(event);
        return event;
    },
}));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM, deleteDamAsset }));

const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { AGENCY_MEMBERSHIP, resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const svc = await import("../../../src/services/agency-submission.service.js");
const { normalizeError } = await import("../../../src/middlewares/error.middleware.js");

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const RECRUITER = { userId: "r-1", roles: ["RECRUITER"], employeeId: 7, tenantId: T };
const asTenant = (fn) => mcpCtx.run({ user: RECRUITER, permissions: {} }, fn);
const agencyScope = (agencyId, requisitionIds) =>
    resolveRecruitmentScope({ userId: "u-1", roles: ["AGENCY"], tenantId: T, [AGENCY_MEMBERSHIP]: { agencyId, tenantId: T, userId: "u-1", requisitionIds } });
const previousFlag = process.env.HR_RECRUITMENT_AGENCY_PORTAL;

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n").toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64");
const resume = (over = {}) => ({ fileName: "ann-cv.pdf", mimeType: "application/pdf", contentBase64: PDF, ...over });

let W;
beforeEach(() => {
    jest.clearAllMocks();
    uploads.length = 0;
    process.env.HR_RECRUITMENT_AGENCY_PORTAL = "true";
    fake = makeAgencyDb();
    events.length = 0;
    const agency = fake.seed("recruitmentAgency", { tenantId: T, name: "Alpha", ownershipDays: 30 });
    const open = fake.seed("jobRequisition", { tenantId: T, title: "Engineer", status: "POSTED", requestedById: 3, recruiterId: 7 });
    fake.seed("jobPosting", { tenantId: T, requisitionId: open.id, isActive: true });
    fake.seed("requisitionAgencyAssignment", { tenantId: T, agencyId: agency.id, requisitionId: open.id, status: "ACTIVE", maxSubmissions: 1 });
    W = { agency, open, scope: agencyScope(agency.id, [open.id]) };
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
const review = (id) => asTenant(() => svc.reviewAgencySubmission({ tenantId: T, actorId: 7, id, decision: "ACCEPT", now: NOW }));

describe("agency resume", () => {
    it("refuses a typed DAM media id and stores nothing", async () => {
        await expect(submit({ resumeMediaId: 55 })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-AGENCY-RESUME-UNVERIFIED" });
        expect(fake.all("agencySubmission")).toHaveLength(0);
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("uploads the PDF under the tenant's context and records it as an agency upload", async () => {
        let tenantAtUpload = null;
        uploadFileToDAM.mockImplementationOnce(async () => {
            tenantAtUpload = mcpCtx.getStore()?.user?.tenantId ?? null;
            return [{ id: 901 }];
        });
        await submit({ resume: resume() });
        expect(tenantAtUpload).toBe(T);
        expect(uploadFileToDAM).toHaveBeenCalledWith(expect.objectContaining({ mimetype: "application/pdf", originalname: "ann-cv.pdf" }), "document");
        expect(fake.all("agencySubmission")[0].candidateSnapshot).toMatchObject({ resumeMediaId: 901, resumeSource: "AGENCY_UPLOAD" });
    });

    it("refuses anything but a valid PDF before reaching DAM", async () => {
        for (const bad of [resume({ mimeType: "image/png", fileName: "a.png", contentBase64: PNG }), resume({ contentBase64: PNG }), resume({ fileName: "cv.exe" }), "x"]) {
            await expect(submit({ resume: bad })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-AGENCY-RESUME-INVALID" });
        }
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("answers a DAM failure as a retryable dependency error (HR-5032) and records nothing", async () => {
        uploadFileToDAM.mockResolvedValueOnce([]);
        const err = await submit({ resume: resume() }).catch((e) => e);
        expect(err).toMatchObject({ status: 502, code: "HR-RECRUITMENT-AGENCY-RESUME-UPLOAD-UNAVAILABLE" });
        expect(normalizeError(err)).toMatchObject({ code: "HR-5032", details: { code: "HR-RECRUITMENT-AGENCY-RESUME-UPLOAD-UNAVAILABLE", retryable: true } });
        expect(fake.all("agencySubmission")).toHaveLength(0);
    });

    it("removes the upload again when the submission is refused", async () => {
        await submit();
        await expect(submit({ email: "bob@example.com", resume: resume() })).rejects.toMatchObject({ code: "HR-RECRUITMENT-AGENCY-SUBMISSION-LIMIT" });
        expect(deleteDamAsset).toHaveBeenCalledWith(901);
    });

    it("ACCEPT puts an uploaded resume on the new candidate", async () => {
        const sub = await submit({ resume: resume() });
        await review(sub.id);
        expect(fake.all("candidate")[0]).toMatchObject({ resumeMediaId: 901 });
    });

    it("ACCEPT drops a Phase 5 snapshot's typed media id", async () => {
        const legacy = fake.seed("agencySubmission", {
            tenantId: T, agencyId: W.agency.id, requisitionId: W.open.id, submittedByUserId: "u-1", status: "PENDING_REVIEW",
            candidateSnapshot: { firstName: "Old", lastName: "O", email: "old@example.com", phone: null, resumeMediaId: 4242 },
        });
        await review(legacy.id);
        expect(fake.all("candidate")[0].resumeMediaId ?? null).toBeNull();
    });

    it("verifiedSnapshotResume trusts only this flow's uploads", () => {
        expect(svc.verifiedSnapshotResume({ resumeMediaId: 9, resumeSource: "AGENCY_UPLOAD" })).toBe(9);
        expect(svc.verifiedSnapshotResume({ resumeMediaId: 9 })).toBeNull();
        expect(svc.verifiedSnapshotResume({ resumeMediaId: "x", resumeSource: "AGENCY_UPLOAD" })).toBeNull();
        expect(svc.verifiedSnapshotResume(null)).toBeNull();
    });
});
