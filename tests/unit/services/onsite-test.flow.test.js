// Recruitment Phase 3b (stream I) — the interview-day test end to end at the
// service layer: reception check-in and code issue, the kiosk sitting (code
// single use, expiry and kiosk binding, one item per request with no key,
// the server clock, pause maths, late answers, forward-only, integrity),
// scoring and the band, auto-release, the recruiter's decisions, the report
// and its scope, proctor void and extend, and the minute job.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { makeOnsiteDb, eventRecorder } from "./helpers/onsite-test.fake.js";
import { TENANT, ROLES, seedOnsite, interviewOf, sessionOf, addItem } from "./helpers/onsite-test.seed.js";

const db = makeOnsiteDb();
const recorder = eventRecorder();

const cancelInterview = jest.fn(async ({ interviewId, db: tx }) => {
    await tx.interview.updateMany({ where: { id: interviewId, tenantId: TENANT }, data: { status: "CANCELLED", calendarSyncAction: "CANCEL" } });
    return { interviewId, status: "CANCELLED" };
});
const transitionApplicationStage = jest.fn(async ({ id, targetStage, db: tx }) => {
    await tx.application.updateMany({ where: { id, tenantId: TENANT }, data: { stage: targetStage } });
    return { success: true, changed: true };
});
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: recorder.enqueueHrDomainEvent,
    default: recorder.enqueueHrDomainEvent,
}));
jest.unstable_mockModule("../../../src/services/interviewSchedule.service.js", () => ({ cancelInterview }));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({ transitionApplicationStage }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");
const reception = await import("../../../src/services/reception.service.js");
const kiosk = await import("../../../src/services/test-session.service.js");
const results = await import("../../../src/services/test-result.service.js");
const { seededRng } = await import("../../../src/services/test-session-assembly.service.js");

const MIN = 60 * 1000;
const T0 = new Date("2026-10-20T05:00:00.000Z");
const at = (minutes, seconds = 0) => new Date(T0.getTime() + minutes * MIN + seconds * 1000);
const WS = { id: 80, tenantId: TENANT, siteRef: "Lahore", label: "Kiosk 1", status: "ACTIVE" };
const WS2 = { id: 81, tenantId: TENANT, siteRef: "Lahore", label: "Kiosk 2", status: "ACTIVE" };

const as = (role, fn) => mcpCtx.run({ user: ROLES[role] }, async () => await fn(resolveAssessmentAccess(ROLES[role])));
const kioskCtx = (fn) => mcpCtx.run({ user: { tenantId: TENANT }, kiosk: true }, async () => await fn());
const json = (v) => JSON.stringify(v);

async function checkIn(over = {}) {
    return as("reception", (access) => reception.checkInCandidate({
        tenantId: TENANT, access, actorId: 50, interviewId: 40, idType: "CNIC", idLast4: "1234", consent: true, siteRef: "Lahore", now: T0, ...over,
    }));
}

async function issue(over = {}) {
    return as("reception", (access) => reception.issueTestSession({
        tenantId: TENANT, access, actorId: 50, interviewId: 40, workstationId: 80, siteRef: "Lahore", now: T0, ...over,
    }));
}

async function start(code, { workstation = WS, now = at(1) } = {}) {
    return kioskCtx(() => kiosk.startKioskSession({ tenantId: TENANT, workstation, code, consent: true, now, rng: seededRng(7) }));
}

/** Check in, issue, start: the running sitting's id and bearer token. */
async function sitting() {
    await checkIn();
    const issued = await issue();
    const started = await start(issued.code);
    return { ...started, sessionId: started.sessionId, token: started.sessionToken };
}

const ctx = (s, over = {}) => ({ tenantId: TENANT, workstation: WS, sessionId: s.sessionId, sessionToken: s.token, ...over });
const item = (s, n, now) => kioskCtx(() => kiosk.getKioskItem({ ...ctx(s), n, now }));
const answer = (s, n, ans, now, over = {}) => kioskCtx(() => kiosk.saveKioskResponse({ ...ctx(s), itemRef: String(n), answer: ans, timeSpentSec: 20, now, ...over }));
const submit = (s, now) => kioskCtx(() => kiosk.submitKioskSession({ ...ctx(s), confirm: true, now }));

/** Serve every item and answer it right (`correct(n)` true) or wrong. */
async function answerAll(s, correct = () => true, startMinute = 2) {
    const total = sessionOf(db, s.sessionId).itemOrder.length;
    for (let n = 1; n <= total; n += 1) {
        await item(s, n, at(startMinute + n));
        await answer(s, n, { optionId: correct(n) ? "a" : "b" }, at(startMinute + n, 30));
    }
}

const expectNotFound = (promise) => expect(promise).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-KIOSK-NOT-FOUND" });

beforeEach(() => {
    seedOnsite(db);
    recorder.events.length = 0;
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
});

afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("reception: arrivals and check-in", () => {
    it("lists today's assessment interviews at the site with names and no score or band", async () => {
        const out = await as("reception", (access) => reception.listArrivals({ tenantId: TENANT, access, siteRef: "Lahore" }));
        expect(out.items).toHaveLength(1);
        expect(out.items[0]).toMatchObject({ interviewId: 40, candidateName: "Ayesha Khan", assessmentStatus: "AWAITING_CHECK_IN", checkedIn: false, session: null });
        const all = await as("recruiter", (access) => reception.listArrivals({ tenantId: TENANT, access }));
        expect(all.items.map((i) => i.interviewId).sort()).toEqual([40, 41]);
    });

    it("needs a site for reception, and the reception capability", async () => {
        await expect(as("reception", (access) => reception.listArrivals({ tenantId: TENANT, access }))).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-RECEPTION-SITE-REQUIRED" });
        await expect(as("panelist", (access) => reception.listArrivals({ tenantId: TENANT, access, siteRef: "Lahore" }))).rejects.toMatchObject({ status: 403 });
    });

    it("checks in with consent and the last four characters only, and emits candidate_checked_in", async () => {
        const out = await checkIn();
        expect(out).toMatchObject({ interviewId: 40, assessmentStatus: "CHECKED_IN" });
        const row = db.rows("candidateCheckIn")[0];
        expect(row).toMatchObject({ interviewId: 40, candidateId: 5, idType: "CNIC", idLast4: "1234", verifiedById: 50, siteRef: "Lahore" });
        expect(row.consentAt).toBeInstanceOf(Date);
        expect(interviewOf(db).assessmentStatus).toBe("CHECKED_IN");
        expect(recorder.named("candidate_checked_in")).toHaveLength(1);
        expect(recorder.named("candidate_checked_in")[0].payload).toMatchObject({ interviewId: "40", candidateId: "5" });
        await expect(checkIn()).rejects.toMatchObject({ status: 409 });
    });

    it("refuses without consent, with a malformed ID suffix, or at another site", async () => {
        await expect(checkIn({ consent: false })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-CHECKIN-CONSENT-REQUIRED" });
        await expect(checkIn({ idLast4: "12345" })).rejects.toMatchObject({ status: 400 });
        await expect(checkIn({ idLast4: "12" })).rejects.toMatchObject({ status: 400 });
        await expect(checkIn({ siteRef: "Karachi" })).rejects.toMatchObject({ status: 404 });
        expect(db.rows("candidateCheckIn")).toHaveLength(0);
    });

    it("lets only a recruiter grant extra time, with a reason, within the cap", async () => {
        await expect(checkIn({ accommodations: { extraTimePct: 25 }, accommodationReason: "Dyslexia" })).rejects.toMatchObject({ status: 403 });
        await expect(checkIn({ accommodations: { largeText: true } })).rejects.toMatchObject({ status: 400 });
        const recruiterCheckIn = (over) => as("recruiter", (access) => reception.checkInCandidate({
            tenantId: TENANT, access, actorId: 1, interviewId: 40, idType: "CNIC", idLast4: "1234", consent: true, now: T0, ...over,
        }));
        await expect(recruiterCheckIn({ accommodations: { extraTimePct: 60 }, accommodationReason: "x" })).rejects.toMatchObject({ code: "HR-RECRUITMENT-TEST-EXTRA-TIME-CAP" });
        const ok = await recruiterCheckIn({ accommodations: { extraTimePct: 25, largeText: true }, accommodationReason: "Approved by HR" });
        expect(ok.accommodations).toMatchObject({ extraTimePct: 25, largeText: true });
    });
});

describe("reception: code issue", () => {
    it("refuses before check-in", async () => {
        await expect(issue()).rejects.toMatchObject({ status: 409 });
    });

    it("issues a six-digit code once, stores only its salted hash, valid for 15 minutes", async () => {
        await checkIn();
        const out = await issue();
        expect(out.code).toMatch(/^\d{6}$/);
        expect(out.codeExpiresAt).toEqual(at(15));
        const row = sessionOf(db, out.sessionId);
        expect(row).toMatchObject({ status: "ISSUED", workstationId: 80, siteRef: "Lahore", blueprintId: 70, blueprintVersion: 2, attemptNo: 1 });
        expect(row.sessionCodeHash).toBe(kiosk.hashSessionCode({ tenantId: TENANT, sessionId: out.sessionId, code: out.code }));
        expect(json(db.rows("candidateTestSession"))).not.toContain(`"${out.code}"`);
        expect(recorder.named("test_session_issued")).toHaveLength(1);
    });

    it("refuses a second live session, a busy kiosk, a revoked kiosk and a kiosk at another site", async () => {
        await checkIn();
        await expect(issue({ workstationId: 83 })).rejects.toMatchObject({ status: 404 });
        await expect(issue({ workstationId: 82 })).rejects.toMatchObject({ status: 404 });
        await issue();
        await expect(issue({ workstationId: 81 })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-SESSION-LIVE" });
        // Another candidate cannot be put on the busy kiosk.
        interviewOf(db, 41).location = "Lahore annex";
        await as("reception", (access) => reception.checkInCandidate({ tenantId: TENANT, access, interviewId: 41, idType: "CNIC", idLast4: "9999", consent: true, siteRef: "Lahore", now: T0 }));
        await expect(issue({ interviewId: 41 })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-WORKSTATION-BUSY" });
    });

    it("carries the check-in's extra time to the session", async () => {
        await as("recruiter", (access) => reception.checkInCandidate({
            tenantId: TENANT, access, interviewId: 40, idType: "CNIC", idLast4: "1234", consent: true,
            accommodations: { extraTimePct: 20 }, accommodationReason: "Approved", now: T0,
        }));
        const out = await issue();
        expect(sessionOf(db, out.sessionId).extraTimePct).toBe(20);
    });
});

describe("kiosk: start (code verify, single use, expiry, binding)", () => {
    it("starts with the right code on the bound kiosk and draws the test", async () => {
        await checkIn();
        const issued = await issue();
        const out = await start(issued.code);
        expect(out.sessionToken).toHaveLength(43);
        expect(out).toMatchObject({ totalItems: 6, durationMin: 30, durationSec: 1800, remainingSec: 1800, navigation: "FREE" });
        expect(out.practiceItem).toMatchObject({ ref: "practice", practice: true });
        const row = sessionOf(db, out.sessionId);
        expect(row).toMatchObject({ status: "IN_PROGRESS", sessionCodeHash: null, startedAt: null });
        expect(row.sessionTokenHash).toBe(kiosk.hashSessionToken(out.sessionToken));
        expect(row.consentAt).toEqual(at(1));
        expect(interviewOf(db).assessmentStatus).toBe("IN_PROGRESS");
    });

    it("is single use, expires after 15 minutes and is bound to its kiosk", async () => {
        await checkIn();
        const issued = await issue();
        const wrong = issued.code === "000000" ? "000001" : "000000";
        await expectNotFound(start(wrong));
        await expectNotFound(start(issued.code, { workstation: WS2 }));
        await expectNotFound(start(issued.code, { now: at(16) }));
        await expectNotFound(start("12ab56"));
        await start(issued.code);
        await expectNotFound(start(issued.code));
    });

    it("works on any kiosk at the site when the blueprint allows it", async () => {
        seedOnsite(db, { blueprint: { allowAnySiteKiosk: true } });
        await checkIn();
        const issued = await issue();
        await expectNotFound(start(issued.code, { workstation: { id: 82, tenantId: TENANT, siteRef: "Karachi" } }));
        const out = await start(issued.code, { workstation: WS2 });
        expect(sessionOf(db, out.sessionId).workstationId).toBe(81);
    });
});

describe("kiosk: assembly", () => {
    it("draws per section and difficulty, freezes versions and option orders, counts exposure", async () => {
        const s = await sitting();
        const order = sessionOf(db, s.sessionId).itemOrder;
        const items = new Map(db.rows("candidateTestItem").map((i) => [i.id, i]));
        const per = (sectionKey, difficulty) => order.filter((e) => e.sectionKey === sectionKey && items.get(e.itemId).difficulty === difficulty).length;
        expect([per("domain", "EASY"), per("domain", "MEDIUM"), per("domain", "HARD")]).toEqual([1, 2, 1]);
        expect([per("safety", "EASY"), per("safety", "MEDIUM")]).toEqual([1, 1]);
        for (const entry of order) {
            expect(entry.itemVersion).toBe(items.get(entry.itemId).version);
            expect([...entry.optionOrder].sort()).toEqual(["a", "b", "c", "d"]);
            expect(items.get(entry.itemId).exposureCount).toBe(1);
        }
        expect(order.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("never draws an item code the candidate saw before, and respects the exposure cap", async () => {
        const first = await sitting();
        const seen = new Set(sessionOf(db, first.sessionId).itemOrder.map((e) => e.itemCode));
        // Retest path: a fresh session for the same candidate on a deeper pool.
        for (const difficulty of ["EASY", "MEDIUM", "MEDIUM", "HARD"]) addItem(db, { difficulty, competencyKey: "DOMAIN" });
        for (const difficulty of ["EASY", "MEDIUM"]) addItem(db, { difficulty, competencyKey: "SAFETY" });
        const capped = addItem(db, { difficulty: "HARD", competencyKey: "DOMAIN", exposureCount: 5, exposureCap: 5 });
        await kioskCtx(() => results.recordIncompleteResult(db, { session: sessionOf(db, first.sessionId) }));
        sessionOf(db, first.sessionId).status = "VOIDED";
        interviewOf(db).assessmentStatus = "CHECKED_IN";
        const again = await issue({ workstationId: 81 });
        const second = await start(again.code, { workstation: WS2 });
        const codes = sessionOf(db, second.sessionId).itemOrder.map((e) => e.itemCode);
        expect(codes.filter((c) => seen.has(c))).toEqual([]);
        expect(codes).not.toContain(capped.itemCode);
        expect(sessionOf(db, second.sessionId)).toMatchObject({ attemptNo: 2, previousSessionId: first.sessionId });
    });

    it("is deterministic under a seeded RNG", async () => {
        const one = await sitting();
        const orderA = sessionOf(db, one.sessionId).itemOrder.map(({ itemId, optionOrder }) => ({ itemId, optionOrder }));
        seedOnsite(db);
        const two = await sitting();
        const orderB = sessionOf(db, two.sessionId).itemOrder.map(({ itemId, optionOrder }) => ({ itemId, optionOrder }));
        expect(orderB).toEqual(orderA);
    });

    it("refuses to start (and keeps the code) when a section's pool is too shallow", async () => {
        db.state.tables.candidateTestItem = db.rows("candidateTestItem").filter((i) => i.competencyKey !== "SAFETY").concat(
            addItem(db, { competencyKey: "SAFETY", difficulty: "EASY" }),
        );
        await checkIn();
        const issued = await issue();
        await expect(start(issued.code)).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-POOL-TOO-SHALLOW" });
        expect(sessionOf(db, issued.sessionId)).toMatchObject({ status: "ISSUED" });
        expect(sessionOf(db, issued.sessionId).sessionCodeHash).not.toBeNull();
    });
});

describe("kiosk: one item per request, never the key", () => {
    it("serves the stem and the frozen option order only, and starts the clock at item 1", async () => {
        const s = await sitting();
        const practice = await item(s, "practice", at(2));
        expect(practice).toMatchObject({ practice: true });
        expect(sessionOf(db, s.sessionId).startedAt).toBeNull();
        const first = await item(s, 1, at(3));
        const entry = sessionOf(db, s.sessionId).itemOrder[0];
        expect(first.options.map((o) => o.id)).toEqual(entry.optionOrder);
        expect(first).toMatchObject({ n: 1, total: 6, type: "SINGLE", answer: null, flagged: false, remainingSec: 1800 });
        const body = json([practice, first]);
        for (const secret of ["answerKey", "rationale", "feedback", "optionIds", "author note", "Because alpha"]) expect(body).not.toContain(secret);
        expect(sessionOf(db, s.sessionId)).toMatchObject({ startedAt: at(3), deadlineAt: at(33) });
        expect(recorder.named("test_session_started")).toHaveLength(1);
        expect(recorder.named("test_session_started")[0].payload.interviewerIds).toEqual(["3", "4"]);
    });

    it("validates the answer shape and the option ids", async () => {
        const s = await sitting();
        await item(s, 1, at(3));
        await expect(answer(s, 1, { optionIds: ["a"] }, at(4))).rejects.toMatchObject({ status: 400 });
        await expect(answer(s, 1, { optionId: "z" }, at(4))).rejects.toMatchObject({ status: 400 });
        await expectNotFound(answer(s, 2, { optionId: "a" }, at(4))); // never served
        await expect(answer(s, 1, { optionId: "c" }, at(4))).resolves.toMatchObject({ saved: true, n: 1 });
        const again = await item(s, 1, at(5));
        expect(again.answer).toEqual({ optionId: "c" });
        await answer(s, 1, undefined, at(5), { flagged: true });
        expect(db.rows("candidateTestResponse")[0]).toMatchObject({ flagged: true, answer: { optionId: "c" }, itemVersion: 1 });
    });

    it("records a RAPID_ANSWER server-side when an answer arrives within two seconds", async () => {
        const s = await sitting();
        await item(s, 1, at(3));
        await answer(s, 1, { optionId: "a" }, at(3, 1));
        await item(s, 2, at(4));
        await answer(s, 2, { optionId: "a" }, at(4, 10));
        const events = db.rows("candidateTestIntegrityEvent");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: "RAPID_ANSWER", source: "SERVER", detail: { n: 1, elapsedMs: 1000 } });
    });

    it("records DEVICE_CHANGE for the token from another kiosk, or another token on its kiosk", async () => {
        const s = await sitting();
        await expectNotFound(kioskCtx(() => kiosk.getKioskSessionState({ ...ctx(s), workstation: WS2, now: at(3) })));
        await expectNotFound(kioskCtx(() => kiosk.getKioskSessionState({ ...ctx(s), sessionToken: "x".repeat(43), now: at(3) })));
        expect(db.rows("candidateTestIntegrityEvent").map((e) => [e.type, e.detail.reason])).toEqual([
            ["DEVICE_CHANGE", "WORKSTATION_MISMATCH"],
            ["DEVICE_CHANGE", "TOKEN_MISMATCH"],
        ]);
    });

    it("FORWARD_ONLY refuses going back", async () => {
        seedOnsite(db, { blueprint: { navigation: "FORWARD_ONLY" } });
        const s = await sitting();
        await item(s, 1, at(3));
        await answer(s, 1, { optionId: "a" }, at(3, 20));
        await item(s, 2, at(4));
        await expectNotFound(item(s, 1, at(5)));
        await expectNotFound(answer(s, 1, { optionId: "b" }, at(5)));
        await expect(item(s, 2, at(5))).resolves.toMatchObject({ n: 2 });
    });

    it("accepts kiosk integrity events of the kiosk types only", async () => {
        const s = await sitting();
        const post = (body) => kioskCtx(() => kiosk.recordKioskIntegrityEvents({ ...ctx(s), body, now: at(3) }));
        await expect(post({ events: [{ type: "FOCUS_LOST", detail: { ms: 900, nested: { x: 1 } } }, { type: "FULLSCREEN_EXIT" }] })).resolves.toEqual({ recorded: 2 });
        await expect(post({ type: "RAPID_ANSWER" })).rejects.toMatchObject({ status: 400 });
        expect(db.rows("candidateTestIntegrityEvent")[0]).toMatchObject({ source: "KIOSK", detail: { ms: 900 } });
    });
});

describe("kiosk: the server clock", () => {
    it("pauses and resumes without counting the paused time", async () => {
        const s = await sitting();
        await item(s, 1, at(3)); // clock starts; deadline at(33)
        await as("reception", (access) => reception.pauseTestSession({ tenantId: TENANT, access, actorId: 50, sessionId: s.sessionId, siteRef: "Lahore", reason: "Fire drill", now: at(8) }));
        expect(db.rows("candidateTestIntegrityEvent").at(-1)).toMatchObject({ type: "PROCTOR_PAUSE", source: "PROCTOR" });
        await expectNotFound(item(s, 2, at(9)));
        const paused = await kioskCtx(() => kiosk.getKioskSessionState({ ...ctx(s), now: at(15) }));
        expect(paused).toMatchObject({ status: "PAUSED", remainingSec: 25 * 60 });
        await as("reception", (access) => reception.resumeTestSession({ tenantId: TENANT, access, sessionId: s.sessionId, siteRef: "Lahore", now: at(18) }));
        expect(sessionOf(db, s.sessionId).pausedTotalSec).toBe(600);
        const running = await kioskCtx(() => kiosk.getKioskSessionState({ ...ctx(s), now: at(20) }));
        expect(running.remainingSec).toBe(23 * 60);
        // The original deadline at(33) has passed but the pause pushed it to at(43).
        expect(await kiosk.runTestSessionJob({ now: at(40) })).toMatchObject({ autoSubmitted: 0 });
        expect(await kiosk.runTestSessionJob({ now: at(44) })).toMatchObject({ autoSubmitted: 1 });
        expect(sessionOf(db, s.sessionId)).toMatchObject({ status: "SUBMITTED", submitReason: "TIMEOUT" });
    });

    it("refuses a late answer and submits the sitting", async () => {
        const s = await sitting();
        await item(s, 1, at(3));
        await expectNotFound(answer(s, 1, { optionId: "a" }, at(34)));
        expect(sessionOf(db, s.sessionId)).toMatchObject({ status: "SUBMITTED", submitReason: "TIMEOUT" });
        expect(db.rows("candidateTestResponse")).toHaveLength(0);
        expect(db.rows("candidateTestResult")).toHaveLength(1);
    });

    it("lets a recruiter extend within the cap, and never reception", async () => {
        const s = await sitting();
        await item(s, 1, at(3));
        const extend = (role, minutes) => as(role, (access) => reception.extendTestSession({ tenantId: TENANT, access, actorId: 1, sessionId: s.sessionId, minutes, reason: "Power cut", now: at(10) }));
        await expect(extend("reception", 5)).rejects.toMatchObject({ status: 403 });
        await expect(extend("recruiter", 16)).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-EXTRA-TIME-CAP" });
        await expect(extend("recruiter", 15)).resolves.toMatchObject({ deadlineAt: at(48) });
    });
});

describe("scoring, bands and the kiosk's completion", () => {
    it("scores on submit, records PASSED, and keeps the score out of events and the kiosk", async () => {
        const s = await sitting();
        await answerAll(s, () => true);
        const done = await submit(s, at(12));
        expect(done).toEqual({ status: "SUBMITTED", message: kiosk.COMPLETION_MESSAGE });
        const result = db.rows("candidateTestResult")[0];
        expect(result).toMatchObject({ band: "PASSED", scorePct: 100, rawScore: 6, maxScore: 6, mustPassFailed: false, interviewId: 40, jobFamily: "ENG" });
        expect(result.sectionScores.map((x) => [x.key, x.scorePct, x.passed])).toEqual([["domain", 100, true], ["safety", 100, true]]);
        expect(result.validUntil.getTime() - at(12).getTime()).toBe(90 * 24 * 60 * MIN);
        expect(result.timeTakenSec).toBe(9 * 60);
        expect(interviewOf(db).assessmentStatus).toBe("PASSED");
        expect(recorder.named("test_session_submitted")).toHaveLength(1);
        const recorded = recorder.named("test_result_recorded");
        expect(recorded).toHaveLength(1);
        expect(recorded[0].payload).toMatchObject({ band: "PASSED", interviewId: "40", recruiterId: "7" });
        expect(json(recorder.events)).not.toMatch(/scorePct|rawScore/);
        // Submitting again is idempotent.
        await expect(submit(s, at(13))).resolves.toMatchObject({ status: "SUBMITTED" });
        expect(db.rows("candidateTestResult")).toHaveLength(1);
    });

    it("shows the score on the kiosk only when the tenant opts in", async () => {
        seedOnsite(db, { settings: { kioskShowScore: true } });
        const s = await sitting();
        await answerAll(s, (n) => n !== 1);
        await expect(submit(s, at(12))).resolves.toMatchObject({ scorePct: 83.33 });
    });

    it("fails on a failed must-pass section whatever the total", async () => {
        const s = await sitting();
        const order = sessionOf(db, s.sessionId).itemOrder;
        await answerAll(s, (n) => order[n - 1].sectionKey !== "safety");
        await submit(s, at(12));
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ band: "FAILED", mustPassFailed: true });
        expect(interviewOf(db).assessmentStatus).toBe("FAILED");
    });

    it("puts integrity flags above the threshold into REVIEW and emits test_integrity_flagged", async () => {
        const s = await sitting();
        await kioskCtx(() => kiosk.recordKioskIntegrityEvents({ ...ctx(s), body: { events: [{ type: "FOCUS_LOST" }, { type: "FOCUS_LOST" }, { type: "NETWORK_LOSS" }] }, now: at(2) }));
        await answerAll(s, () => true);
        await submit(s, at(12));
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ band: "REVIEW", integrityFlagCount: 3 });
        expect(recorder.named("test_integrity_flagged")).toHaveLength(1);
    });

    it("auto-releases below the hard floor with no flag, in the scoring transaction", async () => {
        seedOnsite(db, { blueprint: { autoReleaseBelowFloor: true, hardFloorPct: 30 } });
        const s = await sitting();
        await answerAll(s, () => false);
        await submit(s, at(12));
        const result = db.rows("candidateTestResult")[0];
        expect(result).toMatchObject({ band: "FAILED", decision: "RELEASE", decidedById: null, decisionReason: "AUTO_BELOW_FLOOR" });
        expect(interviewOf(db)).toMatchObject({ assessmentStatus: "RELEASED", status: "CANCELLED" });
        expect(cancelInterview).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 40, reasonCode: "ASSESSMENT_NOT_PASSED", actorId: null }));
        expect(transitionApplicationStage).toHaveBeenCalledWith(expect.objectContaining({ id: 9, targetStage: "rejected", reason: "ASSESSMENT_BELOW_THRESHOLD", source: "system.assessment" }));
        const cancelTx = cancelInterview.mock.calls[0][0].db.txId;
        expect(transitionApplicationStage.mock.calls[0][0].db.txId).toBe(cancelTx);
        expect(db.state.ops.filter((o) => o.model === "candidateTestResult" && o.op === "create")[0].tx).toBe(cancelTx);
        expect(recorder.named("test_result_decided")[0].payload).toMatchObject({ decision: "RELEASE", automatic: true });
    });

    it("does not auto-release when the sitting raised an integrity flag", async () => {
        seedOnsite(db, { blueprint: { autoReleaseBelowFloor: true, hardFloorPct: 30 } });
        const s = await sitting();
        await kioskCtx(() => kiosk.recordKioskIntegrityEvents({ ...ctx(s), body: { type: "FOCUS_LOST" }, now: at(2) }));
        await answerAll(s, () => false);
        await submit(s, at(12));
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ band: "FAILED", decision: null });
        expect(cancelInterview).not.toHaveBeenCalled();
    });

    it("applies negative marking when the blueprint enables it", async () => {
        seedOnsite(db, { blueprint: { negativeMarking: true, negativeMarkFraction: 0.5 } });
        const s = await sitting();
        await answerAll(s, (n) => n <= 4);
        await submit(s, at(12));
        // 4 right, 2 wrong at -0.5: 3 of 6.
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ rawScore: 3, scorePct: 50 });
    });
});

