// Recruitment Phase 5 (plan 6.9) — portal data-subject requests: intake with
// no oracle, the emailed verification, the sweep of unverified requests and
// the SLA alert.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHash } from "node:crypto";
import { createPrivacyFake } from "./helpers/privacy-operations.fake.js";

let db = createPrivacyFake();
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));
const sendCandidateEmail = jest.fn(async () => ({ sent: true }));
jest.unstable_mockModule("../../../src/lib/notificationClient.js", () => ({ sendCandidateEmail }));

const svc = await import("../../../src/services/dsr-portal.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T08:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (t) => createHash("sha256").update(t).digest("hex");
const asPortal = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId }, portal: true }, fn);
const tokenFromLastEmail = () => new URL(sendCandidateEmail.mock.calls.at(-1)[0].data.verifyUrl).searchParams.get("token");

beforeEach(() => {
    db = createPrivacyFake({
        tenantRecruitmentSettings: [{ tenantId: TENANT, portalBaseUrl: "https://careers.example.com/", companyName: "Acme", dataPolicyOwnerId: 42 }],
        candidate: [{ id: 5, tenantId: TENANT, email: "Ayesha@Example.com", anonymizedAt: null }],
    });
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_DSR_PORTAL = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_DSR_PORTAL;
});

describe("submitPortalDsr", () => {
    it("answers the same for a known and an unknown address, and records a hashed, expiring request", async () => {
        const known = await asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: " ayesha@example.com ", type: "access", details: "All of it" }, now: NOW }));
        const knownToken = tokenFromLastEmail();
        const unknown = await asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: "nobody@example.com", type: "ERASURE" }, now: NOW }));

        expect(known).toEqual({ accepted: true });
        expect(unknown).toEqual(known);
        const [row, other] = db.rows("candidateDataAccessRequest");
        expect(row).toMatchObject({
            tenantId: TENANT, source: "PORTAL", subjectEmail: "ayesha@example.com", type: "ACCESS", status: "RECEIVED",
            dueAt: null, notes: "All of it",
        });
        expect(row.verifiedAt ?? null).toBeNull();
        expect(row.candidateId ?? null).toBeNull();
        expect(row.verificationExpiresAt).toEqual(new Date(NOW.getTime() + 48 * HOUR));
        expect(row.verificationTokenHash).toBe(sha(knownToken));
        expect(JSON.stringify(row)).not.toContain(knownToken);
        // Intake never looks the address up: the unknown one is recorded the same way.
        expect(other).toMatchObject({ subjectEmail: "nobody@example.com", type: "ERASURE" });
        expect(other.candidateId ?? null).toBeNull();

        const call = sendCandidateEmail.mock.calls[0][0];
        expect(call).toMatchObject({ tenantId: TENANT, email: "ayesha@example.com", templateId: "hr.recruitment.dsr_verification", dedupeKey: `hr-dsr-verification:${row.id}` });
        expect(call.data.verifyUrl).toBe(`https://careers.example.com/privacy/verify?token=${knownToken}`);
        expect(call.data).toMatchObject({ requestType: "ACCESS", companyName: "Acme", validityHours: 48 });

        const events = db.rows("outboxEvent");
        expect(events.map((e) => e.eventName)).toEqual([
            "hr.recruitment.dsr_verification_requested.v1",
            "hr.recruitment.dsr_verification_requested.v1",
        ]);
        const wire = JSON.stringify(events);
        expect(wire).not.toContain("ayesha");
        expect(wire).not.toContain(knownToken);
        expect(wire).not.toContain("All of it");
    });

    it("caps live unverified requests per address: the 4th is answered the same and sends nothing", async () => {
        for (let i = 0; i < 4; i += 1) {
            expect(await asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: "a@b.co", type: "ACCESS" }, now: NOW }))).toEqual({ accepted: true });
        }
        expect(db.rows("candidateDataAccessRequest")).toHaveLength(3);
        expect(sendCandidateEmail).toHaveBeenCalledTimes(3);
    });

    it("rejects a malformed body with 400 and answers 503 with the flag off", async () => {
        await expect(asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: "nope", type: "ACCESS" } })))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-DSR-EMAIL-INVALID" });
        await expect(asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: "a@b.co", type: "SHRED" } })))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-DSR-TYPE-INVALID" });
        await expect(asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: "a@b.co", type: "ACCESS", details: "x".repeat(2001) } })))
            .rejects.toMatchObject({ status: 400 });
        process.env.HR_RECRUITMENT_DSR_PORTAL = "false";
        await expect(asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: "a@b.co", type: "ACCESS" } })))
            .rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-DSR-PORTAL-DISABLED" });
    });

    it("records the request but sends nothing when no portal address is configured", async () => {
        db.rows("tenantRecruitmentSettings")[0].portalBaseUrl = null;
        delete process.env.HR_PORTAL_BASE_URL;
        expect(await asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email: "a@b.co", type: "ACCESS" }, now: NOW }))).toEqual({ accepted: true });
        expect(db.rows("candidateDataAccessRequest")).toHaveLength(1);
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });
});

