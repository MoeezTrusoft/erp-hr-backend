// Recruitment Phase 7 (A6) — the careers resume upload. Pinned: PDF only with
// the portal upload rules (signature, size, extension); the file is stored in
// DAM under the pinned tenant before an opaque reference is answered (never
// the media id); the reference is good only in the issuing tenant, only until
// it expires, and cannot be read or forged; a draft token binds it to a live
// draft of the same tenant; nothing is stored when anything refuses first.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-27T09:00:00.000Z");
const HOUR = 3_600_000;

const drafts = [];
const contexts = [];
const lazy = (fn) => ({ then: (ok, err) => Promise.resolve().then(fn).then(ok, err) });
const prisma = {
    applicationDraft: {
        findFirst: jest.fn(({ where }) => lazy(() => {
            contexts.push(mcpCtx.getStore()?.user?.tenantId ?? null);
            const row = drafts.find((d) => d.tokenHash === where.tokenHash && d.tenantId === where.tenantId);
            return row ? structuredClone(row) : null;
        })),
    },
};
const uploadFileToDAM = jest.fn(async () => [{ id: 4242 }]);
let portalOn = true;

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM }));
jest.unstable_mockModule("../../../src/lib/recruitment-flags.util.js", () => ({ isRecruitmentFlagEnabled: (key) => key === "portal" && portalOn }));

const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const svc = await import("../../../src/services/portal-resume-upload.service.js");

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]).toString("base64");
const resume = (over = {}) => ({ fileName: "Ayesha CV.pdf", mimeType: "application/pdf", contentBase64: PDF, ...over });
const inTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId }, portal: true }, async () => await fn());
const upload = (over = {}) => inTenant(() => svc.uploadPortalResume({ tenantId: TENANT, resume: resume(), now: NOW, ...over }));