async function failedResult(correct = () => false) {
    const s = await sitting();
    await answerAll(s, correct);
    await submit(s, at(12));
    return { s, result: db.rows("candidateTestResult")[0] };
}

const decide = (role, resultId, decision, reason) => as(role, (access) => results.decideTestResult({ tenantId: TENANT, access, actorId: ROLES[role].employeeId, resultId, decision, reason, now: at(20) }));

describe("recruiter decisions", () => {
    it("RELEASE cancels the interview, rejects the application with the coded reason and seeds the codes, in one transaction", async () => {
        const { result } = await failedResult();
        await expect(decide("recruiter", result.id, "RELEASE")).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-TEST-REASON-REQUIRED" });
        const out = await decide("recruiter", result.id, "RELEASE", "Below the pass mark");
        expect(out).toMatchObject({ decision: "RELEASE", assessmentStatus: "RELEASED", dispositionCode: "ASSESSMENT_BELOW_THRESHOLD" });
        expect(cancelInterview).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 40, reasonCode: "ASSESSMENT_NOT_PASSED", notes: "Below the pass mark", actorId: 1 }));
        expect(transitionApplicationStage).toHaveBeenCalledWith(expect.objectContaining({ id: 9, targetStage: "rejected", reason: "ASSESSMENT_BELOW_THRESHOLD", actorId: 1 }));
        expect(cancelInterview.mock.calls[0][0].db.txId).toBe(transitionApplicationStage.mock.calls[0][0].db.txId);
        expect(db.rows("application").find((a) => a.id === 9).stage).toBe("rejected");
        const codes = db.rows("dispositionReasonCode").map((c) => c.code);
        expect(codes).toContain("ASSESSMENT_BELOW_THRESHOLD");
        expect(codes).toContain("MINIMUM_REQUIREMENTS_NOT_MET"); // the default taxonomy came first
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ decision: "RELEASE", decidedById: 1, decisionReason: "Below the pass mark" });
        expect(recorder.named("test_result_decided").at(-1).payload).toMatchObject({ decision: "RELEASE", automatic: false, dispositionCode: "ASSESSMENT_BELOW_THRESHOLD" });
        await expect(decide("recruiter", result.id, "RETEST", "again")).rejects.toMatchObject({ status: 409 });
    });

    it("rolls the whole release back when the rejection fails", async () => {
        const { result } = await failedResult();
        transitionApplicationStage.mockImplementationOnce(async () => {
            throw Object.assign(new Error("Invalid application transition"), { status: 409, code: "HR-RECRUITMENT-TRANSITION-INVALID" });
        });
        await expect(decide("recruiter", result.id, "RELEASE", "Below")).rejects.toMatchObject({ status: 409 });
        expect(db.rows("candidateTestResult")[0].decision).toBeNull();
        expect(interviewOf(db)).toMatchObject({ assessmentStatus: "FAILED", status: "SCHEDULED" });
        expect(db.rows("dispositionReasonCode")).toHaveLength(0);
    });

    it("releases a REVIEW result with ASSESSMENT_INTEGRITY", async () => {
        const s = await sitting();
        await kioskCtx(() => kiosk.recordKioskIntegrityEvents({ ...ctx(s), body: { events: [{ type: "FOCUS_LOST" }, { type: "FOCUS_LOST" }, { type: "FOCUS_LOST" }] }, now: at(2) }));
        await answerAll(s, () => true);
        await submit(s, at(12));
        const out = await decide("recruiter", db.rows("candidateTestResult")[0].id, "RELEASE", "Integrity");
        expect(out.dispositionCode).toBe("ASSESSMENT_INTEGRITY");
    });

    it("PROCEED on a failed band is an OVERRIDE with a reason", async () => {
        const { result } = await failedResult();
        await expect(decide("recruiter", result.id, "PROCEED")).rejects.toMatchObject({ status: 400 });
        await expect(decide("recruiter", result.id, "PROCEED", "Strong portfolio")).resolves.toMatchObject({ decision: "OVERRIDE", assessmentStatus: "OVERRIDDEN" });
        expect(interviewOf(db).assessmentStatus).toBe("OVERRIDDEN");
        expect(cancelInterview).not.toHaveBeenCalled();
    });

    it("PROCEED on PASSED needs no reason and keeps the band", async () => {
        const { result } = await failedResult(() => true);
        await expect(decide("recruiter", result.id, "PROCEED")).resolves.toMatchObject({ decision: "PROCEED", assessmentStatus: "PASSED" });
        await expect(decide("recruiter", result.id, "RELEASE", "x")).rejects.toMatchObject({ status: 409 });
    });

    it("RETEST returns to CHECKED_IN and allows a new session, keeping the earlier one", async () => {
        const { s, result } = await failedResult();
        for (const difficulty of ["EASY", "MEDIUM", "MEDIUM", "HARD"]) addItem(db, { difficulty, competencyKey: "DOMAIN" });
        for (const difficulty of ["EASY", "MEDIUM"]) addItem(db, { difficulty, competencyKey: "SAFETY" });
        await expect(decide("recruiter", result.id, "RETEST", "Kiosk froze")).resolves.toMatchObject({ assessmentStatus: "CHECKED_IN" });
        const again = await issue({ workstationId: 81 });
        expect(sessionOf(db, again.sessionId)).toMatchObject({ attemptNo: 2, previousSessionId: s.sessionId });
        expect(sessionOf(db, s.sessionId).status).toBe("SUBMITTED");
    });

    it("is for recruiters only", async () => {
        const { result } = await failedResult();
        await expect(decide("reception", result.id, "PROCEED", "x")).rejects.toMatchObject({ status: 403 });
        await expect(decide("manager", result.id, "PROCEED", "x")).rejects.toMatchObject({ status: 403 });
    });

    it("WAIVE needs a reason, works before the test or on a failed band, never over a live session", async () => {
        const waive = (reason = "Internal transfer") => as("recruiter", (access) => results.waiveAssessment({ tenantId: TENANT, access, actorId: 1, interviewId: 40, reason, now: at(1) }));
        await expect(waive("")).rejects.toMatchObject({ status: 400 });
        await checkIn();
        await issue();
        await expect(waive()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-SESSION-LIVE" });
        seedOnsite(db);
        await expect(waive()).resolves.toMatchObject({ assessmentStatus: "WAIVED", resultId: null });
        expect(interviewOf(db)).toMatchObject({ assessmentWaivedReason: "Internal transfer", assessmentWaivedById: 1 });
        seedOnsite(db);
        const { result } = await failedResult();
        await expect(waive("Accessibility")).resolves.toMatchObject({ assessmentStatus: "WAIVED", resultId: result.id });
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ decision: "WAIVE", decisionReason: "Accessibility" });
    });
});

