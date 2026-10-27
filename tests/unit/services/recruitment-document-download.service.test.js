// Recruitment Phase 7 (B7) — the DAM read path for recruitment documents:
// the shared reader (type sniffing, the 15 MB cap, a DAM outage as HR-5032)
// and the three record checks that run BEFORE anything reaches DAM: the offer
// letter (compensation scopes, the offer's own media), the interview packet
// (recruiters, or the panelist's own view) and the test item picture (item
// bank visibility).
import { describe, it, expect, beforeEach, afterAll, jest } from "@jest/globals";

const prisma = {
    offer: { findFirst: jest.fn() },
    offerLetterVersion: { findFirst: jest.fn() },
    interview: { findFirst: jest.fn() },
    interviewInterviewer: { findFirst: jest.fn() },
    interviewPacketItem: { findMany: jest.fn() },
    candidateTestItem: { findFirst: jest.fn() },
};
const downloadDamAssetBuffer = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => null) }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({
    downloadDamAssetBuffer,
    uploadFileToDAM: jest.fn(async () => []),
    deleteDamAsset: jest.fn(),
    getDamAssetById: jest.fn(),
}));

const { readRecruitmentDocument, RECRUITMENT_DOWNLOAD_MAX_BYTES } = await import("../../../src/services/recruitment-document-download.service.js");
const { downloadOfferLetter } = await import("../../../src/services/offer-letter.service.js");
const { downloadPacketDocument } = await import("../../../src/services/interview-packet.service.js");
const { downloadTestItemPicture } = await import("../../../src/services/test-item.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");
const { normalizeError } = await import("../../../src/middlewares/error.middleware.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const PDF = Buffer.from("%PDF-1.4\n% letter\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const ORG = resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: 9 });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 11 });
const MANAGED = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 7 });
const ASSIGNED = resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 3 });

const FLAGS = ["HR_RECRUITMENT_OFFER_LETTERS", "HR_RECRUITMENT_ONSITE_TEST"];
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of FLAGS) process.env[k] = "true";
    downloadDamAssetBuffer.mockResolvedValue({ buffer: PDF, mimeType: "application/octet-stream", fileName: "asset-41" });
});

