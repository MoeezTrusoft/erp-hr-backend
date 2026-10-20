// Recruitment Phase 3a — the provider-neutral e-signature adapter: provider
// selection (none by default), the generic HTTPS shape, and webhook
// verification (HMAC over "<timestamp>.<raw body>", 5 minute window).
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

const logged = [];
const logger = Object.fromEntries(["trace", "debug", "info", "warn", "error", "fatal"].map((level) => [level, jest.fn((...args) => logged.push(args))]));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));

const client = await import("../../../src/services/esign.client.js");

const ENV_KEYS = ["ESIGN_PROVIDER", "ESIGN_API_BASE", "ESIGN_API_KEY", "ESIGN_WEBHOOK_SECRET", "ESIGN_HTTP_TIMEOUT_MS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const SECRET = "whsec-test-secret";
const NOW = new Date("2026-10-20T10:00:00Z");
const nowSeconds = String(Math.floor(NOW.getTime() / 1000));

function configureGeneric() {
    process.env.ESIGN_PROVIDER = "generic";
    process.env.ESIGN_API_BASE = "https://esign.example.test/api/";
    process.env.ESIGN_API_KEY = "sk-live-very-secret";
    process.env.ESIGN_WEBHOOK_SECRET = SECRET;
}

const signed = (body, { timestamp = nowSeconds, secret = SECRET } = {}) => {
    const rawBody = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return {
        rawBody,
        headers: {
            "x-esign-timestamp": timestamp,
            "x-esign-signature": `sha256=${client.signWebhookPayload(secret, timestamp, rawBody)}`,
        },
    };
};

beforeEach(() => {
    jest.clearAllMocks();
    logged.length = 0;
    for (const k of ENV_KEYS) delete process.env[k];
    globalThis.fetch = jest.fn();
});

describe("provider selection", () => {
    it("defaults to none, and none refuses to send", async () => {
        expect(client.getEsignProvider()).toBe("none");
        expect(client.isEsignConfigured()).toBe(false);
        await expect(client.sendEnvelope({ pdfBuffer: Buffer.from("%PDF"), signer: { email: "a@b.c" } })).rejects.toMatchObject({
            status: 503,
            code: "HR-RECRUITMENT-ESIGN-PROVIDER-DISABLED",
        });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("treats an unknown provider as none", () => {
        process.env.ESIGN_PROVIDER = "docuthing";
        expect(client.getEsignProvider()).toBe("none");
    });

    it("generic needs its base URL (https) and API key", () => {
        process.env.ESIGN_PROVIDER = "generic";
        expect(client.isEsignConfigured()).toBe(false);
        process.env.ESIGN_API_KEY = "k";
        process.env.ESIGN_API_BASE = "http://esign.example.test";
        expect(client.isEsignConfigured()).toBe(false);
        process.env.ESIGN_API_BASE = "https://esign.example.test";
        expect(client.isEsignConfigured()).toBe(true);
    });
});

describe("generic provider", () => {
    beforeEach(configureGeneric);

    it("sends the envelope with the document, the idempotency key and bearer auth", async () => {
        globalThis.fetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "env_1", status: "sent" }) });
        const out = await client.sendEnvelope({
            tenantId: "t-1",
            offerId: 1,
            letterVersionId: 5,
            pdfBuffer: Buffer.from("%PDF-1.3"),
            signer: { name: "Zoe Khan", email: "zoe@example.com" },
            subject: "Your offer letter",
            callbackUrl: "https://hr.example.test/webhooks/esign/generic",
            idempotencyKey: "offer-letter-t-1-5",
        });
        expect(out).toEqual({ provider: "generic", envelopeId: "env_1", status: "SENT" });
        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toBe("https://esign.example.test/api/envelopes");
        expect(init.headers).toMatchObject({ Authorization: "Bearer sk-live-very-secret", "Idempotency-Key": "offer-letter-t-1-5" });
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({ externalRef: "hr:t-1:offer:1:letter:5", signer: { email: "zoe@example.com" } });
        expect(Buffer.from(body.document.base64, "base64").toString()).toBe("%PDF-1.3");
    });

    it("a refusal is a 502 that leaks neither the provider body nor the signer, and nothing secret is logged", async () => {
        globalThis.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "bad email zoe@example.com" }) });
        await expect(
            client.sendEnvelope({ pdfBuffer: Buffer.from("%PDF"), signer: { name: "Zoe", email: "zoe@example.com" }, letterVersionId: 5 }),
        ).rejects.toMatchObject({ status: 502, code: "HR-RECRUITMENT-ESIGN-SEND-FAILED", message: expect.not.stringContaining("zoe") });
        const text = JSON.stringify(logged);
        expect(text).not.toContain("zoe@example.com");
        expect(text).not.toContain("sk-live-very-secret");
        expect(text).not.toContain("%PDF");
    });

    it("an unreachable provider is a 502 without detail", async () => {
        globalThis.fetch.mockRejectedValue(new Error("connect ECONNREFUSED zoe@example.com"));
        await expect(client.sendEnvelope({ pdfBuffer: Buffer.from("%PDF"), signer: { email: "zoe@example.com" } })).rejects.toMatchObject({
            code: "HR-RECRUITMENT-ESIGN-PROVIDER-UNAVAILABLE",
        });
        expect(JSON.stringify(logged)).not.toContain("zoe@example.com");
    });

    it("voids, tolerating an envelope the provider no longer has", async () => {
        globalThis.fetch.mockResolvedValue({ ok: false, status: 404 });
        await expect(client.voidEnvelope({ provider: "generic", envelopeId: "env/1", reason: "wrong salary" })).resolves.toMatchObject({ status: "VOIDED" });
        expect(globalThis.fetch.mock.calls[0][0]).toBe("https://esign.example.test/api/envelopes/env%2F1/void");
    });

    it("downloads the signed document, or null when there is none", async () => {
        globalThis.fetch.mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => Buffer.from("%PDF-signed") });
        expect((await client.downloadSignedDocument({ provider: "generic", envelopeId: "env_1" })).toString()).toBe("%PDF-signed");
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
        expect(await client.downloadSignedDocument({ provider: "generic", envelopeId: "env_1" })).toBeNull();
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
        await expect(client.downloadSignedDocument({ provider: "generic", envelopeId: "env_1" })).rejects.toMatchObject({ status: 502 });
    });
});