describe("the test report and its scope", () => {
    beforeEach(() => {
        db.rows("interviewQuestion").push(
            { id: 600, tenantId: TENANT, questionKey: "Q-SAFE", version: 1, status: "PUBLISHED", competencyKey: "SAFETY", prompt: "Old prompt" },
            { id: 601, tenantId: TENANT, questionKey: "Q-SAFE", version: 2, status: "PUBLISHED", competencyKey: "SAFETY", prompt: "Walk me through a lockout", followUps: ["Who signs off?"], goodAnswerGuide: "Names the steps" },
            { id: 602, tenantId: TENANT, questionKey: "Q-DRAFT", version: 1, status: "DRAFT", competencyKey: "SAFETY", prompt: "Draft" },
        );
    });

    async function scoredWithWeakSafety() {
        const s = await sitting();
        const order = sessionOf(db, s.sessionId).itemOrder;
        const prompt = db.rows("candidateTestItem").find((i) => i.id === order[0].itemId);
        prompt.discussionPrompt = true;
        await answerAll(s, (n) => order[n - 1].sectionKey !== "safety");
        await submit(s, at(12));
        return { s, result: db.rows("candidateTestResult")[0], prompt };
    }

    const report = (role, args) => as(role, (access) => results.getTestResultReport({ tenantId: TENANT, scope: access.scope, ...args }));

    it("gives the recruiter the report: sections, chart, probes, discussion stems, integrity; never the key or the pool", async () => {
        const { result, prompt } = await scoredWithWeakSafety();
        const out = await report("recruiter", { resultId: result.id });
        expect(out.result).toMatchObject({ band: "FAILED", scorePct: 66.67, blueprint: { passMarkPct: 60 } });
        expect(out.result.sectionScores.find((x) => x.key === "safety")).toMatchObject({ passed: false, mustPass: true, passMarkPct: 50 });
        expect(out.result.competencyChart).toHaveLength(2);
        expect(out.result.probes).toEqual([{ competencyKey: "SAFETY", questions: [expect.objectContaining({ questionKey: "Q-SAFE", prompt: "Walk me through a lockout" })] }]);
        expect(out.result.discussionPrompts).toEqual([{ n: 1, competencyKey: prompt.competencyKey, stem: prompt.stem }]);
        const body = json(out);
        for (const secret of ["answerKey", "rationale", "optionIds", "Alpha", "feedback", "itemOrder"]) expect(body).not.toContain(secret);
    });

    it("shows the report to the interview's panelist and the requisition's manager, not to others or reception", async () => {
        const { result } = await scoredWithWeakSafety();
        await expect(report("panelist", { resultId: result.id })).resolves.toMatchObject({ interviewId: 40 });
        await expect(report("manager", { interviewId: 40 })).resolves.toMatchObject({ interviewId: 40 });
        await expect(report("outsider", { resultId: result.id })).rejects.toMatchObject({ status: 404 });
        await expect(report("reception", { resultId: result.id })).rejects.toMatchObject({ status: 404 });
        const list = (role) => as(role, (access) => results.listTestResults({ tenantId: TENANT, scope: access.scope, requisitionId: 21 }));
        await expect(list("panelist")).resolves.toMatchObject({ total: 1 });
        await expect(list("outsider")).resolves.toMatchObject({ total: 0 });
        await expect(list("reception")).resolves.toMatchObject({ total: 0 });
    });

    it("reports a waiver when there is no result", async () => {
        await as("recruiter", (access) => results.waiveAssessment({ tenantId: TENANT, access, actorId: 1, interviewId: 40, reason: "Senior role" }));
        await expect(report("panelist", { interviewId: 40 })).resolves.toMatchObject({ assessmentStatus: "WAIVED", waiver: { reason: "Senior role" }, result: null });
    });

    it("computes analytics for recruiters only", async () => {
        const { result } = await scoredWithWeakSafety();
        await decide("recruiter", result.id, "PROCEED", "Panel insists");
        const out = await as("recruiter", (access) => results.getTestAnalytics({ tenantId: TENANT, access }));
        expect(out.overall).toMatchObject({ sittings: 1, completed: 1, passed: 0, overrides: 1, overrideRatePct: 100, averageScorePct: 66.7 });
        expect(out.bySource[0]).toMatchObject({ key: "REFERRAL" });
        expect(out.bySite[0]).toMatchObject({ key: "Lahore" });
        await expect(as("manager", (access) => results.getTestAnalytics({ tenantId: TENANT, access }))).rejects.toMatchObject({ status: 403 });
    });
});

