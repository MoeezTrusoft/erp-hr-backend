// Recruitment Phase 3b — test blueprints: create and versioning, dual
// approval, the pool depth rule at publish, link migration, resolution,
// the keyless preview, visibility and the flag.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { createBlueprintDb, createEventRecorder } from "./helpers/test-blueprint.fake.js";

const { db, state, reset } = createBlueprintDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const svc = await import("../../../src/services/test-blueprint.service.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const users = {
    recruiter: { roles: ["RECRUITER"], employeeId: 7 },
    hrAdmin: { roles: ["HR_ADMIN"], employeeId: 8 },
    manager: { roles: ["HIRING_MANAGER"], employeeId: 42 },
    otherManager: { roles: ["HIRING_MANAGER"], employeeId: 43 },
    author: { roles: ["ASSESSMENT_AUTHOR"], employeeId: 50 },
    reviewer: { roles: ["ASSESSMENT_REVIEWER"], employeeId: 51 },
    interviewer: { roles: ["INTERVIEWER"], employeeId: 60 },
    reception: { roles: ["RECEPTION"], employeeId: 61 },
};
const as = (who) => {
    const access = resolveAssessmentAccess({ ...users[who], tenantId: TENANT });
    return { tenantId: TENANT, access, actorId: access.employeeId };
};
const inTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const refusal = async (promise) => {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error("expected a refusal");
};

const sections = [
    { key: "dom", competencyKey: "domain", itemCount: 4, difficultyMix: { EASY: 50, MEDIUM: 50, HARD: 0 } },
    { key: "num", competencyKey: "numeracy", itemCount: 2, difficultyMix: { EASY: 0, MEDIUM: 100, HARD: 0 }, mustPass: true },
];
const blueprintInput = (over = {}) => ({ name: "Finance officer test", jobFamily: "Finance", sections, ...over });

let itemSeq = 0;
function addItems(competencyKey, difficulty, n, over = {}) {
    for (let i = 0; i < n; i += 1) {
        itemSeq += 1;
        state.items.push({
            id: itemSeq, tenantId: TENANT, itemCode: `IT-${itemSeq}`, version: 1, status: "PUBLISHED", type: "SINGLE",
            stem: `Question ${itemSeq}`, mediaId: null,
            options: [{ id: "a", text: "A", feedback: "right because" }, { id: "b", text: "B", feedback: "wrong" }],
            answerKey: JSON.stringify({ optionIds: ["a"] }), rationale: "secret rationale", scoringRule: null,
            difficulty, competencyKey, jobFamily: null, language: "en", exposureCount: 0, ...over,
        });
    }
}
// Exactly three times the draw: domain 2 EASY + 2 MEDIUM, numeracy 2 MEDIUM.
function seedDeepPool() {
    addItems("domain", "EASY", 6);
    addItems("domain", "MEDIUM", 6, { jobFamily: "finance" });
    addItems("numeracy", "MEDIUM", 6);
}

function seed() {
    reset();
    events.length = 0;
    itemSeq = 0;
    state.requisitions.push(
        { id: 21, tenantId: TENANT, title: "Finance officer", requestedById: 42, approvedById: null, gradeLevelId: 4, jobContent: null, position: { jobCode: "FINANCE" } },
        { id: 22, tenantId: TENANT, title: "Sales lead", requestedById: 43, approvedById: null, gradeLevelId: 5, jobContent: null, position: { jobCode: "SALES" } },
        { id: 23, tenantId: TENANT, title: "Accounts clerk", requestedById: 7, approvedById: null, gradeLevelId: 4, jobContent: null, position: { jobCode: "FINANCE" } },
    );
    state.gradeLevels.push({ id: 4, tenantId: TENANT }, { id: 5, tenantId: TENANT });
}

async function approvedBlueprint(over = {}) {
    const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput(over) }));
    await inTenant(() => svc.approveTestBlueprint({ ...as("recruiter"), blueprintId: bp.id, as: "HR" }));
    return inTenant(() => svc.approveTestBlueprint({ ...as("manager"), blueprintId: bp.id, as: "HIRING_MANAGER" }));
}