afterAll(() => {
    for (const k of FLAGS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe("readRecruitmentDocument", () => {
    it("returns base64 with the sniffed type and the fallback name over DAM's placeholder", async () => {
        const file = await readRecruitmentDocument({ mediaId: 41, fallbackName: "offer-5-letter.pdf" });
        expect(file).toEqual({ fileName: "offer-5-letter.pdf", mimeType: "application/pdf", size: PDF.length, contentBase64: PDF.toString("base64") });
        expect(downloadDamAssetBuffer).toHaveBeenCalledWith(41);
    });

    it("keeps DAM's real file name and adds the sniffed extension to a bare fallback", async () => {
        downloadDamAssetBuffer.mockResolvedValueOnce({ buffer: PNG, mimeType: "image/png", fileName: "diagram.png" });
        await expect(readRecruitmentDocument({ mediaId: 2 })).resolves.toMatchObject({ fileName: "diagram.png", mimeType: "image/png" });
        downloadDamAssetBuffer.mockResolvedValueOnce({ buffer: PNG, mimeType: null, fileName: "asset-2" });
        await expect(readRecruitmentDocument({ mediaId: 2, fallbackName: "Q-1-v2-picture" })).resolves.toMatchObject({ fileName: "Q-1-v2-picture.png" });
    });

    it("a DAM outage (null or a throw) is 502 -UNAVAILABLE, which clients see as HR-5032", async () => {
        downloadDamAssetBuffer.mockResolvedValueOnce(null);
        const err = await readRecruitmentDocument({ mediaId: 41 }).catch((e) => e);
        expect(err).toMatchObject({ status: 502, code: "HR-RECRUITMENT-DOCUMENT-UNAVAILABLE" });
        expect(normalizeError(err)).toMatchObject({ code: "HR-5032", details: { code: "HR-RECRUITMENT-DOCUMENT-UNAVAILABLE", retryable: true } });

        downloadDamAssetBuffer.mockRejectedValueOnce(new Error("socket hang up"));
        await expect(readRecruitmentDocument({ mediaId: 41 })).rejects.toMatchObject({ status: 502, code: "HR-RECRUITMENT-DOCUMENT-UNAVAILABLE" });
    });

    it("refuses a file over the cap (413) and a missing media id (404)", async () => {
        downloadDamAssetBuffer.mockResolvedValueOnce({ buffer: Buffer.alloc(RECRUITMENT_DOWNLOAD_MAX_BYTES + 1), mimeType: "application/pdf" });
        await expect(readRecruitmentDocument({ mediaId: 41 })).rejects.toMatchObject({ status: 413, code: "HR-RECRUITMENT-DOCUMENT-TOO-LARGE" });
        await expect(readRecruitmentDocument({ mediaId: null })).rejects.toMatchObject({ status: 404 });
    });
});

describe("downloadOfferLetter", () => {
    const offer = { id: 5, offerLetterMediaId: 41 };

    it("opens the offer's current letter for a recruiter", async () => {
        prisma.offer.findFirst.mockResolvedValue(offer);
        const result = await downloadOfferLetter({ tenantId: TENANT, scope: ORG, offerId: 5 });
        expect(result).toMatchObject({ offerId: 5, versionId: null, signed: false, mimeType: "application/pdf", fileName: "offer-5-letter.pdf" });
        expect(prisma.offer.findFirst.mock.calls[0][0].where).toMatchObject({ id: 5, tenantId: TENANT });
        expect(downloadDamAssetBuffer).toHaveBeenCalledWith(41);
    });

    it("finance may open it too; a hiring manager may not (the letter shows the salary)", async () => {
        prisma.offer.findFirst.mockResolvedValue(offer);
        await expect(downloadOfferLetter({ tenantId: TENANT, scope: FINANCE, offerId: 5 })).resolves.toMatchObject({ offerId: 5 });
        downloadDamAssetBuffer.mockClear();
        await expect(downloadOfferLetter({ tenantId: TENANT, scope: MANAGED, offerId: 5 }))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-OFFER-LETTER-FORBIDDEN" });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });

    it("an unknown or out-of-scope offer, or one with no letter, is 404 without a DAM call", async () => {
        prisma.offer.findFirst.mockResolvedValueOnce(null);
        await expect(downloadOfferLetter({ tenantId: TENANT, scope: ORG, offerId: 6 })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-OFFER-NOT-FOUND" });
        prisma.offer.findFirst.mockResolvedValueOnce({ id: 5, offerLetterMediaId: null });
        await expect(downloadOfferLetter({ tenantId: TENANT, scope: ORG, offerId: 5 })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-OFFER-LETTER-NOT-FOUND" });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });

    it("a version must belong to this offer; signed reads the version's signed copy", async () => {
        prisma.offer.findFirst.mockResolvedValue(offer);
        prisma.offerLetterVersion.findFirst.mockResolvedValueOnce({ id: 70, offerId: 5, version: 2, mediaId: 42, signedMediaId: 43 });
        const signed = await downloadOfferLetter({ tenantId: TENANT, scope: ORG, offerId: 5, versionId: 70, signed: true });
        expect(prisma.offerLetterVersion.findFirst.mock.calls[0][0].where).toMatchObject({ id: 70, offerId: 5, tenantId: TENANT });
        expect(downloadDamAssetBuffer).toHaveBeenCalledWith(43);
        expect(signed).toMatchObject({ versionId: 70, version: 2, signed: true, fileName: "offer-5-letter-v2-signed.pdf" });

        prisma.offerLetterVersion.findFirst.mockResolvedValueOnce(null);
        await expect(downloadOfferLetter({ tenantId: TENANT, scope: ORG, offerId: 5, versionId: 71 })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-OFFER-LETTER-NOT-FOUND" });
        prisma.offerLetterVersion.findFirst.mockResolvedValueOnce({ id: 70, offerId: 5, version: 2, mediaId: 42, signedMediaId: null });
        await expect(downloadOfferLetter({ tenantId: TENANT, scope: ORG, offerId: 5, signed: true })).rejects.toMatchObject({ status: 404 });
    });

    it("versions need the offerLetters flag (503 -DISABLED)", async () => {
        process.env.HR_RECRUITMENT_OFFER_LETTERS = "false";
        prisma.offer.findFirst.mockResolvedValue(offer);
        await expect(downloadOfferLetter({ tenantId: TENANT, scope: ORG, offerId: 5, versionId: 70 }))
            .rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-OFFER-LETTERS-DISABLED" });
    });
});

describe("downloadPacketDocument", () => {
    const interviewRow = { id: 500, tenantId: TENANT, applicationId: 900, application: { id: 900, candidateId: 77, candidate: { id: 77, resumeMediaId: 61 } } };
    const items = [
        { id: 1, interviewId: 500, mediaId: 62, docClass: "PORTFOLIO", label: "Portfolio" },
        { id: 2, interviewId: 500, mediaId: 63, docClass: "INTERVIEW_BRIEF", label: "Brief" },
    ];

    beforeEach(() => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow);
        prisma.interviewPacketItem.findMany.mockResolvedValue(items);
        prisma.interviewInterviewer.findFirst.mockResolvedValue({ employeeId: 3 });
    });

    it("a recruiter opens a packet item by id and the resume by media id", async () => {
        const byItem = await downloadPacketDocument({ interviewId: 500, itemId: 1, tenantId: TENANT, scope: ORG });
        expect(byItem.item).toEqual({ id: 1, docClass: "PORTFOLIO", label: "Portfolio", source: "PACKET", mediaId: 62 });
        expect(downloadDamAssetBuffer).toHaveBeenLastCalledWith(62);
        const resume = await downloadPacketDocument({ interviewId: 500, mediaId: 61, tenantId: TENANT, scope: ORG });
        expect(resume.item).toMatchObject({ docClass: "RESUME", source: "CANDIDATE_RECORD" });
        expect(downloadDamAssetBuffer).toHaveBeenLastCalledWith(61);
    });

    it("an assigned panelist opens a document of their own view", async () => {
        const result = await downloadPacketDocument({ interviewId: 500, itemId: 2, tenantId: TENANT, scope: ASSIGNED, viewerEmployeeId: 3 });
        expect(result).toMatchObject({ interviewId: 500, item: { id: 2, docClass: "INTERVIEW_BRIEF" } });
        expect(prisma.interviewInterviewer.findFirst.mock.calls[0][0].where).toMatchObject({ interviewId: 500, employeeId: 3, tenantId: TENANT });
    });

    it("someone not on the panel, a media id of another record, or a bad pick never reaches DAM", async () => {
        prisma.interviewInterviewer.findFirst.mockResolvedValueOnce(null);
        await expect(downloadPacketDocument({ interviewId: 500, itemId: 1, tenantId: TENANT, scope: MANAGED, viewerEmployeeId: 7 }))
            .rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-PACKET-NOT-FOUND" });
        await expect(downloadPacketDocument({ interviewId: 500, mediaId: 999, tenantId: TENANT, scope: ORG }))
            .rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-PACKET-NOT-FOUND" });
        await expect(downloadPacketDocument({ interviewId: 500, itemId: 1, mediaId: 62, tenantId: TENANT, scope: ORG }))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-PACKET-DOCUMENT-INVALID" });
        await expect(downloadPacketDocument({ interviewId: 500, tenantId: TENANT, scope: ORG }))
            .rejects.toMatchObject({ status: 400 });
        prisma.interview.findFirst.mockResolvedValueOnce(null);
        await expect(downloadPacketDocument({ interviewId: 501, itemId: 1, tenantId: TENANT, scope: ORG })).rejects.toMatchObject({ status: 404 });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });
});

describe("downloadTestItemPicture", () => {
    const item = { id: 30, tenantId: TENANT, itemCode: "Q-SQL-1", version: 2, status: "DRAFT", authorId: 15, mediaId: 81 };

    it("an author opens their own item's picture; the read carries their visibility", async () => {
        downloadDamAssetBuffer.mockResolvedValueOnce({ buffer: PNG, mimeType: "image/png", fileName: "asset-81" });
        prisma.candidateTestItem.findFirst.mockResolvedValue(item);
        const access = resolveAssessmentAccess({ roles: ["ASSESSMENT_AUTHOR"], employeeId: 15 });
        const result = await downloadTestItemPicture({ tenantId: TENANT, access, itemId: 30 });
        expect(result).toMatchObject({ itemId: 30, itemCode: "Q-SQL-1", version: 2, mimeType: "image/png", fileName: "Q-SQL-1-v2-picture.png" });
        const where = prisma.candidateTestItem.findFirst.mock.calls[0][0].where;
        expect(JSON.stringify(where)).toContain('"authorId":15');
        expect(where.tenantId).toBe(TENANT);
    });

    it("reviewers and recruiters may; hiring managers and interviewers may not", async () => {
        prisma.candidateTestItem.findFirst.mockResolvedValue(item);
        await expect(downloadTestItemPicture({ tenantId: TENANT, access: resolveAssessmentAccess({ roles: ["ASSESSMENT_REVIEWER"], employeeId: 16 }), itemId: 30 }))
            .resolves.toMatchObject({ itemId: 30 });
        await expect(downloadTestItemPicture({ tenantId: TENANT, access: resolveAssessmentAccess({ roles: ["RECRUITER"], employeeId: 9 }), itemId: 30 }))
            .resolves.toMatchObject({ itemId: 30 });
        downloadDamAssetBuffer.mockClear();
        for (const roles of [["HIRING_MANAGER"], ["INTERVIEWER"]]) {
            await expect(downloadTestItemPicture({ tenantId: TENANT, access: resolveAssessmentAccess({ roles, employeeId: 7 }), itemId: 30 }))
                .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN" });
        }
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });

    it("an item without a picture, or out of sight, is 404; the onsiteTest flag gates it", async () => {
        const access = resolveAssessmentAccess({ roles: ["RECRUITER"], employeeId: 9 });
        prisma.candidateTestItem.findFirst.mockResolvedValueOnce({ ...item, mediaId: null });
        await expect(downloadTestItemPicture({ tenantId: TENANT, access, itemId: 30 })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-TEST-ITEM-PICTURE-NOT-FOUND" });
        prisma.candidateTestItem.findFirst.mockResolvedValueOnce(null);
        await expect(downloadTestItemPicture({ tenantId: TENANT, access, itemId: 31 })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-TEST-ITEM-NOT-FOUND" });
        process.env.HR_RECRUITMENT_ONSITE_TEST = "false";
        await expect(downloadTestItemPicture({ tenantId: TENANT, access, itemId: 30 })).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });
});
