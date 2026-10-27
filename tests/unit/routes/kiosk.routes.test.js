// Recruitment Phase 3b (stream I) — the /kiosk/v1 REST surface over the real
// services and an in-memory database: the workstation token on every request,
// the session bearer token on every route but start, the uniform 404 for
// every bad token, code or state (and the flag being off), rate limits, and
// response bodies that never carry an answer key, a rationale or the pool.
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
jest.unstable_mockModule("../../../src/services/interview-schedule.service.js", () => ({ cancelInterview: jest.fn() }));
jest.unstable_mockModule("../../../src/services/application-workflow.service.js", () => ({ transitionApplicationStage: jest.fn() }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const { kioskRouter, resetKioskRateLimits } = await import("../../../src/routes/kiosk.routes.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");
const reception = await import("../../../src/services/reception.service.js");

const app = express();
app.use("/kiosk/v1", kioskRouter);

const WS_TOKEN = "k".repeat(43);
const OTHER_WS_TOKEN = "m".repeat(43);
const SECRETS = ["answerKey", "rationale", "feedback", "optionIds", "author note", "Because alpha", "sessionCodeHash", "sessionTokenHash"];
const expectClean = (body) => {
    const text = JSON.stringify(body);
    for (const s of SECRETS) expect(text).not.toContain(s);
};
const expectUniform404 = (res) => {
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: "Not found" });
};

async function issueCode() {
    const access = resolveAssessmentAccess(ROLES.reception);
    return mcpCtx.run({ user: ROLES.reception }, async () => {
        await reception.checkInCandidate({ tenantId: TENANT, access, interviewId: 40, idType: "CNIC", idLast4: "1234", consent: true, siteRef: "Lahore" });
        return await reception.issueTestSession({ tenantId: TENANT, access, interviewId: 40, workstationId: 80, siteRef: "Lahore" });
    });
}

const start = (code, token = WS_TOKEN) => request(app).post("/kiosk/v1/sessions/start").set("X-Kiosk-Token", token).send({ code, consent: true });
const withSession = (req, sessionToken, wsToken = WS_TOKEN) => req.set("X-Kiosk-Token", wsToken).set("X-Kiosk-Session", sessionToken);

beforeEach(() => {
    seedOnsite(db);
    recorder.events.length = 0;
    resetKioskRateLimits();
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
});

afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("/kiosk/v1", () => {
    it("runs a whole sitting and never sends a key, a rationale or another item", async () => {
        const { code } = await issueCode();
        const started = await start(code);
        expect(started.status).toBe(200);
        const { sessionId, sessionToken, totalItems, practiceItem } = started.body.data;
        expect(totalItems).toBe(6);
        expect(practiceItem.options).toHaveLength(4);
        expectClean(started.body);

        const practice = await withSession(request(app).put(`/kiosk/v1/sessions/${sessionId}/responses/practice`), sessionToken).send({ answer: { optionId: "a" } });
        expect(practice.body.data).toEqual({ saved: true, practice: true, correct: true });

        const bodies = [];
        for (let n = 1; n <= totalItems; n += 1) {
            const got = await withSession(request(app).get(`/kiosk/v1/sessions/${sessionId}/items/${n}`), sessionToken);
            expect(got.status).toBe(200);
            expect(got.body.data).toMatchObject({ n, total: 6 });
            expect(Object.keys(got.body.data).sort()).toEqual(["answer", "flagged", "mediaId", "n", "navigation", "options", "remainingSec", "sectionKey", "stem", "total", "type"]);
            for (const option of got.body.data.options) expect(Object.keys(option).sort()).toEqual(["id", "text"]);
            bodies.push(got.body);
            const put = await withSession(request(app).put(`/kiosk/v1/sessions/${sessionId}/responses/${n}`), sessionToken).send({ answer: { optionId: "a" }, timeSpentSec: 12 });
            expect(put.status).toBe(200);
        }
        expectClean(bodies);

        const state = await withSession(request(app).get(`/kiosk/v1/sessions/${sessionId}`), sessionToken);
        expect(state.body.data).toMatchObject({ status: "IN_PROGRESS", answered: 6, totalItems: 6, started: true });
        const beat = await withSession(request(app).post(`/kiosk/v1/sessions/${sessionId}/heartbeat`), sessionToken);
        expect(beat.status).toBe(200);
        const flagged = await withSession(request(app).post(`/kiosk/v1/sessions/${sessionId}/integrity-events`), sessionToken).send({ type: "FOCUS_LOST" });
        expect(flagged.body.data).toEqual({ recorded: 1 });

        const unconfirmed = await withSession(request(app).post(`/kiosk/v1/sessions/${sessionId}/submit`), sessionToken).send({});
        expect(unconfirmed.status).toBe(400);
        const done = await withSession(request(app).post(`/kiosk/v1/sessions/${sessionId}/submit`), sessionToken).send({ confirm: true });
        expect(done.status).toBe(200);
        expect(done.body.data).toEqual({ status: "SUBMITTED", message: expect.stringContaining("return to reception") });
        expect(JSON.stringify(done.body)).not.toMatch(/PASSED|band|score/i);
        // Every answer came within two seconds of its item (a test client is
        // fast): the server flagged each one, so the result is for review.
        expect(db.rows("candidateTestIntegrityEvent").filter((e) => e.type === "RAPID_ANSWER")).toHaveLength(6);
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ band: "REVIEW", scorePct: 100 });

        // After submit no more answers.
        const late = await withSession(request(app).put(`/kiosk/v1/sessions/${sessionId}/responses/1`), sessionToken).send({ answer: { optionId: "b" } });
        expectUniform404(late);
    });

    it("answers the same 404 for a missing, unknown or revoked workstation token", async () => {
        const { code } = await issueCode();
        expectUniform404(await request(app).post("/kiosk/v1/sessions/start").send({ code }));
        expectUniform404(await start(code, "z".repeat(43)));
        verifyWorkstationToken.mockResolvedValueOnce({ id: 80, tenantId: TENANT, status: "REVOKED" });
        expectUniform404(await start(code));
        expectUniform404(await request(app).get("/kiosk/v1/anything").set("X-Kiosk-Token", WS_TOKEN));
    });

    it("answers the same 404 for a wrong code, another kiosk, a used code and a bad session token", async () => {
        const { code } = await issueCode();
        expectUniform404(await start(code === "999999" ? "999998" : "999999"));
        expectUniform404(await start(code, OTHER_WS_TOKEN));
        const ok = await start(code);
        expect(ok.status).toBe(200);
        expectUniform404(await start(code));
        const { sessionId, sessionToken } = ok.body.data;
        expectUniform404(await withSession(request(app).get(`/kiosk/v1/sessions/${sessionId}`), "q".repeat(43)));
        expectUniform404(await withSession(request(app).get(`/kiosk/v1/sessions/${sessionId}`), sessionToken, OTHER_WS_TOKEN));
        expectUniform404(await request(app).get(`/kiosk/v1/sessions/${sessionId}`).set("X-Kiosk-Token", WS_TOKEN));
        expectUniform404(await withSession(request(app).get(`/kiosk/v1/sessions/${sessionId + 1}`), sessionToken));
        expectUniform404(await withSession(request(app).get(`/kiosk/v1/sessions/${sessionId}/items/99`), sessionToken));
    });

    it("refuses a malformed answer with a 400 and a malformed body too", async () => {
        const { code } = await issueCode();
        const { sessionId, sessionToken } = (await start(code)).body.data;
        await withSession(request(app).get(`/kiosk/v1/sessions/${sessionId}/items/1`), sessionToken);
        const bad = await withSession(request(app).put(`/kiosk/v1/sessions/${sessionId}/responses/1`), sessionToken).send({ answer: { value: 3 } });
        expect(bad.status).toBe(400);
        const garbled = await withSession(request(app).put(`/kiosk/v1/sessions/${sessionId}/responses/1`), sessionToken)
            .set("Content-Type", "application/json").send("{not json");
        expect(garbled.status).toBe(400);
        expect(garbled.body).toEqual({ success: false, message: "Invalid request" });
    });

    it("rate limits start per workstation", async () => {
        let last;
        for (let i = 0; i < 11; i += 1) last = await start("000000");
        expect(last.status).toBe(429);
    });

    it("is a uniform 404 while the flag is off", async () => {
        const { code } = await issueCode();
        process.env.HR_RECRUITMENT_ONSITE_TEST = "false";
        expectUniform404(await start(code));
        expect(verifyWorkstationToken).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
    });
});