describe("verifyWebhook", () => {
    beforeEach(configureGeneric);
    const BODY = { eventId: "evt_1", type: "envelope.completed", envelopeId: "env_1", occurredAt: "2026-10-20T09:59:00Z" };

    it("accepts a good signature and normalises the event", () => {
        const { rawBody, headers } = signed(BODY);
        const out = client.verifyWebhook({ provider: "generic", headers, rawBody, now: NOW });
        expect(out).toMatchObject({ ok: true, event: { eventId: "evt_1", envelopeId: "env_1", type: "SIGNED" } });
        expect(out.event.occurredAt.toISOString()).toBe("2026-10-20T09:59:00.000Z");
    });

    it("refuses a bad signature, a tampered body and a wrong secret", () => {
        const { rawBody, headers } = signed(BODY);
        expect(client.verifyWebhook({ provider: "generic", headers: { ...headers, "x-esign-signature": "sha256=" + "0".repeat(64) }, rawBody, now: NOW })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
        const tampered = Buffer.from(rawBody.toString().replace("env_1", "env_2"));
        expect(client.verifyWebhook({ provider: "generic", headers, rawBody: tampered, now: NOW }).ok).toBe(false);
        const other = signed(BODY, { secret: "another" });
        expect(client.verifyWebhook({ provider: "generic", headers: other.headers, rawBody: other.rawBody, now: NOW }).ok).toBe(false);
        expect(client.verifyWebhook({ provider: "generic", headers: {}, rawBody, now: NOW })).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
    });

    it("refuses a stale or future timestamp, and a timestamp moved without re-signing", () => {
        const stale = signed(BODY, { timestamp: String(Number(nowSeconds) - 301) });
        expect(client.verifyWebhook({ provider: "generic", ...stale, now: NOW })).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
        const future = signed(BODY, { timestamp: String(Number(nowSeconds) + 301) });
        expect(client.verifyWebhook({ provider: "generic", ...future, now: NOW }).reason).toBe("STALE_TIMESTAMP");
        const edge = signed(BODY, { timestamp: String(Number(nowSeconds) - 299) });
        expect(client.verifyWebhook({ provider: "generic", ...edge, now: NOW }).ok).toBe(true);
        // Replaying an old delivery with a fresh timestamp breaks the MAC.
        const old = signed(BODY, { timestamp: String(Number(nowSeconds) - 3600) });
        const replay = { ...old.headers, "x-esign-timestamp": nowSeconds };
        expect(client.verifyWebhook({ provider: "generic", headers: replay, rawBody: old.rawBody, now: NOW }).reason).toBe("BAD_SIGNATURE");
    });

    it("a replay inside the window verifies (the event-id dedupe catches it)", () => {
        const delivery = signed(BODY);
        const first = client.verifyWebhook({ provider: "generic", ...delivery, now: NOW });
        const again = client.verifyWebhook({ provider: "generic", ...delivery, now: new Date(NOW.getTime() + 60_000) });
        expect(again.event.eventId).toBe(first.event.eventId);
    });

    it("refuses another provider's path, the none provider, a parsed body and a missing secret", () => {
        const { rawBody, headers } = signed(BODY);
        expect(client.verifyWebhook({ provider: "docusign", headers, rawBody, now: NOW }).reason).toBe("PROVIDER_DISABLED");
        expect(client.verifyWebhook({ provider: "generic", headers, rawBody: JSON.parse(rawBody), now: NOW }).reason).toBe("NO_RAW_BODY");
        delete process.env.ESIGN_WEBHOOK_SECRET;
        expect(client.verifyWebhook({ provider: "generic", headers, rawBody, now: NOW }).reason).toBe("NOT_CONFIGURED");
        process.env.ESIGN_PROVIDER = "none";
        expect(client.verifyWebhook({ provider: "none", headers, rawBody, now: NOW }).reason).toBe("PROVIDER_DISABLED");
    });

    it("a well-signed body without ids is malformed", () => {
        const { rawBody, headers } = signed({ type: "SIGNED" });
        expect(client.verifyWebhook({ provider: "generic", headers, rawBody, now: NOW })).toEqual({ ok: false, reason: "MALFORMED" });
    });

    it("maps provider event types", () => {
        expect(["SENT", "envelope.viewed", "delivered", "COMPLETED", "declined", "expired", "voided", "bounced"].map(client.normalizeEventType)).toEqual([
            "SENT",
            "VIEWED",
            "VIEWED",
            "SIGNED",
            "DECLINED",
            "EXPIRED",
            "VOIDED",
            null,
        ]);
    });
});
