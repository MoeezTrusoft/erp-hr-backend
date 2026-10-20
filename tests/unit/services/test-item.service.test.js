// Phase 3b — the test item bank service: the flag, authoring, key visibility
// per capability, the review lifecycle and four eyes (a recruiter who wrote an
// item cannot review it), versioning (published versions are immutable, an
// edit is the next version, publishing it retires the previous one), retire,
// the statistics read and AI drafting.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createTestItemDb, createEventRecorder } from "./helpers/test-item.fake.js";

const { db, state } = createTestItemDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();
const runAiTask = jest.fn();
const loadAliasIndex = jest.fn(async () => new Map([["numerical reasoning", { skillId: 7, precedence: 3 }]]));
const requisitionSkillRequirements = jest.fn((req) => req?.jobContent?.skills ?? null);

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask }));
jest.unstable_mockModule("../../../src/services/candidateMatch.service.js", () => ({ loadAliasIndex, requisitionSkillRequirements }));

const svc = await import("../../../src/services/test-item.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const as = (roles, employeeId) => resolveAssessmentAccess({ roles, employeeId, tenantId: TENANT });
const AUTHOR_A = as(["ASSESSMENT_AUTHOR"], 11);
const AUTHOR_B = as(["ASSESSMENT_AUTHOR"], 12);
const REVIEWER = as(["ASSESSMENT_REVIEWER"], 21);
const RECRUITER = as(["RECRUITER"], 31);
const RECRUITER_2 = as(["RECRUITER"], 32);
const RECEPTION = as(["RECEPTION"], 41);
const MANAGER = as(["HIRING_MANAGER"], 51);
const INTERVIEWER = as(["INTERVIEWER"], 61);

const run = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, async () => await fn());
const call = (name, args) => run(() => svc[name]({ tenantId: TENANT, ...args }));
const item = (id) => state.items.find((i) => i.id === id);

const input = (over = {}) => ({
    type: "SINGLE",
    stem: "<p>What is 2 + 2?</p>",
    options: [{ id: "a", text: "3", feedback: "Off by one" }, { id: "b", text: "4" }, { id: "c", text: "5" }],
    answerKey: { optionIds: ["b"] },
    difficulty: "EASY",
    competencyKey: "Numerical Reasoning",
    rationale: "Basic addition used in stock counts",
    ...over,
});
const create = (access = AUTHOR_A, over = {}) => call("createTestItem", { access, input: input(over) });
const submit = (itemId, access = AUTHOR_A) => call("submitTestItemForReview", { access, itemId });
const decide = (itemId, decision, access = REVIEWER, comment) => call("decideTestItemReview", { access, itemId, decision, comment });
async function published(access = AUTHOR_A, over = {}) {
    const created = await create(access, over);
    await submit(created.id, access);
    return decide(created.id, "PUBLISH", access === REVIEWER ? RECRUITER : REVIEWER);
}

beforeEach(() => {
    for (const key of Object.keys(state)) state[key] = [];
    events.length = 0;
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
    process.env.HR_RECRUITMENT_AI = "true";
    state.skills.push({ id: 7, tenantId: null, name: "Numerical reasoning" }, { id: 8, tenantId: OTHER, name: "Other" });
    state.grades.push({ id: 3, tenantId: TENANT, name: "G3" });
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
    delete process.env.HR_RECRUITMENT_AI;
});

describe("flag", () => {
    it.each([
        ["listTestItems", {}],
        ["getTestItem", { itemId: 1 }],
        ["createTestItem", { input: input() }],
        ["updateTestItem", { itemId: 1, patch: {} }],
        ["submitTestItemForReview", { itemId: 1 }],
        ["decideTestItemReview", { itemId: 1, decision: "PUBLISH" }],
        ["retireTestItem", { itemId: 1, reason: "x" }],
        ["getTestItemStats", { itemId: 1 }],
        ["draftTestItemsWithAi", { competencyKeys: ["x"] }],
    ])("%s answers 503 *-DISABLED when onsiteTest is off", async (name, args) => {
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        await expect(call(name, { access: RECRUITER, ...args })).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" });
        expect(db.contextLog).toHaveLength(0);
    });
});