beforeEach(() => {
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
    seed();
    jest.clearAllMocks();
});
afterAll(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("flag and access", () => {
    it("every entry point refuses with the -DISABLED 503 when the flag is off", async () => {
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        const err = await refusal(inTenant(() => svc.listTestBlueprints(as("recruiter"))));
        expect(err).toMatchObject({ status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" });
        expect((await refusal(inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() })))).status).toBe(503);
    });

    it("interviewers and reception see no blueprints; a manager is no author", async () => {
        expect((await refusal(inTenant(() => svc.listTestBlueprints(as("interviewer"))))).status).toBe(403);
        expect((await refusal(inTenant(() => svc.listTestBlueprints(as("reception"))))).status).toBe(403);
        expect((await refusal(inTenant(() => svc.createTestBlueprint({ ...as("manager"), input: blueprintInput() })))).status).toBe(403);
    });

    it("a manager sees blueprints linked to their requisitions or in their families", async () => {
        const finance = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        const sales = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput({ jobFamily: "Sales" }) }));
        const linked = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput({ jobFamily: null }) }));
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: linked.id, scopeType: "REQUISITION", scopeId: 21 }));
        const mine = await inTenant(() => svc.listTestBlueprints(as("manager")));
        expect(mine.items.map((b) => b.id).sort()).toEqual([finance.id, linked.id].sort());
        expect((await refusal(inTenant(() => svc.getTestBlueprint({ ...as("manager"), blueprintId: sales.id })))).status).toBe(404);
        expect((await inTenant(() => svc.listTestBlueprints(as("reviewer")))).total).toBe(3);
    });
});

describe("create and update", () => {
    it("creates a DRAFT v1 with the normalised sections and a generated key", async () => {
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        expect(bp).toMatchObject({ status: "DRAFT", version: 1, jobFamily: "FINANCE", createdById: 50, tenantId: TENANT });
        expect(bp.blueprintKey).toMatch(/^finance-officer-test-[0-9a-f]{6}$/);
        expect(bp.sections[0].counts).toEqual({ EASY: 2, MEDIUM: 2, HARD: 0 });
        const dup = await refusal(inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput({ blueprintKey: bp.blueprintKey }) })));
        expect(dup).toMatchObject({ status: 409, code: "HR-RECRUITMENT-BLUEPRINT-KEY-TAKEN" });
    });

    it("editing an unpublished version clears both approvals", async () => {
        const approved = await approvedBlueprint();
        expect(approved).toMatchObject({ status: "APPROVED", approvedByHrId: 7, approvedByHiringManagerId: 42 });
        const edited = await inTenant(() => svc.updateTestBlueprint({ ...as("author"), blueprintId: approved.id, input: { passMarkPct: 70 } }));
        expect(edited).toMatchObject({ status: "DRAFT", passMarkPct: 70, approvedByHrId: null, approvedByHiringManagerId: null, createdVersion: false, version: 1 });
    });

    it("a PUBLISHED blueprint is immutable: the edit becomes version 2 under the same key", async () => {
        seedDeepPool();
        const bp = await approvedBlueprint();
        await inTenant(() => svc.publishTestBlueprint({ ...as("reviewer"), blueprintId: bp.id }));
        const next = await inTenant(() => svc.updateTestBlueprint({ ...as("author"), blueprintId: bp.id, input: { durationMin: 45 } }));
        expect(next).toMatchObject({ status: "DRAFT", version: 2, blueprintKey: bp.blueprintKey, durationMin: 45, createdVersion: true, previousBlueprintId: bp.id });
        expect(state.blueprints.find((b) => b.id === bp.id)).toMatchObject({ status: "PUBLISHED", durationMin: 30 });
        const again = await refusal(inTenant(() => svc.updateTestBlueprint({ ...as("author"), blueprintId: bp.id, input: { durationMin: 50 } })));
        expect(again).toMatchObject({ status: 409, code: "HR-RECRUITMENT-BLUEPRINT-DRAFT-EXISTS" });
        expect(again.details.draftBlueprintId).toBe(next.id);
    });
});

