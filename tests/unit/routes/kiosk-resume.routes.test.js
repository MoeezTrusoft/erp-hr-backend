// tests/unit/routes/kiosk-resume.routes.test.js
//
// Recruitment Phase 6 (stream C) — POST /kiosk/v1/sessions/resume over the
// real services and the in-memory database: a reception resume code moves the
// sitting to the named kiosk, the crashed kiosk's token is dead, every bad
// exchange (and the flag being off) is the uniform 404, and the route shares
// start's rate budget.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import { makeOnsiteDb, eventRecorder } from "../services/helpers/onsite-test.fake.js";
import { TENANT, ROLES, seedOnsite } from "../services/helpers/onsite-test.seed.js";

const db = makeOnsiteDb();
const recorder = eventRecorder();
const KIOSK_TOKENS = {
    ["k".repeat(43)]: { id: 80, tenantId: TENANT, label: "Kiosk 1", siteRef: "Lahore", status: "ACTIVE" },
    ["m".repeat(43)]: { id: 81, tenantId: TENANT, label: "Kiosk 2", siteRef: "Lahore", status: "ACTIVE" },
};
const verifyWorkstationToken = jest.fn(async (raw) => KIOSK_TOKENS[raw] ?? null);

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: recorder.enqueueHrDomainEvent,
    default: recorder.enqueueHrDomainEvent,
}));
jest.unstable_mockModule("../../../src/services/test-workstation.service.js", () => ({ verifyWorkstationToken }));
jest.unstable_mockModule("../../../src/services/interviewSchedule.service.js", () => ({ cancelInterview: jest.fn() }));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({ transitionApplicationStage: jest.fn() }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const { kioskRouter, resetKioskRateLimits } = await import("../../../src/routes/kiosk.routes.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");
const reception = await import("../../../src/services/reception.service.js");

const app = express();
app.set("trust proxy", true);
app.use("/kiosk/v1", kioskRouter);

const WS_TOKEN = "k".repeat(43);
const OTHER_WS_TOKEN = "m".repeat(43);
const expectUniform404 = (res) => {
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: "Not found" });
};
const asReception = (fn) => mcpCtx.run({ user: ROLES.reception }, async () => await fn(resolveAssessmentAccess(ROLES.reception)));
const resume = (code, token = OTHER_WS_TOKEN, ip = "10.0.0.1") =>
    request(app).post("/kiosk/v1/sessions/resume").set("X-Forwarded-For", ip).set("X-Kiosk-Token", token).send({ code });

async function running() {
    const { code } = await asReception(async (access) => {
        await reception.checkInCandidate({ tenantId: TENANT, access, interviewId: 40, idType: "CNIC", idLast4: "1234", consent: true, siteRef: "Lahore" });
        return await reception.issueTestSession({ tenantId: TENANT, access, interviewId: 40, workstationId: 80, siteRef: "Lahore" });
    });
    const started = await request(app).post("/kiosk/v1/sessions/start").set("X-Kiosk-Token", WS_TOKEN).send({ code, consent: true });
    const { sessionId, sessionToken } = started.body.data;
    await request(app).get(`/kiosk/v1/sessions/${sessionId}/items/1`).set("X-Kiosk-Token", WS_TOKEN).set("X-Kiosk-Session", sessionToken);
    return { sessionId, sessionToken };
}

beforeEach(() => {
    seedOnsite(db);
    recorder.events.length = 0;
    resetKioskRateLimits();
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
    process.env.HR_RECRUITMENT_KIOSK_RESUME = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
    delete process.env.HR_RECRUITMENT_KIOSK_RESUME;
});

describe("POST /kiosk/v1/sessions/resume", () => {
    it("hands the sitting to the named kiosk with a fresh token; the crashed kiosk is out", async () => {
        const s = await running();
        const { code } = await asReception((access) => reception.issueKioskResumeCode({ tenantId: TENANT, access, sessionId: s.sessionId, workstationId: 81, siteRef: "Lahore" }));
        const old = await request(app).get(`/kiosk/v1/sessions/${s.sessionId}`).set("X-Kiosk-Token", WS_TOKEN).set("X-Kiosk-Session", s.sessionToken);
        expectUniform404(old);

        const res = await resume(code);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ sessionId: s.sessionId, resumed: true, status: "IN_PROGRESS", totalItems: 6, started: true });
        expect(JSON.stringify(res.body)).not.toMatch(/answerKey|rationale|sessionCodeHash|sessionTokenHash|itemId/);
        const item = await request(app).get(`/kiosk/v1/sessions/${s.sessionId}/items/1`).set("X-Kiosk-Token", OTHER_WS_TOKEN).set("X-Kiosk-Session", res.body.data.sessionToken);
        expect(item.status).toBe(200);
        expect(item.body.data).toMatchObject({ n: 1 });

        expectUniform404(await resume(code));
    });

    it("answers the uniform 404 for a wrong kiosk, a bad code and the flag off", async () => {
        const s = await running();
        const { code } = await asReception((access) => reception.issueKioskResumeCode({ tenantId: TENANT, access, sessionId: s.sessionId, workstationId: 81, siteRef: "Lahore" }));
        expectUniform404(await resume(code, WS_TOKEN));
        expectUniform404(await resume("abc"));
        expectUniform404(await resume(code, "z".repeat(43)));
        delete process.env.HR_RECRUITMENT_KIOSK_RESUME;
        expectUniform404(await resume(code));
        process.env.HR_RECRUITMENT_KIOSK_RESUME = "true";
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        expectUniform404(await resume(code));
    });

    it("shares start's rate budget (the code guessing surface)", async () => {
        let last;
        for (let i = 0; i < 21; i += 1) last = await resume("000000", OTHER_WS_TOKEN, "10.9.9.9");
        expect(last.status).toBe(429);
    });
});