describe("create", () => {
    it("stores a DRAFT v1 authored by the caller, with the key as JSON and the competency linked to its skill", async () => {
        const res = await create();
        const row = item(res.id);
        expect(row).toMatchObject({ tenantId: TENANT, version: 1, status: "DRAFT", authorId: 11, aiDrafted: false, competencyKey: "numerical-reasoning", skillId: 7 });
        expect(JSON.parse(row.answerKey)).toEqual({ optionIds: ["b"] });
        expect(row.itemCode).toMatch(/^TI-NUMERICAL-REASONING-/);
        expect(res.answerKey).toEqual({ optionIds: ["b"] });
        expect(db.contextLog.every((q) => q.tenantId === TENANT)).toBe(true);
    });

    it("stores the job family upper-cased on create and update, and filters the same way", async () => {
        const res = await create(AUTHOR_A, { jobFamily: " warehouse " });
        expect(item(res.id).jobFamily).toBe("WAREHOUSE");
        await call("updateTestItem", { access: AUTHOR_A, itemId: res.id, patch: { jobFamily: "stores " } });
        expect(item(res.id).jobFamily).toBe("STORES");
        expect((await call("listTestItems", { access: RECRUITER, jobFamily: "Stores" })).total).toBe(1);
    });

    it("refuses invalid items with every reason, unknown skills and grades, and duplicates", async () => {
        await expect(create(AUTHOR_A, { options: [{ id: "a", text: "x" }], difficulty: "NOPE" })).rejects.toMatchObject({
            status: 400,
            code: "HR-RECRUITMENT-TEST-ITEM-INVALID",
            details: { errors: expect.arrayContaining([expect.objectContaining({ field: "options" }), expect.objectContaining({ field: "difficulty" })]) },
        });
        await expect(create(AUTHOR_A, { skillId: 8 })).rejects.toMatchObject({ status: 400, details: { errors: [expect.objectContaining({ field: "skillId" })] } });
        await expect(create(AUTHOR_A, { gradeLevelIds: [3, 99] })).rejects.toMatchObject({ details: { errors: [expect.objectContaining({ message: expect.stringContaining("99") })] } });
        await create();
        await expect(create(AUTHOR_B)).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-ITEM-DUPLICATE" });
        expect(state.items).toHaveLength(1);
    });

    it("needs the author capability and an employee identity", async () => {
        await expect(create(RECEPTION)).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN" });
        await expect(create(MANAGER)).rejects.toMatchObject({ status: 403 });
        await expect(create(resolveAssessmentAccess({ roles: ["ASSESSMENT_AUTHOR"] }))).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-ASSESSMENT-ACTOR-REQUIRED" });
    });
});

describe("visibility and the answer key", () => {
    let draftA;
    let publishedA;
    beforeEach(async () => {
        draftA = await create(AUTHOR_A, { stem: "Draft by A" });
        publishedA = await published(AUTHOR_A, { stem: "Published by A", discussionPrompt: true });
        await published(AUTHOR_A, { stem: "Published, not a prompt" });
        await create(AUTHOR_B, { stem: "Draft by B" });
    });

    it("lists never carry the key, the feedback or the rationale", async () => {
        const res = await call("listTestItems", { access: RECRUITER });
        expect(res.total).toBe(4);
        for (const row of res.items) {
            expect(row).not.toHaveProperty("answerKey");
            expect(row).not.toHaveProperty("rationale");
            expect(row).not.toHaveProperty("options");
            expect(row.optionCount).toBe(3);
        }
    });

    it("an author sees their own drafts and published items; reviewers see all", async () => {
        const mine = await call("listTestItems", { access: AUTHOR_A });
        expect(mine.items.map((i) => i.stem).sort()).toEqual(["Draft by A", "Published by A", "Published, not a prompt"]);
        const theirs = await call("listTestItems", { access: AUTHOR_B });
        expect(theirs.items.map((i) => i.stem).sort()).toEqual(["Draft by B", "Published by A", "Published, not a prompt"]);
        expect((await call("listTestItems", { access: REVIEWER })).total).toBe(4);
        expect((await call("listTestItems", { access: REVIEWER, status: "DRAFT", q: "by b" })).items.map((i) => i.stem)).toEqual(["Draft by B"]);
        await expect(call("getTestItem", { access: AUTHOR_B, itemId: draftA.id })).rejects.toMatchObject({ status: 404 });
    });

    it("the key, feedback and rationale go to the item's author, reviewers and recruiters only", async () => {
        for (const access of [AUTHOR_A, REVIEWER, RECRUITER]) {
            const res = await call("getTestItem", { access, itemId: publishedA.id });
            expect(res.answerKey).toEqual({ optionIds: ["b"] });
            expect(res.rationale).toBeTruthy();
            expect(res.options[0].feedback).toBe("Off by one");
        }
        const other = await call("getTestItem", { access: AUTHOR_B, itemId: publishedA.id });
        expect(other).not.toHaveProperty("answerKey");
        expect(other).not.toHaveProperty("rationale");
        expect(other.options[0]).toEqual({ id: "a", text: "3" });
    });

    it("managers and interviewers read only published discussion prompts, without the key; reception reads nothing", async () => {
        for (const access of [MANAGER, INTERVIEWER]) {
            const res = await call("getTestItem", { access, itemId: publishedA.id });
            expect(res).not.toHaveProperty("answerKey");
            expect(res).not.toHaveProperty("rationale");
            expect(res.options.some((o) => "feedback" in o)).toBe(false);
            await expect(call("getTestItem", { access, itemId: draftA.id })).rejects.toMatchObject({ status: 404 });
        }
        await expect(call("getTestItem", { access: RECEPTION, itemId: publishedA.id })).rejects.toMatchObject({ status: 403 });
        await expect(call("listTestItems", { access: RECEPTION })).rejects.toMatchObject({ status: 403 });
    });

    it("another tenant sees nothing", async () => {
        await expect(run(() => svc.getTestItem({ tenantId: OTHER, access: RECRUITER, itemId: publishedA.id }), OTHER)).rejects.toMatchObject({ status: 404 });
    });
});

