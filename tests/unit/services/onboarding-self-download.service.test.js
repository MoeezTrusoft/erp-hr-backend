// Recruitment Phase 6 — hr_self_onboarding_document_download: the new hire
// reads one of their OWN documents back from DAM (HR policies to sign and
// their own uploads), the owner check runs before DAM is asked, and every
// other id is the same 404.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

import { makeSelfPortalDb } from "./helpers/onboarding-self.fake.js";

const fake = { current: null };
const dbProxy = new Proxy({}, { get: (_t, key) => fake.current.db[key] });

const downloadDamAssetBuffer = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: dbProxy, prisma: dbProxy }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({
    uploadFileToDAM: jest.fn(),
    deleteDamAsset: jest.fn(),
    downloadDamAssetBuffer,
}));

const svc = await import("../../../src/services/onboarding-self.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const HIRE = 101;
const OTHER = 102;

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

const asUser = (fn, { tenantId = T1, employeeId = HIRE } = {}) =>
    mcpCtx.run({ user: { tenantId, employeeId } }, async () => await fn());
const download = (documentId, { tenantId = T1, employeeId = HIRE } = {}) =>
    asUser(() => svc.downloadMyDocument({ tenantId, employeeId, documentId }), { tenantId, employeeId });

const failure = async (promise) => {
    try {
        await promise;
    } catch (err) {
        return { status: err.status, code: err.code, message: err.message };
    }
    throw new Error("expected a failure");
};

let ids;
function seedWorld() {
    const f = makeSelfPortalDb();
    fake.current = f;
    f.seed("employee", { id: HIRE, tenant_id: T1, employee_name: "Ayesha Khan" });
    f.seed("employee", { id: OTHER, tenant_id: T1, employee_name: "Someone Else" });
    f.seed("employee", { id: 201, tenant_id: T2, employee_name: "Other tenant" });

    const mine = f.seed("onboardingChecklist", { tenantId: T1, employeeId: HIRE, status: "IN_PROGRESS", startDate: new Date("2026-11-02") });
    const myOld = f.seed("onboardingChecklist", { tenantId: T1, employeeId: HIRE, status: "COMPLETED", startDate: new Date("2025-01-06") });
    const theirs = f.seed("onboardingChecklist", { tenantId: T1, employeeId: OTHER, status: "IN_PROGRESS", startDate: new Date("2026-11-02") });
    const otherTenant = f.seed("onboardingChecklist", { tenantId: T2, employeeId: HIRE, status: "IN_PROGRESS", startDate: new Date("2026-11-02") });

    const doc = (checklistId, employeeId, extra = {}, tenantId = T1) =>
        f.seed("onboardingDocument", { tenantId, checklistId, employeeId, title: "Doc", ...extra });
    ids = {
        policy: doc(mine.id, HIRE, { title: "Code of conduct", mediaId: 11, requiresSign: true }).id,
        upload: doc(mine.id, HIRE, { title: "CNIC front", mediaId: 12, source: "NEW_HIRE", reviewStatus: "PENDING" }).id,
        oldPolicy: doc(myOld.id, HIRE, { title: "Old handbook", mediaId: 13, requiresSign: true, signedAt: new Date("2025-01-07") }).id,
        theirs: doc(theirs.id, OTHER, { title: "Their policy", mediaId: 14, requiresSign: true }).id,
        misfiled: doc(mine.id, OTHER, { title: "Misfiled", mediaId: 15 }).id,
        mineButNamedMe: doc(theirs.id, HIRE, { title: "On their checklist", mediaId: 16 }).id,
        otherTenant: doc(otherTenant.id, HIRE, { title: "Other tenant", mediaId: 17 }, T2).id,
        noMedia: doc(mine.id, HIRE, { title: "No file", mediaId: 0 }).id,
    };
    return f;
}

const ORIGINAL_FLAG = process.env.HR_ONBOARDING_SELF_PORTAL;
beforeEach(() => {
    process.env.HR_ONBOARDING_SELF_PORTAL = "true";
    jest.clearAllMocks();
    downloadDamAssetBuffer.mockResolvedValue({ buffer: PDF, mimeType: "application/octet-stream", fileName: "code-of-conduct.pdf" });
    seedWorld();
});
afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.HR_ONBOARDING_SELF_PORTAL;
    else process.env.HR_ONBOARDING_SELF_PORTAL = ORIGINAL_FLAG;
});

