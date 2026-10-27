// Recruitment Phase 3a — the offer letter e-signature round trip: the send
// gate (flag, provider, ORG, SENT offer, rendered letter, category, privacy),
// one envelope per version, and the webhook (dedupe, tenant matching, SIGNED
// accepts through respondOffer exactly once, DECLINED does not decline,
// failures stored and retried).
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

import { createOfferLetterDb } from "./helpers/offer-letter.fake.js";

const { db, store } = createOfferLetterDb();
const events = [];
const enqueueHrDomainEvent = jest.fn(async (_tx, event) => {
    events.push(event);
    return event;
});
const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));
const downloadDamAssetBuffer = jest.fn();
const uploadFileToDAM = jest.fn();
const getRecruitmentSettings = jest.fn(async () => ({ companyName: "TruSoft", timeZone: "Asia/Karachi" }));
const respondContexts = [];
const respondOffer = jest.fn();
const sendEnvelope = jest.fn();
const voidEnvelope = jest.fn();
const downloadSignedDocument = jest.fn();
const isEsignConfigured = jest.fn(() => true);
const TYPES = ["SENT", "VIEWED", "SIGNED", "DECLINED", "EXPIRED", "VOIDED"];

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ downloadDamAssetBuffer, uploadFileToDAM }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/offer.service.js", () => ({ respondOffer }));
jest.unstable_mockModule("../../../src/services/esign.client.js", () => ({
    sendEnvelope,
    voidEnvelope,
    downloadSignedDocument,
    isEsignConfigured,
    getEsignProvider: () => "generic",
    normalizeEventType: (t) => (TYPES.includes(String(t ?? "").toUpperCase()) ? String(t).toUpperCase() : null),
}));

const svc = await import("../../../src/services/offer-esign.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORG = resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: 7 });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 9 });
const NOW = new Date("2026-10-20T06:00:00Z");
const EMAIL = "zoe@example.com";

const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT, employeeId: 7 } }, async () => await fn());

const ENV_KEYS = ["HR_RECRUITMENT_ESIGN"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

function seed({ offerStatus = "SENT", employeeCategory = null, letter = {} } = {}) {
    store.offer.push({
        id: 1,
        tenantId: TENANT,
        applicationId: 901,
        candidateId: 77,
        createdById: 7,
        status: offerStatus,
        employeeCategory,
        candidate: { id: 77, firstName: "Zoe", lastName: "Khan", email: EMAIL },
    });
    if (letter !== null) {
        store.offerLetterVersion.push({
            id: 50,
            tenantId: TENANT,
            offerId: 1,
            version: 1,
            templateKey: "STANDARD",
            templateVersion: 0,
            mediaId: 501,
            contentHash: "h",
            createdAt: NOW,
            signatureStatus: "NONE",
            esignProvider: null,
            esignEnvelopeId: null,
            sentForSignatureAt: null,
            signedAt: null,
            signedMediaId: null,
            signatureError: null,
            ...letter,
        });
    }
}

const send = (over = {}) =>
    asTenant(() => svc.sendOfferForSignature({ tenantId: TENANT, scope: ORG, offerId: 1, employeeCategory: "EMPLOYEE", actorId: 7, now: NOW, ...over }));

const deliver = (event, now = NOW) => svc.handleEsignWebhookEvent({ provider: "generic", event: { envelopeId: "env_1", occurredAt: null, ...event }, now });

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_ESIGN = "true";
    for (const key of Object.keys(store)) store[key].length = 0;
    db.contextLog.length = 0;
    events.length = 0;
    respondContexts.length = 0;
    isEsignConfigured.mockReturnValue(true);
    assertCommunicationsAllowed.mockResolvedValue({ allowed: true });
    downloadDamAssetBuffer.mockResolvedValue({ buffer: Buffer.from("%PDF-letter"), mimeType: "application/pdf" });
    sendEnvelope.mockResolvedValue({ provider: "generic", envelopeId: "env_1", status: "SENT" });
    voidEnvelope.mockImplementation(async ({ provider, envelopeId }) => ({ provider, envelopeId, status: "VOIDED" }));
    downloadSignedDocument.mockResolvedValue(Buffer.from("%PDF-signed"));
    uploadFileToDAM.mockResolvedValue([{ id: 900 }]);
    respondOffer.mockImplementation(async (id, accepted, tenantId) => {
        respondContexts.push(mcpCtx.getStore());
        const offer = store.offer.find((o) => o.id === Number(id) && o.tenantId === tenantId);
        offer.status = accepted ? "ACCEPTED" : "DECLINED";
        return { offer, handoff: { status: "COMPLETED" }, replayed: false };
    });
});