describe("review lifecycle and four eyes", () => {
    it("submit needs a rationale and the author (or a recruiter)", async () => {
        const res = await create(AUTHOR_A, { rationale: undefined });
        await expect(submit(res.id)).rejects.toMatchObject({ status: 400, details: { errors: [expect.objectContaining({ field: "rationale" })] } });
        await call("updateTestItem", { access: AUTHOR_A, itemId: res.id, patch: { rationale: "Now explained" } });
        await expect(submit(res.id, AUTHOR_B)).rejects.toMatchObject({ status: 404 });
        const done = await submit(res.id);
        expect(done.status).toBe("IN_REVIEW");
        expect(item(res.id).submittedAt).toBeInstanceOf(Date);
        await expect(submit(res.id)).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-ITEM-STATE" });
    });

    it("an item in review cannot be edited; the author cannot review it", async () => {
        const res = await create();
        await submit(res.id);
        await expect(call("updateTestItem", { access: AUTHOR_A, itemId: res.id, patch: { stem: "x" } })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-ITEM-IN-REVIEW" });
        await expect(decide(res.id, "PUBLISH", AUTHOR_A)).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN" });
    });

    it("a recruiter who wrote an item cannot review it; another recruiter can", async () => {
        const res = await create(RECRUITER);
        await submit(res.id, RECRUITER);
        await expect(decide(res.id, "PUBLISH", RECRUITER)).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FOUR-EYES" });
        expect(item(res.id).status).toBe("IN_REVIEW");
        const done = await decide(res.id, "PUBLISH", RECRUITER_2);
        expect(done).toMatchObject({ status: "PUBLISHED", reviewerId: 32, authorId: 31 });
    });

    it("RETURN needs a comment and sends the item back to DRAFT", async () => {
        const res = await create();
        await submit(res.id);
        await expect(decide(res.id, "RETURN")).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-TEST-ITEM-COMMENT-REQUIRED" });
        const back = await decide(res.id, "RETURN", REVIEWER, "Option c is ambiguous");
        expect(back).toMatchObject({ status: "DRAFT", reviewComment: "Option c is ambiguous" });
        expect(events).toHaveLength(0);
        await call("updateTestItem", { access: AUTHOR_A, itemId: res.id, patch: { options: [{ id: "a", text: "3" }, { id: "b", text: "4" }] } });
        await submit(res.id);
        const pub = await decide(res.id, "PUBLISH");
        expect(pub).toMatchObject({ status: "PUBLISHED", reviewerId: 21 });
        expect(events).toEqual([expect.objectContaining({ eventName: "hr.recruitment.test_item_published.v1", aggregateType: "CandidateTestItem", aggregateId: res.id, payload: { itemId: String(res.id), itemCode: res.itemCode, version: 1 } })]);
    });

    it("refuses an unknown decision and a decision on a draft", async () => {
        const res = await create();
        await expect(decide(res.id, "MAYBE")).rejects.toMatchObject({ status: 400 });
        await expect(decide(res.id, "PUBLISH")).rejects.toMatchObject({ status: 409 });
        await expect(decide(res.id, "PUBLISH", AUTHOR_B)).rejects.toMatchObject({ status: 403 });
    });

    it("a draft is edited in place by its author only, so no one else becomes a hidden co-author", async () => {
        const res = await create();
        await expect(call("updateTestItem", { access: AUTHOR_B, itemId: res.id, patch: { stem: "x" } })).rejects.toMatchObject({ status: 404 });
        // A recruiter could otherwise edit the draft and then pass four eyes as its reviewer.
        await expect(call("updateTestItem", { access: RECRUITER, itemId: res.id, patch: { difficulty: "HARD" } }))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN" });
        const edited = await call("updateTestItem", { access: AUTHOR_A, itemId: res.id, patch: { difficulty: "HARD", answerKey: { optionIds: ["c"] } } });
        expect(edited).toMatchObject({ id: res.id, version: 1, difficulty: "HARD", createdVersion: false, answerKey: { optionIds: ["c"] } });
        expect(state.items).toHaveLength(1);
        await expect(call("updateTestItem", { access: AUTHOR_A, itemId: res.id, patch: { answerKey: { optionIds: ["z"] } } })).rejects.toMatchObject({ status: 400 });
    });
});

describe("versioning", () => {
    it("a published item is immutable: an edit creates the next version as a DRAFT", async () => {
        const v1 = await published();
        const before = structuredClone(item(v1.id));
        const v2 = await call("updateTestItem", { access: AUTHOR_B, itemId: v1.id, patch: { stem: "<p>What is 3 + 3?</p>", answerKey: { optionIds: ["a"] } } });
        expect(v2).toMatchObject({ itemCode: v1.itemCode, version: 2, status: "DRAFT", authorId: 12, createdVersion: true, previousItemId: v1.id, reviewerId: null });
        expect(item(v1.id)).toEqual(before);
        await expect(call("updateTestItem", { access: AUTHOR_A, itemId: v1.id, patch: { stem: "again" } })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-ITEM-VERSION-OPEN", details: { itemId: v2.id } });
    });

    it("publishing the new version retires the previous one automatically", async () => {
        const v1 = await published(RECRUITER);
        const v2 = await call("updateTestItem", { access: AUTHOR_B, itemId: v1.id, patch: { stem: "<p>Revised</p>" } });
        await submit(v2.id, AUTHOR_B);
        events.length = 0;
        const res = await decide(v2.id, "PUBLISH", RECRUITER); // v1's author may review v2: B wrote it
        expect(res.retiredItemIds).toEqual([v1.id]);
        expect(item(v1.id)).toMatchObject({ status: "RETIRED", retiredAt: expect.any(Date) });
        expect(item(v2.id).status).toBe("PUBLISHED");
        expect(events.map((e) => [e.eventName, e.aggregateId, e.payload.reasonCode ?? null])).toEqual([
            ["hr.recruitment.test_item_published.v1", v2.id, null],
            ["hr.recruitment.test_item_retired.v1", v1.id, "SUPERSEDED"],
        ]);
        await expect(call("updateTestItem", { access: RECRUITER, itemId: v1.id, patch: { stem: "x" } })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEST-ITEM-RETIRED" });
    });
});

describe("retire and statistics", () => {
    it("reviewers and recruiters retire with a reason; authors cannot", async () => {
        const pub = await published();
        await expect(call("retireTestItem", { access: AUTHOR_A, itemId: pub.id, reason: "Old" })).rejects.toMatchObject({ status: 403 });
        await expect(call("retireTestItem", { access: REVIEWER, itemId: pub.id, reason: "  " })).rejects.toMatchObject({ status: 400 });
        events.length = 0;
        const res = await call("retireTestItem", { access: RECRUITER, itemId: pub.id, reason: "Leaked on a forum" });
        expect(res).toMatchObject({ status: "RETIRED", reviewComment: "Retired: Leaked on a forum" });
        expect(events).toEqual([expect.objectContaining({ eventName: "hr.recruitment.test_item_retired.v1", payload: expect.objectContaining({ reasonCode: "MANUAL", previousStatus: "PUBLISHED" }) })]);
        await expect(call("retireTestItem", { access: RECRUITER, itemId: pub.id, reason: "again" })).rejects.toMatchObject({ status: 409 });
    });

    it("returns the latest statistics rows and flags to reviewers only", async () => {
        const pub = await published();
        state.stats.push(
            { id: 1, tenantId: TENANT, itemId: pub.id, period: "2026-10-18", sampleSize: 40, difficulty: 0.5, discrimination: 0.3, distractorRates: null, avgTimeSec: 20, flags: [], computedAt: new Date() },
            { id: 2, tenantId: TENANT, itemId: pub.id, period: "2026-10-19", sampleSize: 41, difficulty: 0.97, discrimination: 0.05, distractorRates: null, avgTimeSec: 18, flags: ["TOO_EASY", "LOW_DISCRIMINATION"], computedAt: new Date() },
        );
        const res = await call("getTestItemStats", { access: REVIEWER, itemId: pub.id });
        expect(res.latest.period).toBe("2026-10-19");
        expect(res.flags).toEqual(["TOO_EASY", "LOW_DISCRIMINATION"]);
        expect(res.history).toHaveLength(2);
        await expect(call("getTestItemStats", { access: AUTHOR_A, itemId: pub.id })).rejects.toMatchObject({ status: 403 });
    });
});

describe("AI drafting", () => {
    const draft = (over = {}) => ({ type: "SINGLE", competencyKey: "inventory-control", stem: "Which document records goods received?", options: ["GRN", "Invoice", "Payslip"], correctOptionIds: ["a"], rationale: "The GRN records receipt", ...over });
    const draftAi = (over = {}) => call("draftTestItemsWithAi", { access: AUTHOR_A, requisitionId: 21, count: 3, ...over });

    beforeEach(() => {
        state.requisitions.push({ id: 21, tenantId: TENANT, title: "Storekeeper", jobContent: { skills: { required: ["Inventory Control"], preferred: [] }, summary: "Runs the store" }, requirements: null });
    });

    it("is behind the ai flag", async () => {
        delete process.env.HR_RECRUITMENT_AI;
        await expect(draftAi()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-AI-DISABLED" });
        expect(runAiTask).not.toHaveBeenCalled();
    });

    it("sends the requisition's skills and stores valid drafts as aiDrafted DRAFTs; invalid ones are dropped with a reason", async () => {
        runAiTask.mockResolvedValue({ taskId: "t-1", status: "completed", output: { result: { items: [draft(), draft({ stem: "Bad", correctOptionIds: ["z"] }), draft({ competencyKey: "cooking" })] } } });
        const res = await draftAi();
        expect(runAiTask).toHaveBeenCalledWith(expect.objectContaining({
            promptKey: "hr.assessment.item.draft.v1",
            tenantId: TENANT,
            input: expect.objectContaining({ competencies: ["inventory-control"], count: 3, difficulty: "MEDIUM", language: "en", itemTypes: ["SINGLE"] }),
        }));
        expect(res.created).toHaveLength(1);
        expect(res.dropped.map((d) => d.index)).toEqual([1, 2]);
        expect(item(res.created[0].id)).toMatchObject({ status: "DRAFT", aiDrafted: true, authorId: 11, competencyKey: "inventory-control" });
        expect(res.created[0]).not.toHaveProperty("answerKey");
    });

    it("drops a draft that duplicates an existing item", async () => {
        runAiTask.mockResolvedValue({ taskId: "t-2", status: "completed", output: { result: [draft(), draft()] } });
        const first = await draftAi();
        expect(first.created).toHaveLength(1);
        expect(first.dropped).toEqual([expect.objectContaining({ reason: expect.stringMatching(/Duplicate/) })]);
    });

    it("answers a clear 503 when the plane is down or slow, and 502 for an unusable answer", async () => {
        runAiTask.mockRejectedValueOnce(Object.assign(new Error("redis down"), { status: 503, code: "HR-AI-PLANE-UNAVAILABLE" }));
        await expect(draftAi()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-AI-UNAVAILABLE", message: expect.stringMatching(/unavailable/) });
        runAiTask.mockResolvedValueOnce({ taskId: "t-3", status: "pending", pending: true });
        await expect(draftAi()).rejects.toMatchObject({ status: 503, details: { taskId: "t-3" } });
        runAiTask.mockResolvedValueOnce({ taskId: "t-4", status: "completed", output: { result: { raw: "I cannot help" } } });
        await expect(draftAi()).rejects.toMatchObject({ status: 502, code: "HR-RECRUITMENT-AI-OUTPUT-INVALID" });
        expect(state.items).toHaveLength(0);
    });

    it("validates the request and the caller", async () => {
        await expect(draftAi({ count: 11 })).rejects.toMatchObject({ status: 400 });
        await expect(draftAi({ types: ["IMAGE_SINGLE"] })).rejects.toMatchObject({ status: 400 });
        await expect(draftAi({ requisitionId: 999 })).rejects.toMatchObject({ status: 404 });
        await expect(call("draftTestItemsWithAi", { access: REVIEWER, competencyKeys: ["x"] })).rejects.toMatchObject({ status: 403 });
        await expect(call("draftTestItemsWithAi", { access: AUTHOR_A })).rejects.toMatchObject({ status: 400 });
    });
});