beforeEach(() => {
    jest.clearAllMocks();
    drafts.length = 0;
    contexts.length = 0;
    portalOn = true;
    process.env.HR_PORTAL_RESUME_REF_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => {
    delete process.env.HR_PORTAL_RESUME_REF_KEY;
    delete process.env.HR_C4_ENCRYPTION_KEY;
});

describe("uploadPortalResume", () => {
    it("stores the PDF in DAM and answers an opaque reference, never the media id", async () => {
        const out = await upload();
        expect(uploadFileToDAM).toHaveBeenCalledTimes(1);
        const [file, type] = uploadFileToDAM.mock.calls[0];
        expect(type).toBe("document");
        expect(file).toMatchObject({ mimetype: "application/pdf", originalname: "Ayesha CV.pdf" });
        expect(file.buffer.subarray(0, 5).toString()).toBe("%PDF-");
        expect(out).toMatchObject({ fileName: "Ayesha CV.pdf", boundToDraft: false, expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString() });
        expect(out.resumeRef).toMatch(/^pr1\.[A-Za-z0-9_-]+$/);
        expect(JSON.stringify(out)).not.toMatch(/4242|mediaId/);
        expect(svc.readPortalResumeRef(out.resumeRef, { tenantId: TENANT, now: NOW })).toMatchObject({ mediaId: 4242, draftId: null, fileName: "Ayesha CV.pdf" });
    });

    it.each([
        ["a DOCX", { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName: "cv.docx" }, "TYPE"],
        ["a renamed executable", { contentBase64: Buffer.from("MZ\x90\x00not a pdf").toString("base64") }, "SIGNATURE"],
        ["a PDF type with a .png name", { fileName: "cv.png" }, "EXTENSION"],
        ["broken base64", { contentBase64: "%%%%" }, "CONTENT"],
        ["more than 10 MB", { contentBase64: "A".repeat(14_000_000) }, "TOO_LARGE"],
    ])("refuses %s with a coded reason and stores nothing", async (_label, over, reason) => {
        const err = await upload({ resume: resume(over) }).catch((e) => e);
        expect(err).toMatchObject({ status: 400, code: "HR-RECRUITMENT-PORTAL-RESUME-INVALID", details: { code: "HR-RECRUITMENT-PORTAL-RESUME-INVALID", reason } });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("binds the reference to a live draft of the same tenant, read under that tenant", async () => {
        drafts.push({ id: 31, tenantId: TENANT, tokenHash: svc.hashDraftToken("draft-token"), submittedAt: null, expiresAt: new Date(NOW.getTime() + HOUR), candidate: { anonymizedAt: null, status: "active" } });
        const out = await upload({ draftToken: "draft-token" });
        expect(out.boundToDraft).toBe(true);
        expect(svc.readPortalResumeRef(out.resumeRef, { tenantId: TENANT, now: NOW }).draftId).toBe(31);
        expect(contexts).toEqual([TENANT]);
    });

    it("refuses a dead, submitted, expired or other-tenant draft token before storing anything", async () => {
        const base = { tokenHash: svc.hashDraftToken("t"), expiresAt: new Date(NOW.getTime() + HOUR), submittedAt: null, candidate: { anonymizedAt: null, status: "active" } };
        const cases = [
            [],
            [{ ...base, id: 1, tenantId: OTHER }],
            [{ ...base, id: 2, tenantId: TENANT, submittedAt: NOW }],
            [{ ...base, id: 3, tenantId: TENANT, expiresAt: NOW }],
            [{ ...base, id: 4, tenantId: TENANT, candidate: { anonymizedAt: NOW, status: "active" } }],
        ];
        for (const rows of cases) {
            drafts.length = 0;
            drafts.push(...rows);
            await expect(upload({ draftToken: "t" })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-INVALID" });
        }
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("a DAM outage is a 503 to try again; no key fails closed before DAM", async () => {
        uploadFileToDAM.mockResolvedValueOnce([]);
        await expect(upload()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-PORTAL-RESUME-UNAVAILABLE" });
        uploadFileToDAM.mockClear();
        delete process.env.HR_PORTAL_RESUME_REF_KEY;
        await expect(upload()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-PORTAL-RESUME-UNAVAILABLE" });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("is the uniform 404 while the portal is off", async () => {
        portalOn = false;
        await expect(upload()).rejects.toMatchObject({ status: 404 });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });
});

describe("the reference", () => {
    const mint = (over = {}) => svc.issuePortalResumeRef({ tenantId: TENANT, mediaId: 77, fileName: "cv.pdf", now: NOW, ...over }).resumeRef;

    it("is only good in the issuing tenant", () => {
        expect(() => svc.readPortalResumeRef(mint(), { tenantId: OTHER, now: NOW })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID", status: 400 }));
    });

    it("expires after 24 hours", () => {
        const ref = mint();
        expect(svc.readPortalResumeRef(ref, { tenantId: TENANT, now: new Date(NOW.getTime() + 24 * HOUR - 1) }).mediaId).toBe(77);
        expect(() => svc.readPortalResumeRef(ref, { tenantId: TENANT, now: new Date(NOW.getTime() + 24 * HOUR) }))
            .toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PORTAL-RESUME-REF-EXPIRED" }));
    });

    it("cannot be read, altered or forged", () => {
        const ref = mint();
        // The claims (and so the media id) are not visible in the reference.
        expect(Buffer.from(ref.slice(4), "base64url").toString("latin1")).not.toContain('"m":');
        const flipped = `${ref.slice(0, -2)}${ref.at(-2) === "A" ? "B" : "A"}${ref.at(-1)}`;
        for (const bad of [flipped, "pr1.", "pr1.AAAA", "nope", 55, null, `pr1.${"A".repeat(2000)}`]) {
            expect(() => svc.readPortalResumeRef(bad, { tenantId: TENANT, now: NOW })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID" }));
        }
        // Another key's reference is a forgery.
        process.env.HR_PORTAL_RESUME_REF_KEY = Buffer.alloc(32, 9).toString("base64");
        expect(() => svc.readPortalResumeRef(ref, { tenantId: TENANT, now: NOW })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID" }));
    });

    it("falls back to a label-bound key derived from the C4 key", () => {
        delete process.env.HR_PORTAL_RESUME_REF_KEY;
        process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
        expect(svc.readPortalResumeRef(mint(), { tenantId: TENANT, now: NOW }).mediaId).toBe(77);
    });
});

describe("resumeMediaIdForApply (POST /jobs/:id/apply)", () => {
    it("takes an unbound reference of this tenant, refuses a typed id and a draft-bound reference", () => {
        const ref = svc.issuePortalResumeRef({ tenantId: TENANT, mediaId: 88, fileName: "cv.pdf", now: NOW }).resumeRef;
        expect(svc.resumeMediaIdForApply({ tenantId: TENANT, body: { resumeRef: ref }, now: NOW })).toBe(88);
        expect(svc.resumeMediaIdForApply({ tenantId: TENANT, body: {}, now: NOW })).toBeNull();
        expect(() => svc.resumeMediaIdForApply({ tenantId: TENANT, body: { resumeMediaId: 88 }, now: NOW }))
            .toThrow(expect.objectContaining({ status: 400, code: "HR-RECRUITMENT-PORTAL-RESUME-UNVERIFIED" }));
        const bound = svc.issuePortalResumeRef({ tenantId: TENANT, mediaId: 88, fileName: "cv.pdf", draftId: 5, now: NOW }).resumeRef;
        expect(() => svc.resumeMediaIdForApply({ tenantId: TENANT, body: { resumeRef: bound }, now: NOW }))
            .toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-MISMATCH" }));
        expect(() => svc.resumeMediaIdForApply({ tenantId: OTHER, body: { resumeRef: ref }, now: NOW }))
            .toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID" }));
    });
});
