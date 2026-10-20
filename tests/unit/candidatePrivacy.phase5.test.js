// Recruitment Phase 5 (plan 6.9) — what changed in candidatePrivacy.service:
//   * apply is per tenant: the destructive path also needs the tenant's
//     signed-off switch (retentionApplyEnabled), with the same refusal shape
//     as the flag;
//   * the due preview filters in the query, so `limit` bounds due rows rather
//     than hiding them behind the first page of every candidate;
//   * an unverified portal request is not in the HR queue (list) and cannot be
//     closed.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createPrivacyFake } from "./services/helpers/privacy-operations.fake.js";

let db = createPrivacyFake();
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaProxy }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({
    deleteDamAsset: jest.fn(async () => ({ ok: true })),
    getDamAssetById: jest.fn(async () => null),
    downloadDamAssetBuffer: jest.fn(async () => null),
    uploadFileToDAM: jest.fn(async () => null),
    damRequest: jest.fn(async () => null),
    normalizeDamAssetResponse: jest.fn((p) => p ?? null),
}));

const privacy = await import("../../src/services/candidatePrivacy.service.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ASOF = new Date("2026-10-20T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT } }, fn);

beforeEach(() => {
    db = createPrivacyFake({
        candidate: [
            { id: 1, tenantId: TENANT, email: "a@x.co", retentionUntil: FUTURE, anonymizedAt: null },
            { id: 2, tenantId: TENANT, email: "b@x.co", retentionUntil: null, anonymizedAt: null },
            { id: 3, tenantId: TENANT, email: "c@x.co", retentionUntil: PAST, retentionPopulation: "TALENT_POOL", anonymizedAt: null },
            { id: 4, tenantId: TENANT, email: "d@x.co", retentionUntil: PAST, retentionPopulation: null, anonymizedAt: null, firstName: "Dee" },
            { id: 5, tenantId: TENANT, email: "e@x.co", retentionUntil: PAST, retentionPopulation: "APPLICANT", anonymizedAt: PAST },
        ],
    });
    process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_RETENTION_AUTOMATION;
});

describe("retention", () => {
    it("bounds the preview by DUE rows: a due candidate behind non-due ones is still found", async () => {
        const preview = await asTenant(() => privacy.previewRetentionDue({ tenantId: TENANT, asOf: ASOF, limit: 1 }, { db }));
        expect(preview.due.map((c) => c.id)).toEqual([4]);
    });

    it("refuses apply until the tenant switched it on, then applies", async () => {
        const refused = await asTenant(() => privacy.applyRetention({ tenantId: TENANT, asOf: ASOF, dryRun: false }, { db }));
        expect(refused).toMatchObject({ dryRun: true, refused: true, reason: "tenant-not-signed-off", wouldAnonymize: [4] });
        expect(db.rows("candidate").find((c) => c.id === 4).anonymizedAt).toBeNull();

        db.rows("tenantRecruitmentSettings").push({ tenantId: TENANT, retentionApplyEnabled: true });
        const applied = await asTenant(() => privacy.applyRetention({ tenantId: TENANT, asOf: ASOF, dryRun: false }, { db }));
        expect(applied).toMatchObject({ dryRun: false, anonymized: [4] });
        expect(db.rows("candidate").find((c) => c.id === 4)).toMatchObject({ firstName: "Anonymized", anonymizedAt: ASOF });
    });

    it("still refuses on the flag first", async () => {
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = "false";
        db.rows("tenantRecruitmentSettings").push({ tenantId: TENANT, retentionApplyEnabled: true });
        const res = await asTenant(() => privacy.applyRetention({ tenantId: TENANT, asOf: ASOF, dryRun: false }, { db }));
        expect(res).toMatchObject({ refused: true, reason: "flag-disabled" });
    });
});

describe("data-subject request queue", () => {
    beforeEach(() => {
        db.rows("candidateDataAccessRequest").push(
            { id: 1, tenantId: TENANT, source: "HR", status: "RECEIVED", receivedAt: ASOF },
            { id: 2, tenantId: TENANT, source: "PORTAL", status: "RECEIVED", verifiedAt: null, receivedAt: ASOF },
            { id: 3, tenantId: TENANT, source: "PORTAL", status: "RECEIVED", verifiedAt: ASOF, receivedAt: ASOF },
        );
    });

    it("lists HR and verified portal requests only", async () => {
        const rows = await asTenant(() => privacy.listDataAccessRequests({ tenantId: TENANT }, { db }));
        expect(rows.map((r) => r.id).sort()).toEqual([1, 3]);
    });

    it("cannot close an unverified portal request; can close a verified one", async () => {
        await expect(asTenant(() => privacy.closeDataAccessRequest({ tenantId: TENANT, id: 2, status: "FULFILLED" }, { db })))
            .rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-DAR-NOT-FOUND" });
        const closed = await asTenant(() => privacy.closeDataAccessRequest({ tenantId: TENANT, id: 3, status: "FULFILLED" }, { db }));
        expect(closed).toMatchObject({ id: 3, status: "FULFILLED" });
    });
});
