// tests/unit/services/kiosk-resume.service.test.js
//
// Recruitment Phase 6 (stream C) — kiosk crash resume (flag kioskResume with
// onsiteTest). Pinned: reception issues a one-time code bound to the same
// IN_PROGRESS or PAUSED session on an active, free kiosk at the session's
// site; the crashed kiosk's token is dead at once; the exchange on the named
// kiosk returns a fresh token with the same drawn items, saved answers and
// flags, and the server clock exactly where it was (no time added, a paused
// clock stays paused); each resume is a PROCTOR KIOSK_RESUME on the timeline (not a flag)
// and an ids-only test_session_resumed event; at most two; codes are single
// use, expire, and every bad exchange is the kiosk's uniform 404.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { makeOnsiteDb, eventRecorder } from "./helpers/onsite-test.fake.js";
import { TENANT, ROLES, seedOnsite, sessionOf } from "./helpers/onsite-test.seed.js";

const db = makeOnsiteDb();
const recorder = eventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: recorder.enqueueHrDomainEvent,
    default: recorder.enqueueHrDomainEvent,
}));
jest.unstable_mockModule("../../../src/services/interviewSchedule.service.js", () => ({ cancelInterview: jest.fn() }));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({ transitionApplicationStage: jest.fn() }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");
const reception = await import("../../../src/services/reception.service.js");
const kiosk = await import("../../../src/services/test-session.service.js");
const { seededRng } = await import("../../../src/services/test-session-assembly.service.js");

const MIN = 60 * 1000;
const T0 = new Date("2026-10-20T05:00:00.000Z");
const at = (minutes, seconds = 0) => new Date(T0.getTime() + minutes * MIN + seconds * 1000);
const WS = { id: 80, tenantId: TENANT, siteRef: "Lahore", label: "Kiosk 1", status: "ACTIVE" };
const WS2 = { id: 81, tenantId: TENANT, siteRef: "Lahore", label: "Kiosk 2", status: "ACTIVE" };

const as = (role, fn) => mcpCtx.run({ user: ROLES[role] }, async () => await fn(resolveAssessmentAccess(ROLES[role])));
const kioskCtx = (fn) => mcpCtx.run({ user: { tenantId: TENANT }, kiosk: true }, async () => await fn());
const expectNotFound = (promise) => expect(promise).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-KIOSK-NOT-FOUND" });

async function sitting() {
    await as("reception", (access) => reception.checkInCandidate({
        tenantId: TENANT, access, actorId: 50, interviewId: 40, idType: "CNIC", idLast4: "1234", consent: true, siteRef: "Lahore", now: T0,
    }));
    const issued = await as("reception", (access) => reception.issueTestSession({
        tenantId: TENANT, access, actorId: 50, interviewId: 40, workstationId: 80, siteRef: "Lahore", now: T0,
    }));
    const started = await kioskCtx(() => kiosk.startKioskSession({ tenantId: TENANT, workstation: WS, code: issued.code, consent: true, now: at(1), rng: seededRng(7) }));
    return { sessionId: started.sessionId, token: started.sessionToken };
}

const resumeCode = (sessionId, over = {}) => as("reception", (access) => reception.issueKioskResumeCode({
    tenantId: TENANT, access, actorId: 50, sessionId, workstationId: 81, siteRef: "Lahore", reason: "Kiosk 1 froze", now: at(10), ...over,
}));
const exchange = (code, { workstation = WS2, now = at(11) } = {}) => kioskCtx(() => kiosk.resumeKioskSession({ tenantId: TENANT, workstation, code, now }));
const item = (s, n, now, workstation = WS) => kioskCtx(() => kiosk.getKioskItem({ tenantId: TENANT, workstation, sessionId: s.sessionId, sessionToken: s.token, n, now }));
const answer = (s, n, ans, now, over = {}) => kioskCtx(() => kiosk.saveKioskResponse({
    tenantId: TENANT, workstation: WS, sessionId: s.sessionId, sessionToken: s.token, itemRef: String(n), answer: ans, timeSpentSec: 20, now, ...over,
}));
const resumeEvents = (sessionId) => db.rows("candidateTestIntegrityEvent").filter((e) => e.sessionId === sessionId && e.type === "KIOSK_RESUME" && e.source === "PROCTOR");

beforeEach(() => {
    seedOnsite(db);
    recorder.events.length = 0;
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
    process.env.HR_RECRUITMENT_KIOSK_RESUME = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
    delete process.env.HR_RECRUITMENT_KIOSK_RESUME;
});

describe("kiosk crash resume", () => {
    it("moves the sitting to another kiosk with the same items, answers and clock", async () => {
        const s = await sitting();
        await item(s, 1, at(2)); // the clock starts: deadline at(32)
        await answer(s, 1, { optionId: "a" }, at(3));
        await item(s, 2, at(4));
        await answer(s, 2, null, at(5), { flagged: true });
        const order = structuredClone(sessionOf(db, s.sessionId).itemOrder);
        const deadline = sessionOf(db, s.sessionId).deadlineAt.getTime();

        const issued = await resumeCode(s.sessionId);
        expect(issued).toMatchObject({ sessionId: s.sessionId, workstation: { id: 81, label: "Kiosk 2" }, status: "IN_PROGRESS", resumeNo: 1, resumesLeft: 1 });
        expect(issued.code).toMatch(/^\d{6}$/);
        // The crashed kiosk is out at once, and that is not another device change.
        await expectNotFound(item(s, 1, at(10, 30)));
        expect(resumeEvents(s.sessionId)).toHaveLength(1);

        const out = await exchange(issued.code);
        expect(out).toMatchObject({
            sessionId: s.sessionId,
            resumed: true,
            status: "IN_PROGRESS",
            totalItems: 6,
            started: true,
            answered: 1,
            currentItem: 2,
            remainingSec: 21 * 60, // deadline at(32), now at(11): the crash time was not given back
        });
        expect(out.sessionToken).not.toBe(s.token);
        expect(out.progress.slice(0, 3)).toEqual([
            { n: 1, served: true, answered: true, flagged: false },
            { n: 2, served: true, answered: false, flagged: true },
            { n: 3, served: false, answered: false, flagged: false },
        ]);
        expect(out.practiceItem).toBeUndefined();
        const row = sessionOf(db, s.sessionId);
        expect(row.itemOrder).toEqual(order);
        expect(row.deadlineAt.getTime()).toBe(deadline);
        expect(row).toMatchObject({ workstationId: 81, sessionCodeHash: null, extraTimePct: 0, pausedTotalSec: 0 });
        expect(JSON.stringify(out)).not.toMatch(/answerKey|rationale|itemId|sessionCodeHash/);

        // The new kiosk reads the saved answer back; the old token stays dead.
        const resumed = { sessionId: s.sessionId, token: out.sessionToken };
        const first = await item(resumed, 1, at(12), WS2);
        expect(first).toMatchObject({ n: 1, answer: { optionId: "a" }, remainingSec: 20 * 60 });
        await expectNotFound(item(s, 1, at(12), WS2));
        // The resume refreshed the heartbeat: no network-loss flag for the crash.
        await kioskCtx(() => kiosk.kioskHeartbeat({ tenantId: TENANT, workstation: WS2, sessionId: s.sessionId, sessionToken: out.sessionToken, now: at(11, 30) }));
        expect(db.rows("candidateTestIntegrityEvent").filter((e) => e.type === "NETWORK_LOSS")).toHaveLength(0);

        const [event] = resumeEvents(s.sessionId);
        expect(event.detail).toMatchObject({ reason: "KIOSK_RESUME", resumeNo: 1, fromWorkstationId: 80, toWorkstationId: 81, byId: 50, note: "Kiosk 1 froze" });
        const [domain] = recorder.named("test_session_resumed");
        expect(domain.payload).toEqual({
            sessionId: String(s.sessionId), interviewId: "40", applicationId: "9", candidateId: "5",
            workstationId: "81", previousWorkstationId: "80", resumeNo: 1,
        });
    });

    it("keeps a paused sitting paused, its remaining time frozen", async () => {
        const s = await sitting();
        await item(s, 1, at(2));
        await as("reception", (access) => reception.pauseTestSession({ tenantId: TENANT, access, sessionId: s.sessionId, siteRef: "Lahore", now: at(6) }));
        const issued = await resumeCode(s.sessionId);
        const out = await exchange(issued.code, { now: at(20) });
        expect(out).toMatchObject({ status: "PAUSED", remainingSec: 26 * 60 });
        await as("reception", (access) => reception.resumeTestSession({ tenantId: TENANT, access, sessionId: s.sessionId, siteRef: "Lahore", now: at(21) }));
        const state = await kioskCtx(() => kiosk.getKioskSessionState({ tenantId: TENANT, workstation: WS2, sessionId: s.sessionId, sessionToken: out.sessionToken, now: at(21) }));
        expect(state).toMatchObject({ status: "IN_PROGRESS", remainingSec: 26 * 60 });
    });

    it("resumes before the clock started with the practice item, on the restarted kiosk itself", async () => {
        const s = await sitting();
        const issued = await resumeCode(s.sessionId, { workstationId: 80 });
        const out = await exchange(issued.code, { workstation: WS });
        expect(out).toMatchObject({ started: false, remainingSec: 30 * 60, practiceItem: { ref: "practice" } });
    });

    it("is single use, bound to the named kiosk and expires", async () => {
        const s = await sitting();
        const issued = await resumeCode(s.sessionId);
        await expectNotFound(exchange(issued.code, { workstation: WS }));
        await expectNotFound(exchange(issued.code === "000000" ? "000001" : "000000"));
        await expectNotFound(exchange("12ab56"));
        await expectNotFound(exchange(issued.code, { now: at(26) }));
        const again = await resumeCode(s.sessionId, { now: at(27) });
        await exchange(again.code, { now: at(28) });
        await expectNotFound(exchange(again.code, { now: at(28) }));
    });

    it("allows two resumes, then refuses", async () => {
        const s = await sitting();
        await item(s, 1, at(2));
        await exchange((await resumeCode(s.sessionId)).code);
        await exchange((await resumeCode(s.sessionId, { workstationId: 80, now: at(12) })).code, { workstation: WS, now: at(13) });
        await expect(resumeCode(s.sessionId, { now: at(14) })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-KIOSK-RESUME-LIMIT" });
        expect(resumeEvents(s.sessionId)).toHaveLength(2);
        const live = await as("reception", (access) => reception.listLiveSessions({ tenantId: TENANT, access, siteRef: "Lahore", now: at(14) }));
        // A resume is on the timeline but is not the candidate's flag.
        expect(live.items[0]).toMatchObject({ resumeCount: 2, resumeCodeExpiresAt: null, integrityFlagCount: 0 });
    });

    it("stays at the session's site, on a free active kiosk", async () => {
        const s = await sitting();
        await expect(resumeCode(s.sessionId, { workstationId: 82 })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-TEST-WORKSTATION-NOT-FOUND" });
        await expect(resumeCode(s.sessionId, { workstationId: 83 })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-TEST-WORKSTATION-NOT-FOUND" });
        await expect(as("recruiter", (access) => reception.issueKioskResumeCode({ tenantId: TENANT, access, sessionId: s.sessionId, workstationId: 82, now: at(10) })))
            .rejects.toMatchObject({ status: 404 });
        await expect(resumeCode(s.sessionId, { siteRef: "Karachi" })).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-TEST-SESSION-NOT-FOUND" });
        db.rows("candidateTestSession").push({ id: 4999, tenantId: TENANT, interviewId: 41, workstationId: 81, siteRef: "Lahore", status: "IN_PROGRESS" });
        await expect(resumeCode(s.sessionId)).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-WORKSTATION-BUSY" });
        // Nothing was revoked by a refused issue.
        expect(sessionOf(db, s.sessionId)).toMatchObject({ workstationId: 80 });
        expect(sessionOf(db, s.sessionId).sessionTokenHash).not.toBeNull();
    });

    it("refuses a settled sitting or one out of time, and submits one whose time ran out before the exchange", async () => {
        const s = await sitting();
        await item(s, 1, at(2));
        await expect(resumeCode(s.sessionId, { now: at(40) })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-SESSION-STATE" });
        const issued = await resumeCode(s.sessionId, { now: at(30) });
        await expectNotFound(exchange(issued.code, { now: at(33) }));
        expect(sessionOf(db, s.sessionId).status).toBe("SUBMITTED");
        await expect(resumeCode(s.sessionId, { now: at(34) })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-SESSION-STATE" });
    });

    it("is off with the flag: 503 at reception, the uniform 404 at the kiosk", async () => {
        const s = await sitting();
        const issued = await resumeCode(s.sessionId);
        delete process.env.HR_RECRUITMENT_KIOSK_RESUME;
        await expect(resumeCode(s.sessionId)).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-KIOSK-RESUME-DISABLED" });
        await expectNotFound(exchange(issued.code));
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        process.env.HR_RECRUITMENT_KIOSK_RESUME = "true";
        await expect(resumeCode(s.sessionId)).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" });
    });

    it("shows a waiting resume code on the live grid, never the code", async () => {
        const s = await sitting();
        const issued = await resumeCode(s.sessionId);
        const live = await as("reception", (access) => reception.listLiveSessions({ tenantId: TENANT, access, siteRef: "Lahore", now: at(10, 30) }));
        expect(live.items[0]).toMatchObject({ sessionId: s.sessionId, workstation: { id: 81 }, resumeCount: 1, resumeCodeExpiresAt: issued.codeExpiresAt });
        expect(JSON.stringify(live)).not.toContain(issued.code);
        expect(JSON.stringify(live)).not.toMatch(/sessionCodeHash/);
    });
});