describe("dual approval", () => {
    it("HR then the hiring manager: IN_APPROVAL, then APPROVED", async () => {
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        const one = await inTenant(() => svc.approveTestBlueprint({ ...as("hrAdmin"), blueprintId: bp.id, as: "HR" }));
        expect(one).toMatchObject({ status: "IN_APPROVAL", approvedByHrId: 8, approvals: { hr: { employeeId: 8 }, hiringManager: null } });
        const two = await inTenant(() => svc.approveTestBlueprint({ ...as("manager"), blueprintId: bp.id, as: "HIRING_MANAGER" }));
        expect(two).toMatchObject({ status: "APPROVED", approvedByHiringManagerId: 42 });
    });

    it("the same person cannot give both approvals", async () => {
        // Employee 7 is a recruiter AND the hiring manager of requisition 23.
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        await inTenant(() => svc.approveTestBlueprint({ ...as("recruiter"), blueprintId: bp.id, as: "HR" }));
        const err = await refusal(inTenant(() => svc.approveTestBlueprint({ ...as("recruiter"), blueprintId: bp.id, as: "HIRING_MANAGER" })));
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-BLUEPRINT-SAME-APPROVER" });
        const repeat = await inTenant(() => svc.approveTestBlueprint({ ...as("recruiter"), blueprintId: bp.id, as: "HR" }));
        expect(repeat.status).toBe("IN_APPROVAL");
        const second = await refusal(inTenant(() => svc.approveTestBlueprint({ ...as("hrAdmin"), blueprintId: bp.id, as: "HR" })));
        expect(second.code).toBe("HR-RECRUITMENT-BLUEPRINT-ALREADY-APPROVED");
    });

    it("hiring manager means the requester of a linked requisition or one in the blueprint's family", async () => {
        const sales = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput({ jobFamily: "Sales" }) }));
        expect((await refusal(inTenant(() => svc.approveTestBlueprint({ ...as("manager"), blueprintId: sales.id, as: "HIRING_MANAGER" })))).status).toBe(403);
        expect((await inTenant(() => svc.approveTestBlueprint({ ...as("otherManager"), blueprintId: sales.id, as: "HIRING_MANAGER" }))).approvedByHiringManagerId).toBe(43);

        const generic = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput({ jobFamily: null }) }));
        expect((await refusal(inTenant(() => svc.approveTestBlueprint({ ...as("manager"), blueprintId: generic.id, as: "HIRING_MANAGER" })))).status).toBe(403);
        await inTenant(() => svc.linkTestBlueprint({ ...as("manager"), blueprintId: generic.id, scopeType: "REQUISITION", scopeId: 21 }));
        expect((await inTenant(() => svc.approveTestBlueprint({ ...as("manager"), blueprintId: generic.id, as: "HIRING_MANAGER" }))).status).toBe("IN_APPROVAL");
    });

    it("only recruiters and HR admins approve for HR", async () => {
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        for (const who of ["manager", "author", "reviewer"]) {
            expect((await refusal(inTenant(() => svc.approveTestBlueprint({ ...as(who), blueprintId: bp.id, as: "HR" })))).status).toBe(403);
        }
    });
});

