// Recruitment Phase 7 (A6) — the careers draft carries only a VERIFIED resume.
// Pinned: a typed resumeMediaId is a 400; a resumeRef must be this tenant's and
// live; a draft-bound reference only saves onto that draft (checked before the
// do-not-contact probe, so the answer is the same for a register hit); the
// save keeps the media id on the row with the PORTAL_UPLOAD marker; the load
// hands back a fresh draft-bound reference and never a media id; the submit
// carries only a verified resume into the intake.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DNC_ROW = { id: 9, email: "ayesha@example.com", reasonCode: "CANDIDATE_REQUEST", scope: "ALL", status: "ACTIVE" };

const rows = { drafts: [] };
const state = { dnc: null };
let seq = 1;

const withRelations = (row) => row && {
    ...structuredClone(row),
    candidate: { id: row.candidateId, firstName: "Ayesha", email: row.email ?? "ayesha@example.com", anonymizedAt: null, status: "active" },
};
const prisma = {
    candidate: {
        findFirst: jest.fn(async () => ({ id: 7, firstName: "Ayesha" })),
        create: jest.fn(async ({ data }) => ({ id: 50, firstName: data.firstName })),
    },
    applicationDraft: {
        upsert: jest.fn(async ({ where, create, update }) => {
            const key = where.candidateId_requisitionId;
            const existing = rows.drafts.find((d) => d.candidateId === key.candidateId && d.requisitionId === key.requisitionId);
            if (existing) return Object.assign(existing, structuredClone(update));
            const row = { id: seq++, submittedAt: null, ...structuredClone(create) };
            rows.drafts.push(row);
            return row;
        }),
        findUnique: jest.fn(async ({ where }) => withRelations(rows.drafts.find((d) => d.tokenHash === where.tokenHash))),
        findFirst: jest.fn(async ({ where }) => withRelations(rows.drafts.find((d) => d.id === where.id && d.tenantId === where.tenantId))),
        update: jest.fn(async ({ where, data }) => Object.assign(rows.drafts.find((d) => d.id === where.id), data)),
    },
    candidateDncEntry: { findFirst: jest.fn(async () => state.dnc) },
    jobRequisition: { findFirst: jest.fn(async ({ where }) => ({ id: where.id, title: "Backend Engineer", tenantId: where.tenantId })) },
};

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn((client, fn) => fn(client)),
    rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../../src/lib/notificationClient.js", () => ({ sendCandidateEmail: jest.fn(async () => ({ sent: true })) }));