describe("verifyPortalDsr", () => {
    const submit = async (email = "ayesha@example.com") => {
        await asPortal(() => svc.submitPortalDsr({ tenantId: TENANT, body: { email, type: "ACCESS" }, now: NOW }));
        return tokenFromLastEmail();
    };

    it("verifies once: starts the 30-day clock, links the matching candidate, clears the token, tells HR", async () => {
        const token = await submit();
        const at = new Date(NOW.getTime() + 2 * HOUR);

        expect(await asPortal(() => svc.verifyPortalDsr({ tenantId: TENANT, token, now: at }))).toMatchObject({ verified: true });
        expect(await asPortal(() => svc.verifyPortalDsr({ tenantId: TENANT, token, now: at }))).toEqual({ verified: false });

        const [row] = db.rows("candidateDataAccessRequest");
        expect(row).toMatchObject({ verifiedAt: at, dueAt: new Date(at.getTime() + 30 * DAY), candidateId: 5, verificationTokenHash: null });
        const verified = db.rows("outboxEvent").find((e) => e.eventName === "hr.recruitment.dsr_verified.v1");
        expect(verified.payload.payload).toMatchObject({ requestId: String(row.id), candidateId: "5", dataPolicyOwnerId: "42" });
    });

    it("leaves candidateId empty when no candidate has the address", async () => {
        const token = await submit("stranger@example.com");
        await asPortal(() => svc.verifyPortalDsr({ tenantId: TENANT, token, now: NOW }));
        expect(db.rows("candidateDataAccessRequest")[0]).toMatchObject({ candidateId: null, verifiedAt: NOW });
    });

    it("refuses an expired, malformed or other tenant's token without saying which", async () => {
        const token = await submit();
        expect(await asPortal(() => svc.verifyPortalDsr({ tenantId: TENANT, token, now: new Date(NOW.getTime() + 49 * HOUR) }))).toEqual({ verified: false });
        expect(await asPortal(() => svc.verifyPortalDsr({ tenantId: TENANT, token: "short", now: NOW }))).toEqual({ verified: false });
        expect(await asPortal(() => svc.verifyPortalDsr({ tenantId: OTHER, token, now: NOW }), OTHER)).toEqual({ verified: false });
        expect(db.rows("candidateDataAccessRequest")[0].verifiedAt).toBeUndefined();
    });
});

describe("runDsrVerificationSweepJob", () => {
    it("deletes only unverified portal requests whose link expired, per tenant", async () => {
        db.rows("candidateDataAccessRequest").push(
            { id: 1, tenantId: TENANT, source: "PORTAL", verifiedAt: null, verificationExpiresAt: new Date(NOW.getTime() - HOUR) },
            { id: 2, tenantId: OTHER, source: "PORTAL", verifiedAt: null, verificationExpiresAt: new Date(NOW.getTime() - DAY) },
            { id: 3, tenantId: TENANT, source: "PORTAL", verifiedAt: null, verificationExpiresAt: new Date(NOW.getTime() + HOUR) },
            { id: 4, tenantId: TENANT, source: "PORTAL", verifiedAt: new Date(NOW.getTime() - DAY), verificationExpiresAt: new Date(NOW.getTime() - DAY) },
            { id: 5, tenantId: TENANT, source: "HR", verifiedAt: null, verificationExpiresAt: null },
        );

        const summary = await svc.runDsrVerificationSweepJob({ now: NOW });

        expect(summary).toMatchObject({ scanned: 2, deleted: 2, failed: 0 });
        expect(db.rows("candidateDataAccessRequest").map((r) => r.id)).toEqual([3, 4, 5]);
        const deletes = db.contextLog.filter((e) => e.op === "deleteMany");
        expect(deletes.every((e) => !e.system && e.tenantId)).toBe(true);
    });
});

describe("runDsrSlaJob", () => {
    const open = (over) => ({ tenantId: TENANT, type: "ACCESS", source: "HR", status: "RECEIVED", slaAlertedAt: null, verifiedAt: null, ...over });

    it("alerts once for open verified requests due within 5 days or overdue", async () => {
        db.rows("candidateDataAccessRequest").push(
            open({ id: 1, dueAt: new Date(NOW.getTime() + 3 * DAY), handledById: 9 }),
            open({ id: 2, dueAt: new Date(NOW.getTime() - DAY), source: "PORTAL", verifiedAt: new Date(NOW.getTime() - 31 * DAY) }),
            open({ id: 3, dueAt: new Date(NOW.getTime() + 10 * DAY) }),
            open({ id: 4, dueAt: new Date(NOW.getTime() + DAY), status: "FULFILLED" }),
            open({ id: 5, dueAt: new Date(NOW.getTime() + DAY), source: "PORTAL", verifiedAt: null }),
            open({ id: 6, dueAt: new Date(NOW.getTime() + DAY), slaAlertedAt: new Date(NOW.getTime() - DAY) }),
            open({ id: 7, tenantId: OTHER, dueAt: new Date(NOW.getTime() + DAY) }),
        );

        const first = await svc.runDsrSlaJob({ now: NOW });
        const second = await svc.runDsrSlaJob({ now: NOW });

        expect(first).toMatchObject({ scanned: 3, alerted: 3, overdue: 1, failed: 0 });
        expect(second).toMatchObject({ scanned: 0, alerted: 0 });
        const events = db.rows("outboxEvent").filter((e) => e.eventName === "hr.recruitment.dsr_sla_at_risk.v1");
        expect(events.map((e) => [e.tenantId, e.payload.payload.requestId]).sort()).toEqual([
            [TENANT, "1"], [TENANT, "2"], [OTHER, "7"],
        ].sort());
        const overdue = events.find((e) => e.payload.payload.requestId === "2").payload.payload;
        expect(overdue).toMatchObject({ overdue: true, daysRemaining: -1, dataPolicyOwnerId: "42" });
        expect(events.find((e) => e.payload.payload.requestId === "1").payload.payload).toMatchObject({ overdue: false, daysRemaining: 3, handledById: "9" });
        expect(db.rows("candidateDataAccessRequest").find((r) => r.id === 1).slaAlertedAt).toEqual(NOW);
    });

    it("is skipped with the flag off", async () => {
        process.env.HR_RECRUITMENT_DSR_PORTAL = "false";
        expect(await svc.runDsrSlaJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
    });
});