describe("publish", () => {
    it("refuses a blueprint that is not APPROVED", async () => {
        seedDeepPool();
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        const err = await refusal(inTenant(() => svc.publishTestBlueprint({ ...as("reviewer"), blueprintId: bp.id })));
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-BLUEPRINT-NOT-APPROVED" });
        expect((await refusal(inTenant(() => svc.publishTestBlueprint({ ...as("author"), blueprintId: bp.id })))).status).toBe(403);
    });

    it("refuses a shallow pool with the report; other languages, families and statuses do not count", async () => {
        seedDeepPool();
        state.items.pop(); // numeracy MEDIUM now 5 < 6
        addItems("numeracy", "MEDIUM", 1, { language: "ur" });
        addItems("numeracy", "MEDIUM", 1, { jobFamily: "SALES" });
        addItems("numeracy", "MEDIUM", 1, { status: "DRAFT" });
        const bp = await approvedBlueprint();
        const err = await refusal(inTenant(() => svc.publishTestBlueprint({ ...as("reviewer"), blueprintId: bp.id })));
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-BLUEPRINT-POOL-SHALLOW" });
        expect(err.details.report.shortfalls).toEqual([
            { sectionKey: "num", competencyKey: "numeracy", difficulty: "MEDIUM", draw: 2, needed: 6, available: 5, ok: false },
        ]);
        expect(state.blueprints.find((b) => b.id === bp.id).status).toBe("APPROVED");
        expect(events).toHaveLength(0);
    });

    it("a generic blueprint draws only generic items", async () => {
        seedDeepPool(); // domain MEDIUM items are FINANCE-specific
        // A generic blueprint has no family, so the manager approves through
        // a linked requisition.
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput({ jobFamily: null }) }));
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: bp.id, scopeType: "REQUISITION", scopeId: 21 }));
        await inTenant(() => svc.approveTestBlueprint({ ...as("recruiter"), blueprintId: bp.id, as: "HR" }));
        await inTenant(() => svc.approveTestBlueprint({ ...as("manager"), blueprintId: bp.id, as: "HIRING_MANAGER" }));
        const err = await refusal(inTenant(() => svc.publishTestBlueprint({ ...as("reviewer"), blueprintId: bp.id })));
        expect(err.details.report.shortfalls).toEqual([expect.objectContaining({ competencyKey: "domain", difficulty: "MEDIUM", available: 0 })]);
    });

    it("publishes, retires the previous version and moves its links, in one event", async () => {
        seedDeepPool();
        const v1 = await approvedBlueprint();
        await inTenant(() => svc.publishTestBlueprint({ ...as("reviewer"), blueprintId: v1.id }));
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: v1.id, scopeType: "JOB_FAMILY", scopeKey: "finance" }));
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: v1.id, scopeType: "REQUISITION", scopeId: 21 }));
        const v2 = await inTenant(() => svc.updateTestBlueprint({ ...as("author"), blueprintId: v1.id, input: { passMarkPct: 65 } }));
        await inTenant(() => svc.approveTestBlueprint({ ...as("hrAdmin"), blueprintId: v2.id, as: "HR" }));
        await inTenant(() => svc.approveTestBlueprint({ ...as("manager"), blueprintId: v2.id, as: "HIRING_MANAGER" }));
        events.length = 0;
        const out = await inTenant(() => svc.publishTestBlueprint({ ...as("recruiter"), blueprintId: v2.id }));
        expect(out).toMatchObject({ retiredBlueprintIds: [v1.id], movedLinkCount: 2, blueprint: { status: "PUBLISHED", version: 2 } });
        expect(state.blueprints.find((b) => b.id === v1.id).status).toBe("RETIRED");
        expect(state.links.filter((l) => l.isActive).every((l) => l.blueprintId === v2.id)).toBe(true);
        expect(events).toEqual([expect.objectContaining({
            eventName: "hr.recruitment.test_blueprint_published.v1",
            tenantId: TENANT,
            aggregateType: "CandidateTestBlueprint",
            payload: { blueprintId: String(v2.id), blueprintKey: v1.blueprintKey, version: 2, retiredBlueprintIds: [String(v1.id)], movedLinkCount: 2 },
        })]);
        expect((await refusal(inTenant(() => svc.updateTestBlueprint({ ...as("author"), blueprintId: v1.id, input: { name: "x" } })))).code).toBe("HR-RECRUITMENT-BLUEPRINT-RETIRED");
        expect(db.contextLog.every((c) => c.tenantId === TENANT && !c.system)).toBe(true);
    });
});