jest.unstable_mockModule("../../../src/lib/recruitmentFlags.js", () => ({ isRecruitmentFlagEnabled: jest.fn(() => true) }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({
    uploadFileToDAM: jest.fn(),
    deleteDamAsset: jest.fn(),
    getDamAssetById: jest.fn(),
    downloadDamAssetBuffer: jest.fn(),
    normalizeDamAssetResponse: jest.fn(),
    damRequest: jest.fn(),
}));
const submitPublicApplication = jest.fn(async () => ({ received: true, requisitionId: 5 }));
jest.unstable_mockModule("../../../src/services/publicPortal.service.js", () => ({ submitPublicApplication }));

const { sendCandidateEmail } = await import("../../../src/lib/notificationClient.js");
const drafts = await import("../../../src/services/applicationDraft.service.js");
const refs = await import("../../../src/services/portal-resume-upload.service.js");

const ref = (over = {}) => refs.issuePortalResumeRef({ tenantId: TENANT, mediaId: 4242, fileName: "cv.pdf", ...over }).resumeRef;
const save = (body = {}, over = {}) => drafts.saveApplicationDraft({
    tenantId: TENANT, requisitionId: 5, email: "ayesha@example.com", body: { firstName: "Ayesha", ...body }, ...over,
});
const tokenOfLastEmail = () => new URL(sendCandidateEmail.mock.calls.at(-1)[0].data.draftUrl, "https://portal.test").searchParams.get("token");

beforeEach(() => {
    jest.clearAllMocks();
    rows.drafts.length = 0;
    state.dnc = null;
    seq = 1;
    process.env.HR_PORTAL_RESUME_REF_KEY = Buffer.alloc(32, 5).toString("base64");
});
afterEach(() => {
    delete process.env.HR_PORTAL_RESUME_REF_KEY;
});

describe("draft save", () => {
    it("keeps a verified upload on the row with the PORTAL_UPLOAD marker, never a media id in the payload", async () => {
        await save({ resumeRef: ref() });
        const { create } = prisma.applicationDraft.upsert.mock.calls[0][0];
        expect(create.resumeMediaId).toBe(4242);
        expect(create.payload).toMatchObject({ resumeSource: "PORTAL_UPLOAD", resumeFileName: "cv.pdf" });
        expect(create.payload).not.toHaveProperty("resumeMediaId");
    });

    it("a save without a reference has no resume (the form is saved whole)", async () => {
        await save({ resumeRef: ref() });
        await save({});
        const { update } = prisma.applicationDraft.upsert.mock.calls[1][0];
        expect(update.resumeMediaId).toBeNull();
        expect(update.payload).not.toHaveProperty("resumeSource");
    });

    it.each([
        ["a typed media id", { resumeMediaId: 4242 }, "HR-RECRUITMENT-PORTAL-RESUME-UNVERIFIED"],
        ["another tenant's reference", { resumeRef: "OTHER" }, "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID"],
        ["a made-up reference", { resumeRef: "pr1.bogus" }, "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID"],
        ["an expired reference", { resumeRef: "EXPIRED" }, "HR-RECRUITMENT-PORTAL-RESUME-REF-EXPIRED"],
    ])("refuses %s with a 400 and its code, writing nothing", async (_label, body, code) => {
        const resolved = { ...body };
        if (body.resumeRef === "OTHER") resolved.resumeRef = ref({ tenantId: OTHER });
        if (body.resumeRef === "EXPIRED") resolved.resumeRef = ref({ now: new Date(Date.now() - 25 * 3_600_000) });
        await expect(save(resolved)).rejects.toMatchObject({ status: 400, code, details: { code } });
        expect(prisma.applicationDraft.upsert).not.toHaveBeenCalled();
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });

    it("a draft-bound reference saves onto that draft only, and the refusal does not depend on the register", async () => {
        await save({});
        const draftId = rows.drafts[0].id;
        await save({ resumeRef: ref({ draftId }) });
        expect(rows.drafts[0].resumeMediaId).toBe(4242);

        const other = save({ resumeRef: ref({ draftId }) }, { email: "someone@example.com" }).catch((e) => e);
        state.dnc = DNC_ROW;
        const otherOnRegister = save({ resumeRef: ref({ draftId }) }, { email: "someone@example.com" }).catch((e) => e);
        const wrongJob = save({ resumeRef: ref({ draftId }) }, { requisitionId: 6 }).catch((e) => e);
        for (const err of await Promise.all([other, otherOnRegister, wrongJob])) {
            expect(err).toMatchObject({ status: 400, code: "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-MISMATCH" });
        }
        // A submitted draft takes no more uploads either.
        state.dnc = null;
        rows.drafts[0].submittedAt = new Date();
        await expect(save({ resumeRef: ref({ draftId }) })).rejects.toMatchObject({ code: "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-MISMATCH" });
    });

    it("a register hit with a valid reference still answers saved and writes nothing", async () => {
        state.dnc = DNC_ROW;
        expect(await save({ resumeRef: ref() })).toMatchObject({ saved: true, draftId: null });
        expect(prisma.applicationDraft.upsert).not.toHaveBeenCalled();
    });
});

describe("draft load", () => {
    it("hands back a fresh reference bound to the draft and the file name, never the media id", async () => {
        await save({ resumeRef: ref() });
        const loaded = await drafts.loadApplicationDraft({ token: tokenOfLastEmail() });
        expect(loaded.resume).toMatchObject({ fileName: "cv.pdf" });
        expect(refs.readPortalResumeRef(loaded.resume.resumeRef, { tenantId: TENANT })).toMatchObject({ mediaId: 4242, draftId: rows.drafts[0].id });
        expect(JSON.stringify(loaded)).not.toMatch(/4242|resumeMediaId|PORTAL_UPLOAD/);
        // The reference saves straight back onto the same draft.
        await save({ resumeRef: loaded.resume.resumeRef });
        expect(rows.drafts[0].resumeMediaId).toBe(4242);
    });

    it("a Phase 5 draft's typed id is neither shown nor treated as a resume", async () => {
        await save({});
        Object.assign(rows.drafts[0], { resumeMediaId: 999, payload: { ...rows.drafts[0].payload, resumeMediaId: 999 } });
        const loaded = await drafts.loadApplicationDraft({ token: tokenOfLastEmail() });
        expect(loaded.resume).toBeNull();
        expect(loaded.payload).not.toHaveProperty("resumeMediaId");
    });

    it("loads without a reference when no key is configured", async () => {
        await save({ resumeRef: ref() });
        delete process.env.HR_PORTAL_RESUME_REF_KEY;
        const loaded = await drafts.loadApplicationDraft({ token: tokenOfLastEmail() });
        expect(loaded.resume).toEqual({ resumeRef: null, fileName: "cv.pdf", refExpiresAt: null });
    });
});

describe("draft submit", () => {
    it("carries the verified resume into the intake as the trusted argument", async () => {
        await save({ resumeRef: ref() });
        await drafts.submitApplicationDraft({ token: tokenOfLastEmail() });
        const call = submitPublicApplication.mock.calls[0][0];
        expect(call.resumeMediaId).toBe(4242);
        expect(call.body).not.toHaveProperty("resumeMediaId");
    });

    it("drops an unverified id on a Phase 5 row", async () => {
        await save({});
        rows.drafts[0].resumeMediaId = 999;
        await drafts.submitApplicationDraft({ token: tokenOfLastEmail() });
        expect(submitPublicApplication.mock.calls[0][0].resumeMediaId).toBeNull();
    });
});