describe("proctoring: live grid and void", () => {
    it("shows progress, time and flags with no score, and COMPLETED after submit", async () => {
        const s = await sitting();
        await item(s, 1, at(3));
        await answer(s, 1, { optionId: "a" }, at(3, 1)); // rapid
        const live = await as("reception", (access) => reception.listLiveSessions({ tenantId: TENANT, access, siteRef: "lahore", now: at(5) }));
        expect(live.items[0]).toMatchObject({
            sessionId: s.sessionId, candidateName: "Ayesha Khan", workstation: { id: 80, label: "Kiosk 1" }, status: "IN_PROGRESS",
            progress: { answered: 1, total: 6 }, remainingSec: 28 * 60, integrityFlagCount: 1,
        });
        await submit(s, at(6));
        const after = await as("reception", (access) => reception.listLiveSessions({ tenantId: TENANT, access, siteRef: "Lahore", now: at(7) }));
        expect(after.items[0]).toMatchObject({ status: "COMPLETED", note: reception.COMPLETED_NOTE });
        const arrivals = await as("reception", (access) => reception.listArrivals({ tenantId: TENANT, access, siteRef: "Lahore", now: at(7) }));
        expect(arrivals.items[0]).toMatchObject({ assessmentStatus: "COMPLETED", session: { status: "COMPLETED" } });
        expect(json([live, after, arrivals])).not.toMatch(/scorePct|band|FAILED|PASSED/);
    });

    it("voids with a reason: VOIDED, the token dead, the result INCOMPLETE", async () => {
        const s = await sitting();
        const voidIt = (reason) => as("reception", (access) => reception.voidTestSession({ tenantId: TENANT, access, actorId: 50, sessionId: s.sessionId, reason, siteRef: "Lahore", now: at(4) }));
        await expect(voidIt("")).rejects.toMatchObject({ status: 400 });
        await expect(voidIt("Kiosk crashed")).resolves.toMatchObject({ status: "VOIDED" });
        expect(sessionOf(db, s.sessionId)).toMatchObject({ status: "VOIDED", voidReason: "Kiosk crashed", sessionTokenHash: null });
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ band: "INCOMPLETE", sessionId: s.sessionId });
        expect(interviewOf(db).assessmentStatus).toBe("INCOMPLETE");
        expect(db.rows("candidateTestIntegrityEvent").at(-1)).toMatchObject({ type: "PROCTOR_VOID" });
        await expectNotFound(item(s, 1, at(5)));
        expect(logAction).toHaveBeenCalled();
    });

    it("keeps a receptionist to their site", async () => {
        const s = await sitting();
        await expect(as("reception", (access) => reception.pauseTestSession({ tenantId: TENANT, access, sessionId: s.sessionId, siteRef: "Karachi", now: at(4) }))).rejects.toMatchObject({ status: 404 });
    });
});

