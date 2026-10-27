// Recruitment Phase 7 (A16) — the two-resume limit counts only resume codes
// that were used or are still live. Boundaries pinned: an issued code that
// expired unused gives its slot back; a used code counts for good (the
// exchange stamps usedAt on its resume event); a live unused code counts while
// it is live; a Phase 6 event without use tracking still counts; the live grid's
// resumeCount follows the same rule.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { makeOnsiteDb, eventRecorder } from "./helpers/onsite-test.fake.js";
import { TENANT, ROLES, seedOnsite } from "./helpers/onsite-test.seed.js";

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

async function sitting() {
    await as("reception", (access) => reception.checkInCandidate({
        tenantId: TENANT, access, actorId: 50, interviewId: 40, idType: "CNIC", idLast4: "1234", consent: true, siteRef: "Lahore", now: T0,
    }));
    const issued = await as("reception", (access) => reception.issueTestSession({
        tenantId: TENANT, access, actorId: 50, interviewId: 40, workstationId: 80, siteRef: "Lahore", now: T0,
    }));
    const started = await kioskCtx(() => kiosk.startKioskSession({ tenantId: TENANT, workstation: WS, code: issued.code, consent: true, now: at(1), rng: seededRng(7) }));
    // The clock starts with the first item: the deadline is at(32).
    await kioskCtx(() => kiosk.getKioskItem({ tenantId: TENANT, workstation: WS, sessionId: started.sessionId, sessionToken: started.sessionToken, n: 1, now: at(2) }));
    return started.sessionId;
}

const resumeCode = (sessionId, now, workstationId = 81) => as("reception", (access) => reception.issueKioskResumeCode({
    tenantId: TENANT, access, actorId: 50, sessionId, workstationId, siteRef: "Lahore", reason: "Kiosk froze", now,
}));
const exchange = (code, now, workstation = WS2) => kioskCtx(() => kiosk.resumeKioskSession({ tenantId: TENANT, workstation, code, now }));
const grid = (now) => as("reception", (access) => reception.listLiveSessions({ tenantId: TENANT, access, siteRef: "Lahore", now }));
const resumeEvents = (sessionId) => db.rows("candidateTestIntegrityEvent").filter((e) => e.sessionId === sessionId && e.type === "KIOSK_RESUME" && e.source === "PROCTOR");
const LIMIT = { status: 409, code: "HR-RECRUITMENT-KIOSK-RESUME-LIMIT" };

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

describe("the resume limit counts used or live codes only", () => {
    it("an issued code that expired unused does not count", async () => {
        const id = await sitting();
        const lapsed = await resumeCode(id, at(3)); // live until at(18), never used
        expect(lapsed).toMatchObject({ resumeNo: 1, resumesLeft: 1 });
        expect((await grid(at(18))).items[0].resumeCount).toBe(0);

        const first = await resumeCode(id, at(19));
        expect(first).toMatchObject({ resumeNo: 1, resumesLeft: 1 });
        await exchange(first.code, at(19, 30));
        const second = await resumeCode(id, at(20), 80);
        expect(second).toMatchObject({ resumeNo: 2, resumesLeft: 0 });
        await exchange(second.code, at(21), WS);
        // Two used: the third is refused; the lapsed one stays on the timeline.
        await expect(resumeCode(id, at(22))).rejects.toMatchObject(LIMIT);
        expect(resumeEvents(id)).toHaveLength(3);
        expect((await grid(at(22))).items[0].resumeCount).toBe(2);
    });

    it("a used code counts for good, stamped on its resume event", async () => {
        const id = await sitting();
        const first = await resumeCode(id, at(3));
        await exchange(first.code, at(4));
        const [event] = resumeEvents(id);
        expect(event.detail).toMatchObject({ resumeNo: 1, usageTracked: true, usedAt: at(4).toISOString(), usedOnWorkstationId: 81 });
        // Long after the code's own expiry it still counts.
        expect((await grid(at(25))).items[0].resumeCount).toBe(1);
        expect(await resumeCode(id, at(25), 80)).toMatchObject({ resumeNo: 2, resumesLeft: 0 });
    });

    it("a live unused code counts while it is live, and frees its slot when it lapses", async () => {
        const id = await sitting();
        await exchange((await resumeCode(id, at(3))).code, at(4)); // used: 1
        const waiting = await resumeCode(id, at(5), 80); // live until at(20)
        expect(waiting).toMatchObject({ resumeNo: 2, resumesLeft: 0 });
        expect((await grid(at(6))).items[0].resumeCount).toBe(2);
        // While it is live, no further code: 1 used + 1 live.
        await expect(resumeCode(id, at(19, 59))).rejects.toMatchObject(LIMIT);
        // Lapsed unused: the slot is back.
        expect((await grid(at(20))).items[0].resumeCount).toBe(1);
        const again = await resumeCode(id, at(20));
        expect(again).toMatchObject({ resumeNo: 2, resumesLeft: 0 });
        // The lapsed code cannot be used either.
        await expect(exchange(waiting.code, at(20, 30), WS)).rejects.toMatchObject({ status: 404 });
    });

    it("a Phase 6 resume event without use tracking still counts as used", async () => {
        const id = await sitting();
        db.rows("candidateTestIntegrityEvent").push(
            { id: 9001, tenantId: TENANT, sessionId: id, type: "KIOSK_RESUME", source: "PROCTOR", occurredAt: at(2, 30), detail: { reason: "KIOSK_RESUME", resumeNo: 1 } },
        );
        expect(await resumeCode(id, at(3))).toMatchObject({ resumeNo: 2, resumesLeft: 0 });
    });
});

describe("countedKioskResumes", () => {
    const NOW = at(10);
    const tracked = (id, extra = {}) => ({ id, detail: { usageTracked: true, ...extra } });
    it.each([
        ["no resumes", [], {}, 0],
        ["expired unused", [tracked(1)], { sessionCodeHash: "h", codeExpiresAt: at(9) }, 0],
        ["expiring exactly now", [tracked(1)], { sessionCodeHash: "h", codeExpiresAt: NOW }, 0],
        ["live unused", [tracked(1)], { sessionCodeHash: "h", codeExpiresAt: at(11) }, 1],
        ["used", [tracked(1, { usedAt: at(5).toISOString() })], { sessionCodeHash: null, codeExpiresAt: at(9) }, 1],
        ["superseded unused, then live", [tracked(1), tracked(2)], { sessionCodeHash: "h", codeExpiresAt: at(11) }, 1],
        ["legacy (untracked)", [{ id: 1, detail: { resumeNo: 1 } }, { id: 2, detail: null }], {}, 2],
    ])("%s", (_label, events, session, expected) => {
        expect(kiosk.countedKioskResumes(events, session, NOW)).toBe(expected);
    });
});