describe("sending for signature", () => {
    it("sends the newest letter, records the envelope and emits the event", async () => {
        seed();
        const out = await send({ message: "Please sign by Friday" });
        expect(out.replayed).toBe(false);
        expect(out.version).toMatchObject({ id: 50, signatureStatus: "SENT", esignProvider: "generic" });
        expect(store.offerLetterVersion[0]).toMatchObject({ signatureStatus: "SENT", esignProvider: "generic", esignEnvelopeId: "env_1" });
        expect(store.offerLetterVersion[0].sentForSignatureAt.toISOString()).toBe(NOW.toISOString());
        expect(store.offer[0].employeeCategory).toBe("EMPLOYEE");
        expect(sendEnvelope).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: TENANT,
                offerId: 1,
                letterVersionId: 50,
                pdfBuffer: Buffer.from("%PDF-letter"),
                signer: { name: "Zoe Khan", email: EMAIL },
                message: "Please sign by Friday",
                idempotencyKey: `offer-letter-${TENANT}-50`,
            }),
        );
        expect(downloadDamAssetBuffer).toHaveBeenCalledWith(501);
        expect(events).toEqual([
            expect.objectContaining({
                eventName: "hr.recruitment.offer_esign_sent.v1",
                payload: { offerLetterVersionId: "50", offerId: "1", candidateId: "77", createdById: "7", provider: "generic" },
            }),
        ]);
        expect(JSON.stringify(events)).not.toContain(EMAIL);
    });

    it("a second send replays instead of creating a second envelope", async () => {
        seed();
        await send();
        const again = await send();
        expect(again.replayed).toBe(true);
        expect(sendEnvelope).toHaveBeenCalledTimes(1);
    });

    it("refuses a candidate on the do-not-contact register without echoing the address", async () => {
        seed();
        assertCommunicationsAllowed.mockRejectedValue(
            Object.assign(new Error("This candidate is on the do-not-contact register (REQUESTED) — contact is blocked"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }),
        );
        const err = await send().catch((e) => e);
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" });
        expect(err.message).not.toContain(EMAIL);
        expect(assertCommunicationsAllowed).toHaveBeenCalledWith({ tenantId: TENANT, candidateId: 77, purpose: "PROCESSING" });
        expect(sendEnvelope).not.toHaveBeenCalled();
        expect(store.offerLetterVersion[0]).toMatchObject({ signatureStatus: "NONE", sentForSignatureAt: null });
    });

    it("is off with the flag off, and with no provider even when the flag is on", async () => {
        seed();
        process.env.HR_RECRUITMENT_ESIGN = "false";
        await expect(send()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-ESIGN-DISABLED" });
        process.env.HR_RECRUITMENT_ESIGN = "true";
        isEsignConfigured.mockReturnValue(false);
        await expect(send()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-ESIGN-PROVIDER-DISABLED" });
        expect(sendEnvelope).not.toHaveBeenCalled();
    });

    it("is ORG only", async () => {
        seed();
        await expect(send({ scope: FINANCE })).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-ESIGN-FORBIDDEN" });
    });

    it("needs a SENT offer, a rendered letter and an employee category", async () => {
        seed({ offerStatus: "DRAFT" });
        await expect(send()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-NOT-SENT" });
        store.offer[0].status = "SENT";
        await expect(send({ employeeCategory: null })).rejects.toMatchObject({ status: 422, code: "HR-RECRUITMENT-OFFER-CATEGORY-REQUIRED" });
        store.offerLetterVersion.length = 0;
        await expect(send()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-LETTER-REQUIRED" });
        expect(sendEnvelope).not.toHaveBeenCalled();
    });

    it("uses the category already on the offer", async () => {
        seed({ employeeCategory: "INTERNEE" });
        await send({ employeeCategory: null });
        expect(store.offer[0].employeeCategory).toBe("INTERNEE");
    });

    it("a closed signature needs a fresh render", async () => {
        seed({ letter: { signatureStatus: "VOIDED", esignProvider: "generic", esignEnvelopeId: "env_0" } });
        await expect(send()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-LETTER-SIGNATURE-CLOSED" });
    });

    it("a provider failure is stored as FAILED and can be sent again", async () => {
        seed();
        sendEnvelope.mockRejectedValueOnce(Object.assign(new Error("The e-signature provider refused the envelope (status 400)"), { status: 502, code: "HR-RECRUITMENT-ESIGN-SEND-FAILED" }));
        await expect(send()).rejects.toMatchObject({ code: "HR-RECRUITMENT-ESIGN-SEND-FAILED" });
        expect(store.offerLetterVersion[0]).toMatchObject({ signatureStatus: "FAILED", sentForSignatureAt: null });
        expect(store.offerLetterVersion[0].signatureError).toContain("HR-RECRUITMENT-ESIGN-SEND-FAILED");
        const retried = await send();
        expect(retried.version.signatureStatus).toBe("SENT");
    });

    it("a concurrent send in flight is refused", async () => {
        seed({ letter: { sentForSignatureAt: new Date(NOW.getTime() - 30_000) } });
        await expect(send()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-LETTER-SEND-IN-PROGRESS" });
        expect(sendEnvelope).not.toHaveBeenCalled();
    });

    it("a letter DAM cannot return releases the claim", async () => {
        seed();
        downloadDamAssetBuffer.mockResolvedValue(null);
        await expect(send()).rejects.toMatchObject({ status: 502, code: "HR-RECRUITMENT-OFFER-LETTER-DOCUMENT-UNAVAILABLE" });
        expect(store.offerLetterVersion[0]).toMatchObject({ signatureStatus: "NONE", sentForSignatureAt: null });
    });
});

describe("voiding", () => {
    it("voids the envelope out for signature", async () => {
        seed({ letter: { signatureStatus: "VIEWED", esignProvider: "generic", esignEnvelopeId: "env_1" } });
        const out = await asTenant(() => svc.voidOfferSignature({ tenantId: TENANT, scope: ORG, offerId: 1, reason: "Wrong start date" }));
        expect(out.version.signatureStatus).toBe("VOIDED");
        expect(voidEnvelope).toHaveBeenCalledWith({ provider: "generic", envelopeId: "env_1", reason: "Wrong start date" });
        expect(events.map((e) => [e.eventName, e.payload.signatureStatus])).toEqual([["hr.recruitment.offer_esign_status_changed.v1", "VOIDED"]]);
    });

    it("needs a reason and a letter out for signature", async () => {
        seed();
        await expect(asTenant(() => svc.voidOfferSignature({ tenantId: TENANT, scope: ORG, offerId: 1, reason: " " }))).rejects.toMatchObject({ status: 400 });
        await expect(asTenant(() => svc.voidOfferSignature({ tenantId: TENANT, scope: ORG, offerId: 1, reason: "x" }))).rejects.toMatchObject({
            status: 409,
            code: "HR-RECRUITMENT-OFFER-LETTER-NOT-OUT-FOR-SIGNATURE",
        });
    });
});

describe("the webhook", () => {
    const sentLetter = { signatureStatus: "SENT", esignProvider: "generic", esignEnvelopeId: "env_1", sentForSignatureAt: NOW };

    it("SIGNED stores the signed PDF, marks the letter SIGNED and accepts the offer through respondOffer", async () => {
        seed({ employeeCategory: "EMPLOYEE", letter: sentLetter });
        const out = await deliver({ eventId: "evt_1", type: "SIGNED", occurredAt: new Date("2026-10-20T05:00:00Z") });
        expect(out.outcome).toBe("APPLIED");
        expect(store.offerLetterVersion[0]).toMatchObject({ signatureStatus: "SIGNED", signedMediaId: 900 });
        expect(store.offerLetterVersion[0].signedAt.toISOString()).toBe("2026-10-20T05:00:00.000Z");
        expect(uploadFileToDAM).toHaveBeenCalledWith(expect.objectContaining({ mimetype: "application/pdf", buffer: Buffer.from("%PDF-signed") }), "document");
        expect(respondOffer).toHaveBeenCalledTimes(1);
        expect(respondOffer).toHaveBeenCalledWith(1, true, TENANT, { actorId: null, employeeCategory: "EMPLOYEE" });
        // Accepted under the matched tenant's context, not SYSTEM.
        expect(respondContexts[0]).toMatchObject({ user: { tenantId: TENANT } });
        expect(respondContexts[0].system).toBeUndefined();
        expect(store.esignWebhookEvent[0]).toMatchObject({ provider: "generic", providerEventId: "evt_1", tenantId: TENANT, status: "APPLIED", eventType: "SIGNED" });
        expect(events.map((e) => e.payload.signatureStatus)).toEqual(["SIGNED"]);
    });

    it("the same SIGNED event twice accepts exactly once", async () => {
        seed({ employeeCategory: "EMPLOYEE", letter: sentLetter });
        await deliver({ eventId: "evt_1", type: "SIGNED" });
        const again = await deliver({ eventId: "evt_1", type: "SIGNED" });
        expect(again).toMatchObject({ outcome: "DUPLICATE", status: "APPLIED" });
        expect(respondOffer).toHaveBeenCalledTimes(1);
        expect(uploadFileToDAM).toHaveBeenCalledTimes(1);
        expect(store.esignWebhookEvent).toHaveLength(1);
    });

    it("a second SIGNED event (new id) for an accepted offer does not accept again", async () => {
        seed({ employeeCategory: "EMPLOYEE", letter: sentLetter });
        await deliver({ eventId: "evt_1", type: "SIGNED" });
        const second = await deliver({ eventId: "evt_2", type: "SIGNED" });
        expect(second.outcome).toBe("APPLIED");
        expect(respondOffer).toHaveBeenCalledTimes(1);
    });

    it("DECLINED records the signature status but does not decline the offer", async () => {
        seed({ letter: sentLetter });
        const out = await deliver({ eventId: "evt_d", type: "DECLINED" });
        expect(out.outcome).toBe("APPLIED");
        expect(store.offerLetterVersion[0].signatureStatus).toBe("DECLINED");
        expect(store.offer[0].status).toBe("SENT");
        expect(respondOffer).not.toHaveBeenCalled();
        expect(events.map((e) => e.payload.signatureStatus)).toEqual(["DECLINED"]);
    });

    it("VIEWED moves SENT forward; a late VIEWED never reopens a signed letter", async () => {
        seed({ employeeCategory: "EMPLOYEE", letter: sentLetter });
        expect((await deliver({ eventId: "evt_v1", type: "VIEWED" })).outcome).toBe("APPLIED");
        expect(store.offerLetterVersion[0].signatureStatus).toBe("VIEWED");
        await deliver({ eventId: "evt_s", type: "SIGNED" });
        expect((await deliver({ eventId: "evt_v2", type: "VIEWED" })).outcome).toBe("IGNORED");
        expect(store.offerLetterVersion[0].signatureStatus).toBe("SIGNED");
    });

    it("an unknown envelope is IGNORED and stays tenantless", async () => {
        seed({ letter: sentLetter });
        const out = await deliver({ eventId: "evt_x", type: "SIGNED", envelopeId: "env_unknown" });
        expect(out.outcome).toBe("IGNORED");
        expect(store.esignWebhookEvent[0]).toMatchObject({ tenantId: null, status: "IGNORED", error: "Unknown envelope" });
        expect(respondOffer).not.toHaveBeenCalled();
    });

    it("a failed acceptance is stored, and the provider's redelivery retries it", async () => {
        seed({ employeeCategory: "EMPLOYEE", letter: sentLetter });
        respondOffer.mockRejectedValueOnce(Object.assign(new Error("Offer acceptance and hire provisioning are disabled"), { status: 503, code: "HR-RECRUITMENT-OFFER-HANDOFF-DISABLED" }));
        const first = await deliver({ eventId: "evt_1", type: "SIGNED" });
        expect(first.outcome).toBe("FAILED");
        expect(store.esignWebhookEvent[0]).toMatchObject({ status: "FAILED", tenantId: TENANT });
        expect(store.esignWebhookEvent[0].error).toContain("HR-RECRUITMENT-OFFER-HANDOFF-DISABLED");
        // The signature itself is kept.
        expect(store.offerLetterVersion[0].signatureStatus).toBe("SIGNED");
        const retry = await deliver({ eventId: "evt_1", type: "SIGNED" });
        expect(retry.outcome).toBe("APPLIED");
        expect(respondOffer).toHaveBeenCalledTimes(2);
        expect(uploadFileToDAM).toHaveBeenCalledTimes(1);
        expect(store.offer[0].status).toBe("ACCEPTED");
    });

    it("a signature on an offer that was withdrawn meanwhile is IGNORED, not retried", async () => {
        seed({ employeeCategory: "EMPLOYEE", letter: sentLetter });
        respondOffer.mockRejectedValueOnce(Object.assign(new Error("Offer is already finalized as WITHDRAWN"), { status: 409, code: "HR-RECRUITMENT-OFFER-FINALIZED" }));
        const out = await deliver({ eventId: "evt_1", type: "SIGNED" });
        expect(out.outcome).toBe("IGNORED");
        expect(store.esignWebhookEvent[0].error).toContain("WITHDRAWN");
    });

    it("an in-flight delivery is not processed twice", async () => {
        seed({ letter: sentLetter });
        store.esignWebhookEvent.push({ id: 1, provider: "generic", providerEventId: "evt_1", tenantId: null, status: "RECEIVED", processedAt: NOW, receivedAt: NOW });
        expect((await deliver({ eventId: "evt_1", type: "VIEWED" })).outcome).toBe("IN_PROGRESS");
        expect(store.offerLetterVersion[0].signatureStatus).toBe("SENT");
    });

    it("dedupe and matching run under SYSTEM; the letter update under the tenant", async () => {
        seed({ letter: sentLetter });
        await deliver({ eventId: "evt_v", type: "VIEWED" });
        const eventQueries = db.contextLog.filter((q) => q.model === "esignWebhookEvent");
        expect(eventQueries.length).toBeGreaterThan(0);
        expect(eventQueries.every((q) => q.system)).toBe(true);
        const updates = db.contextLog.filter((q) => q.model === "offerLetterVersion" && q.op === "updateMany");
        expect(updates.every((q) => q.tenantId === TENANT && !q.system)).toBe(true);
    });

    it("the retry job re-applies FAILED events and skips with the flag off", async () => {
        seed({ employeeCategory: "EMPLOYEE", letter: { ...sentLetter, signatureStatus: "SIGNED" } });
        store.esignWebhookEvent.push({ id: 1, provider: "generic", providerEventId: "evt_1", envelopeId: "env_1", eventType: "SIGNED", tenantId: null, status: "FAILED", processedAt: NOW, receivedAt: NOW });
        process.env.HR_RECRUITMENT_ESIGN = "false";
        expect(await svc.runEsignWebhookRetryJob({ now: NOW })).toMatchObject({ skipped: true });
        process.env.HR_RECRUITMENT_ESIGN = "true";
        const summary = await svc.runEsignWebhookRetryJob({ now: new Date(NOW.getTime() + 60_000) });
        expect(summary).toMatchObject({ scanned: 1, applied: 1, failed: 0 });
        expect(respondOffer).toHaveBeenCalledTimes(1);
        expect(store.esignWebhookEvent[0]).toMatchObject({ status: "APPLIED", tenantId: TENANT });
    });
});