describe("downloadMyDocument", () => {
    it("answers 503 -DISABLED while the flag is off, before any read", async () => {
        process.env.HR_ONBOARDING_SELF_PORTAL = "false";
        expect(await failure(download(ids.policy))).toMatchObject({ status: 503, code: "HR-ONBOARDING-SELF-PORTAL-DISABLED" });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });

    it("returns an HR policy to sign as base64 with the sniffed type and DAM's file name", async () => {
        const out = await download(ids.policy);
        expect(downloadDamAssetBuffer).toHaveBeenCalledWith(11);
        expect(out).toEqual({
            document: expect.objectContaining({ id: ids.policy, title: "Code of conduct", source: "HR", requiresSign: true, signed: false, mediaId: 11 }),
            fileName: "code-of-conduct.pdf",
            mimeType: "application/pdf",
            size: PDF.length,
            contentBase64: PDF.toString("base64"),
        });
        expect(Buffer.from(out.contentBase64, "base64").equals(PDF)).toBe(true);
    });

    it("returns the caller's own upload; DAM's placeholder name falls back to the title with the sniffed extension", async () => {
        downloadDamAssetBuffer.mockResolvedValue({ buffer: PNG, mimeType: "image/png; charset=binary", fileName: "asset-12" });
        const out = await download(ids.upload);
        expect(out).toMatchObject({ fileName: "CNIC front.png", mimeType: "image/png", size: PNG.length });
        expect(out.document).toMatchObject({ source: "NEW_HIRE", reviewStatus: "PENDING" });
    });

    it("keeps DAM's content type for a type it does not sniff, and never echoes a malformed one", async () => {
        downloadDamAssetBuffer.mockResolvedValue({ buffer: Buffer.from("PK\u0003\u0004rest"), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName: "handbook.docx" });
        await expect(download(ids.policy)).resolves.toMatchObject({ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName: "handbook.docx" });
        downloadDamAssetBuffer.mockResolvedValue({ buffer: Buffer.from("plain"), mimeType: "<script>", fileName: null });
        await expect(download(ids.policy)).resolves.toMatchObject({ mimeType: "application/octet-stream", fileName: "Code of conduct" });
    });

    it("a document on the caller's completed checklist can still be read", async () => {
        await expect(download(ids.oldPolicy)).resolves.toMatchObject({ document: expect.objectContaining({ signed: true }) });
    });

    it("every id that is not the caller's is the same 404, and DAM is never asked", async () => {
        const missing = 999_999;
        const results = [];
        for (const id of [ids.theirs, ids.misfiled, ids.mineButNamedMe, ids.otherTenant, ids.noMedia, missing]) {
            results.push(await failure(download(id)));
        }
        for (const r of results) expect(r).toEqual({ status: 404, code: "HR-ONBOARDING-NOT-FOUND", message: "Document not found" });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });

    it("another hire asking for the first hire's document gets the same 404", async () => {
        expect(await failure(download(ids.policy, { employeeId: OTHER }))).toMatchObject({ status: 404, code: "HR-ONBOARDING-NOT-FOUND" });
        expect(downloadDamAssetBuffer).not.toHaveBeenCalled();
    });

    it("a bad id is 400 and a session with no employee row is the calm 400", async () => {
        expect(await failure(download("abc"))).toMatchObject({ status: 400, code: "HR-ONBOARDING-INVALID-ID" });
        expect(await failure(download(ids.policy, { employeeId: 555 }))).toMatchObject({ status: 400, code: "HR-ONBOARDING-SELF-NO-EMPLOYEE" });
    });

    it("DAM with no content (or a throw) is 502 -DAM-UNAVAILABLE", async () => {
        downloadDamAssetBuffer.mockResolvedValue(null);
        expect(await failure(download(ids.policy))).toMatchObject({ status: 502, code: "HR-ONBOARDING-DAM-UNAVAILABLE" });
        downloadDamAssetBuffer.mockResolvedValue({ buffer: Buffer.alloc(0) });
        expect(await failure(download(ids.policy))).toMatchObject({ status: 502, code: "HR-ONBOARDING-DAM-UNAVAILABLE" });
        downloadDamAssetBuffer.mockRejectedValue(new Error("socket hang up"));
        expect(await failure(download(ids.policy))).toMatchObject({ status: 502, code: "HR-ONBOARDING-DAM-UNAVAILABLE" });
    });

    it("a file over the bound is refused with 413 and no content", async () => {
        const big = Buffer.alloc(svc.DOCUMENT_DOWNLOAD_MAX_BYTES + 1, 0);
        PDF.copy(big);
        downloadDamAssetBuffer.mockResolvedValue({ buffer: big, mimeType: "application/pdf", fileName: "big.pdf" });
        expect(await failure(download(ids.policy))).toMatchObject({ status: 413, code: "HR-ONBOARDING-DOCUMENT-TOO-LARGE" });
    });

    it("writes nothing", async () => {
        await download(ids.policy);
        expect(fake.current.events()).toHaveLength(0);
    });
});