describe("link and resolve", () => {
    async function published(over = {}) {
        const bp = await approvedBlueprint(over);
        return (await inTenant(() => svc.publishTestBlueprint({ ...as("reviewer"), blueprintId: bp.id }))).blueprint;
    }

    it("resolves most-specific-first and says which scope matched", async () => {
        seedDeepPool();
        const family = await published();
        const grade = await published();
        const req = await published();
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: family.id, scopeType: "JOB_FAMILY", scopeKey: "Finance" }));
        const r1 = await inTenant(() => svc.resolveTestBlueprint({ ...as("recruiter"), requisitionId: 21 }));
        expect(r1).toMatchObject({ requisitionId: 21, jobFamily: "FINANCE", gradeLevelId: 4, matchedScope: "JOB_FAMILY", blueprint: { id: family.id } });
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: grade.id, scopeType: "JOB_FAMILY_GRADE", scopeKey: "FINANCE", scopeId: 4 }));
        expect((await inTenant(() => svc.resolveTestBlueprint({ ...as("recruiter"), requisitionId: 21 }))).matchedScope).toBe("JOB_FAMILY_GRADE");
        await inTenant(() => svc.linkTestBlueprint({ ...as("manager"), blueprintId: req.id, scopeType: "REQUISITION", scopeId: 21 }));
        expect((await inTenant(() => svc.resolveTestBlueprint({ ...as("manager"), requisitionId: 21 })))).toMatchObject({ matchedScope: "REQUISITION", blueprint: { id: req.id } });
        expect((await inTenant(() => svc.resolveTestBlueprint({ ...as("recruiter"), requisitionId: 22 })))).toMatchObject({ matchedScope: null, blueprint: null });
        expect((await refusal(inTenant(() => svc.resolveTestBlueprint({ ...as("manager"), requisitionId: 22 })))).status).toBe(404);
    });

    it("one active link per scope: linking replaces the previous one", async () => {
        seedDeepPool();
        const a = await published();
        const b = await published();
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: a.id, scopeType: "REQUISITION", scopeId: 21 }));
        const out = await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: b.id, scopeType: "REQUISITION", scopeId: 21 }));
        expect(out.replacedLinkId).not.toBeNull();
        expect(state.links.filter((l) => l.isActive)).toEqual([expect.objectContaining({ blueprintId: b.id, scopeId: 21 })]);
        const same = await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: b.id, scopeType: "REQUISITION", scopeId: 21 }));
        expect(same.unchanged).toBe(true);
    });

    it("a draft never replaces a published test; managers link only their own requisitions", async () => {
        seedDeepPool();
        const live = await published();
        await inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: live.id, scopeType: "REQUISITION", scopeId: 21 }));
        const draft = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        const err = await refusal(inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: draft.id, scopeType: "REQUISITION", scopeId: 21 })));
        expect(err).toMatchObject({ status: 409, code: "HR-RECRUITMENT-BLUEPRINT-LINK-WOULD-UNLINK" });
        expect((await refusal(inTenant(() => svc.linkTestBlueprint({ ...as("manager"), blueprintId: live.id, scopeType: "REQUISITION", scopeId: 22 })))).status).toBe(403);
        expect((await refusal(inTenant(() => svc.linkTestBlueprint({ ...as("manager"), blueprintId: live.id, scopeType: "JOB_FAMILY", scopeKey: "FINANCE" })))).status).toBe(403);
        expect((await refusal(inTenant(() => svc.linkTestBlueprint({ ...as("recruiter"), blueprintId: live.id, scopeType: "JOB_FAMILY_GRADE", scopeKey: "FINANCE", scopeId: 99 })))).status).toBe(404);
    });

    it("another tenant's blueprint and requisition are not found", async () => {
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        const other = { ...as("recruiter"), tenantId: OTHER };
        expect((await refusal(inTenant(() => svc.getTestBlueprint({ ...other, blueprintId: bp.id }), OTHER))).status).toBe(404);
        expect((await refusal(inTenant(() => svc.resolveTestBlueprint({ ...other, requisitionId: 21 }), OTHER))).status).toBe(404);
    });
});

describe("preview", () => {
    it("draws the blueprint's counts with stems and options only, and touches no exposure", async () => {
        seedDeepPool();
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        const before = structuredClone(state.items);
        const out = await inTenant(() => svc.previewTestBlueprint({ ...as("reviewer"), blueprintId: bp.id }));
        expect(out).toMatchObject({ blueprintId: bp.id, sample: true, durationMin: 30 });
        expect(out.sections.map((s) => s.items.length)).toEqual([4, 2]);
        const dump = JSON.stringify(out);
        expect(dump).not.toMatch(/answerKey|optionIds|rationale|feedback|right because|exposure/);
        for (const item of out.sections.flatMap((s) => s.items)) {
            expect(Object.keys(item).sort()).toEqual(["difficulty", "itemCode", "mediaId", "options", "stem", "type", "version"]);
            for (const o of item.options) expect(Object.keys(o).sort()).toEqual(["id", "text"]);
        }
        expect(state.items).toEqual(before);
        expect(db.candidateTestItem.updateMany).not.toHaveBeenCalled();
        const selects = db.candidateTestItem.findMany.mock.calls.map(([args]) => args.select);
        expect(selects.every((s) => s && !s.answerKey && !s.rationale && !s.exposureCount)).toBe(true);
    });

    it("reports a shortfall rather than inventing items; managers cannot preview", async () => {
        addItems("domain", "EASY", 1);
        const bp = await inTenant(() => svc.createTestBlueprint({ ...as("author"), input: blueprintInput() }));
        const out = await inTenant(() => svc.previewTestBlueprint({ ...as("recruiter"), blueprintId: bp.id }));
        expect(out.sections[0].shortfall).toEqual({ EASY: 1, MEDIUM: 2 });
        expect((await refusal(inTenant(() => svc.previewTestBlueprint({ ...as("manager"), blueprintId: bp.id })))).status).toBe(403);
    });
});
