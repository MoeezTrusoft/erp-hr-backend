// Recruitment Phase 3a — POST /webhooks/esign/:provider: verify first (401,
// nothing written), flag off is a 503 for a verified delivery, a recorded
// event is a 200 whatever its outcome, and a body already parsed by an
// earlier JSON parser cannot be verified.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import express from "express";
import request from "supertest";

const handleEsignWebhookEvent = jest.fn();
jest.unstable_mockModule("../../../src/services/offer-esign.service.js", () => ({ handleEsignWebhookEvent }));

const { esignWebhookRouter } = await import("../../../src/routes/esign-webhook.routes.js");
const { signWebhookPayload } = await import("../../../src/services/esign.client.js");

const ENV_KEYS = ["ESIGN_PROVIDER", "ESIGN_API_BASE", "ESIGN_API_KEY", "ESIGN_WEBHOOK_SECRET", "HR_RECRUITMENT_ESIGN"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const SECRET = "whsec-route-secret";
const app = express();
app.use("/webhooks/esign", esignWebhookRouter);
// The wrong order: a global JSON parser in front of the webhook.
const parsedFirst = express();
parsedFirst.use(express.json());
parsedFirst.use("/webhooks/esign", esignWebhookRouter);

const BODY = JSON.stringify({ eventId: "evt_1", type: "SIGNED", envelopeId: "env_1" });
const signedHeaders = (body = BODY, secret = SECRET) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
        "Content-Type": "application/json",
        "X-Esign-Timestamp": timestamp,
        "X-Esign-Signature": `sha256=${signWebhookPayload(secret, timestamp, Buffer.from(body))}`,
    };
};
const post = (target, headers, body = BODY, provider = "generic") => request(target).post(`/webhooks/esign/${provider}`).set(headers).send(body);

beforeEach(() => {
    jest.clearAllMocks();
    process.env.ESIGN_PROVIDER = "generic";
    process.env.ESIGN_API_BASE = "https://esign.example.test";
    process.env.ESIGN_API_KEY = "k";
    process.env.ESIGN_WEBHOOK_SECRET = SECRET;
    process.env.HR_RECRUITMENT_ESIGN = "true";
    handleEsignWebhookEvent.mockResolvedValue({ outcome: "APPLIED", eventRowId: 1 });
});

describe("POST /webhooks/esign/:provider", () => {
    it("applies a verified delivery and answers 200", async () => {
        const res = await post(app, signedHeaders());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true, outcome: "APPLIED" });
        expect(handleEsignWebhookEvent).toHaveBeenCalledWith(
            expect.objectContaining({ provider: "generic", event: expect.objectContaining({ eventId: "evt_1", envelopeId: "env_1", type: "SIGNED" }) }),
        );
    });

    it("answers a bad signature, a wrong provider and no signature with the same 401, writing nothing", async () => {
        const responses = [
            await post(app, signedHeaders(BODY, "wrong-secret")),
            await post(app, signedHeaders(), BODY, "docusign"),
            await post(app, { "Content-Type": "application/json" }),
        ];
        for (const res of responses) {
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ received: false });
        }
        expect(handleEsignWebhookEvent).not.toHaveBeenCalled();
    });

    it("refuses everything with no provider configured", async () => {
        process.env.ESIGN_PROVIDER = "none";
        expect((await post(app, signedHeaders(), BODY, "none")).status).toBe(401);
        expect(handleEsignWebhookEvent).not.toHaveBeenCalled();
    });

    it("cannot verify a body an earlier JSON parser consumed", async () => {
        const res = await post(parsedFirst, signedHeaders());
        expect(res.status).toBe(401);
        expect(handleEsignWebhookEvent).not.toHaveBeenCalled();
    });

    it("answers a verified delivery 503 with the flag off, writing nothing", async () => {
        process.env.HR_RECRUITMENT_ESIGN = "false";
        const res = await post(app, signedHeaders());
        expect(res.status).toBe(503);
        expect(res.headers["retry-after"]).toBe("3600");
        expect(handleEsignWebhookEvent).not.toHaveBeenCalled();
    });

    it("acknowledges a duplicate and a stored failure with 200", async () => {
        handleEsignWebhookEvent.mockResolvedValueOnce({ outcome: "DUPLICATE", eventRowId: 1 });
        expect((await post(app, signedHeaders())).body.outcome).toBe("DUPLICATE");
        handleEsignWebhookEvent.mockResolvedValueOnce({ outcome: "FAILED", eventRowId: 1 });
        const failed = await post(app, signedHeaders());
        expect(failed.status).toBe(200);
        expect(failed.body.outcome).toBe("FAILED");
    });

    it("answers 500 when the delivery could not be recorded, so the provider retries", async () => {
        handleEsignWebhookEvent.mockRejectedValueOnce(new Error("database down"));
        const res = await post(app, signedHeaders());
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ received: false });
    });

    it("a well-signed body without ids is a 400", async () => {
        const body = JSON.stringify({ type: "SIGNED" });
        const res = await post(app, signedHeaders(body), body);
        expect(res.status).toBe(400);
        expect(handleEsignWebhookEvent).not.toHaveBeenCalled();
    });
});