describe("the minute job", () => {
    it("expires an unused code and records INCOMPLETE", async () => {
        await checkIn();
        const issued = await issue();
        expect(await kiosk.runTestSessionJob({ now: at(14) })).toMatchObject({ expired: 0 });
        expect(await kiosk.runTestSessionJob({ now: at(16) })).toMatchObject({ expired: 1, failed: 0 });
        expect(sessionOf(db, issued.sessionId)).toMatchObject({ status: "EXPIRED", sessionCodeHash: null });
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ band: "INCOMPLETE" });
        expect(interviewOf(db).assessmentStatus).toBe("INCOMPLETE");
        expect(db.state.ops.filter((o) => o.op === "findMany" && o.model === "candidateTestSession" && o.tenant === "SYSTEM").length).toBeGreaterThan(0);
    });

    it("does not record INCOMPLETE while another session for the interview is live", async () => {
        await checkIn();
        const issued = await issue();
        db.rows("candidateTestSession").push({ ...sessionOf(db, issued.sessionId), id: 4999, status: "IN_PROGRESS", sessionCodeHash: null, codeExpiresAt: null, startedAt: at(0), deadlineAt: at(30) });
        await kiosk.runTestSessionJob({ now: at(16) });
        expect(sessionOf(db, issued.sessionId).status).toBe("EXPIRED");
        expect(db.rows("candidateTestResult")).toHaveLength(0);
    });

    it("auto-submits and scores a sitting past its deadline", async () => {
        const s = await sitting();
        await item(s, 1, at(3));
        await answer(s, 1, { optionId: "a" }, at(3, 30));
        expect(await kiosk.runTestSessionJob({ now: at(34) })).toMatchObject({ autoSubmitted: 1 });
        expect(db.rows("candidateTestResult")[0]).toMatchObject({ band: "FAILED", rawScore: 1 });
        expect(await kiosk.runTestSessionJob({ now: at(35) })).toMatchObject({ autoSubmitted: 0 });
    });

    it("closes a sitting abandoned before the clock started", async () => {
        const s = await sitting();
        await kiosk.runTestSessionJob({ now: at(62) });
        expect(sessionOf(db, s.sessionId)).toMatchObject({ status: "EXPIRED", sessionTokenHash: null });
        expect(db.rows("candidateTestResult")[0].band).toBe("INCOMPLETE");
    });

    it("does nothing with the flag off, and the tools answer 503", async () => {
        process.env.HR_RECRUITMENT_ONSITE_TEST = "false";
        await expect(kiosk.runTestSessionJob({ now: at(16) })).resolves.toEqual({ skipped: "FLAG_OFF" });
        expect(() => kiosk.assertOnsiteTestEnabled()).toThrow(expect.objectContaining({ status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" }));
    });
});
