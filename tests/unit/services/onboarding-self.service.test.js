// Recruitment Phase 4 — the new hire's pre-boarding portal and HR's review of
// their uploads, against an in-memory Prisma that enforces the tenant context
// at await time.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

import { makeSelfPortalDb } from "./helpers/onboarding-self.fake.js";

const fake = { current: null };
const dbProxy = new Proxy({}, { get: (_t, key) => fake.current.db[key] });

const uploadFileToDAM = jest.fn();
const deleteDamAsset = jest.fn(async () => ({ ok: true }));

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: dbProxy, prisma: dbProxy }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM, deleteDamAsset }));

const svc = await import("../../../src/services/onboarding-self.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const HIRE = 101;
const OTHER = 102;
const MANAGER = 103;
const BUDDY = 104;
const HR = 105;
const NOW = new Date("2026-10-20T09:00:00Z");

const PDF_B64 = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 7)]).toString("base64");

const asUser = (fn, { tenantId = T1, employeeId = HIRE } = {}) =>
    mcpCtx.run({ user: { tenantId, employeeId } }, async () => await fn());

const failure = async (promise) => {
    try {
        await promise;
    } catch (err) {
        return { status: err.status, code: err.code, message: err.message };
    }
    throw new Error("expected a failure");
};

let ids;
function seedWorld() {
    const f = makeSelfPortalDb();
    fake.current = f;
    const person = (id, extra = {}) => f.seed("employee", { id, tenant_id: T1, employee_name: `Person ${id}`, work_email: `p${id}@acme.test`, managerId: null, ...extra });
    person(HIRE, { managerId: MANAGER, employee_name: null, first_name: "Ayesha", last_name: "Khan" });
    person(OTHER);
    person(MANAGER);
    person(BUDDY);
    person(HR);
    f.seed("employee", { id: 201, tenant_id: T2, employee_name: "Other tenant" });

    const mine = f.seed("onboardingChecklist", { tenantId: T1, employeeId: HIRE, status: "IN_PROGRESS", currentStage: "pre_boarding", startDate: new Date("2026-11-02") });
    const theirs = f.seed("onboardingChecklist", { tenantId: T1, employeeId: OTHER, status: "IN_PROGRESS", startDate: new Date("2026-11-02") });
    const t = (checklistId, assigneeType, extra = {}) => f.seed("onboardingTask", { tenantId: T1, checklistId, title: `${assigneeType} task`, assigneeType, ...extra });
    const myTask = t(mine.id, "NEW_HIRE", { title: "Read the handbook", dueDate: new Date("2026-10-30") });
    const myDone = t(mine.id, "NEW_HIRE", { completed: true, completedAt: new Date("2026-10-18") });
    const hrTask = t(mine.id, "HR", { category: "HR_DOCUMENTATION", assigneeId: HR, completed: true });
    t(mine.id, "IT");
    const theirTask = t(theirs.id, "NEW_HIRE");

    f.seed("onboardingSession", { tenantId: T1, checklistId: mine.id, title: "Orientation", sessionDate: new Date("2026-11-02"), fromTime: "09:00", toTime: "10:00", location: "Room 1", sessionType: "orientation", required: true });
    f.seed("onboardingSession", { tenantId: T1, checklistId: theirs.id, title: "Their session" });

    const policy = f.seed("onboardingDocument", { tenantId: T1, checklistId: mine.id, employeeId: HIRE, title: "Code of conduct", mediaId: 11, requiresSign: true });
    const rejected = f.seed("onboardingDocument", { tenantId: T1, checklistId: mine.id, employeeId: HIRE, title: "CNIC", mediaId: 12, source: "NEW_HIRE", reviewStatus: "REJECTED", reviewNote: "Blurry, please rescan" });
    const verified = f.seed("onboardingDocument", { tenantId: T1, checklistId: mine.id, employeeId: HIRE, title: "Degree", mediaId: 13, source: "NEW_HIRE", reviewStatus: "VERIFIED", reviewNote: "internal: checked with HEC" });
    const theirDoc = f.seed("onboardingDocument", { tenantId: T1, checklistId: theirs.id, employeeId: OTHER, title: "Their policy", mediaId: 14, requiresSign: true });
    // A row on the hire's checklist that names someone else is never shown.
    f.seed("onboardingDocument", { tenantId: T1, checklistId: mine.id, employeeId: OTHER, title: "Misfiled", mediaId: 15 });

    const s30 = f.seed("onboardingSurvey", { tenantId: T1, checklistId: mine.id, employeeId: HIRE, type: "DAY_30", issuedAt: new Date("2026-10-15"), dueAt: new Date("2026-10-22") });
    f.seed("onboardingSurvey", { tenantId: T1, checklistId: mine.id, employeeId: HIRE, type: "DAY_60" }); // not issued yet
    f.seed("onboardingSurvey", { tenantId: T1, checklistId: theirs.id, employeeId: OTHER, type: "DAY_30", issuedAt: new Date("2026-10-15") });
    f.seed("onboardingBuddy", { tenantId: T1, checklistId: mine.id, buddyId: BUDDY });

    ids = { mine: mine.id, theirs: theirs.id, myTask: myTask.id, myDone: myDone.id, hrTask: hrTask.id, theirTask: theirTask.id, policy: policy.id, rejected: rejected.id, verified: verified.id, theirDoc: theirDoc.id, s30: s30.id };
    return f;
}

const ORIGINAL_FLAG = process.env.HR_ONBOARDING_SELF_PORTAL;
beforeEach(() => {
    process.env.HR_ONBOARDING_SELF_PORTAL = "true";
    jest.clearAllMocks();
    uploadFileToDAM.mockResolvedValue([{ id: 777 }]);
    seedWorld();
});
afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.HR_ONBOARDING_SELF_PORTAL;
    else process.env.HR_ONBOARDING_SELF_PORTAL = ORIGINAL_FLAG;
});

describe("the flag", () => {
    it("every function answers 503 -DISABLED while it is off", async () => {
        process.env.HR_ONBOARDING_SELF_PORTAL = "false";
        const calls = [
            () => svc.getMyOnboarding({ tenantId: T1, employeeId: HIRE }),
            () => svc.completeMyTask({ tenantId: T1, employeeId: HIRE, taskId: ids.myTask }),
            () => svc.reopenMyTask({ tenantId: T1, employeeId: HIRE, taskId: ids.myDone }),
            () => svc.uploadMyDocument({ tenantId: T1, employeeId: HIRE, title: "x", fileName: "a.pdf", mimeType: "application/pdf", contentBase64: PDF_B64 }),
            () => svc.signMyDocument({ tenantId: T1, employeeId: HIRE, documentId: ids.policy }),
            () => svc.submitMySurvey({ tenantId: T1, employeeId: HIRE, type: "DAY_30", responses: { q1: 5 } }),
            () => svc.reviewOnboardingDocument({ tenantId: T1, reviewerId: HR, documentId: ids.rejected, decision: "VERIFIED" }),
            () => svc.listPendingOnboardingDocuments({ tenantId: T1 }),
        ];
        for (const call of calls) {
            expect(await failure(asUser(call))).toMatchObject({ status: 503, code: "HR-ONBOARDING-SELF-PORTAL-DISABLED" });
        }
        expect(uploadFileToDAM).not.toHaveBeenCalled();
        expect(fake.current.events()).toHaveLength(0);
    });
});

describe("hr_self_onboarding_get", () => {
    it("shows the caller's own checklist, NEW_HIRE tasks, counts, sessions, documents, surveys, buddy and manager", async () => {
        const out = await asUser(() => svc.getMyOnboarding({ tenantId: T1, employeeId: HIRE }));
        expect(out.checklist).toMatchObject({ id: ids.mine, status: "IN_PROGRESS", stage: "pre_boarding" });
        expect(out.progress).toEqual({ total: 4, done: 2, percent: 50, newHire: { total: 2, done: 1 }, others: { total: 2, done: 1 } });
        expect(out.tasks.map((t) => t.id).sort()).toEqual([ids.myTask, ids.myDone].sort());
        expect(out.sessions).toEqual([expect.objectContaining({ title: "Orientation", fromTime: "09:00", toTime: "10:00", location: "Room 1", type: "orientation", required: true })]);
        expect(out.documents.map((d) => d.title).sort()).toEqual(["CNIC", "Code of conduct", "Degree"]);
        const byTitle = Object.fromEntries(out.documents.map((d) => [d.title, d]));
        expect(byTitle["Code of conduct"]).toMatchObject({ requiresSign: true, signed: false, source: "HR" });
        expect(byTitle.CNIC).toMatchObject({ reviewStatus: "REJECTED", reviewNote: "Blurry, please rescan" });
        // HR's note on a verified document is internal and stays with HR.
        expect(byTitle.Degree.reviewNote).toBeNull();
        expect(out.openSurveys).toEqual([expect.objectContaining({ id: ids.s30, type: "DAY_30" })]);
        expect(out.buddy).toEqual({ id: BUDDY, name: `Person ${BUDDY}`, workEmail: `p${BUDDY}@acme.test` });
        expect(out.manager).toEqual({ id: MANAGER, name: `Person ${MANAGER}`, workEmail: `p${MANAGER}@acme.test` });
        expect(JSON.stringify(out)).not.toMatch(/Their|Misfiled|internal: checked/);
    });

    it("answers calmly when the caller has no checklist", async () => {
        const out = await asUser(() => svc.getMyOnboarding({ tenantId: T1, employeeId: BUDDY }), { employeeId: BUDDY });
        expect(out).toMatchObject({ checklist: null, tasks: [], sessions: [], documents: [], openSurveys: [], buddy: null, manager: null });
        expect(out.progress.total).toBe(0);
    });

    it("a caller with no employee record in the tenant gets a calm 400", async () => {
        expect(await failure(asUser(() => svc.getMyOnboarding({ tenantId: T1, employeeId: 999 }))))
            .toMatchObject({ status: 400, code: "HR-ONBOARDING-SELF-NO-EMPLOYEE" });
        // The other tenant's employee does not exist for tenant 1.
        expect(await failure(asUser(() => svc.getMyOnboarding({ tenantId: T1, employeeId: 201 }))))
            .toMatchObject({ status: 400, code: "HR-ONBOARDING-SELF-NO-EMPLOYEE" });
    });

    it("every query ran under the caller's tenant", async () => {
        await asUser(() => svc.getMyOnboarding({ tenantId: T1, employeeId: HIRE }));
        expect(fake.current.state.ops.length).toBeGreaterThan(5);
        expect(fake.current.state.ops.every((op) => op.tenant === T1)).toBe(true);
    });
});

describe("tasks", () => {
    it("completes and reopens the caller's NEW_HIRE task with one task_updated event each", async () => {
        const done = await asUser(() => svc.completeMyTask({ tenantId: T1, employeeId: HIRE, taskId: ids.myTask, now: NOW }));
        expect(done).toMatchObject({ changed: true, task: { id: ids.myTask, completed: true } });
        expect(fake.current.all("onboardingTask").find((t) => t.id === ids.myTask).completedAt).toEqual(NOW);
        const again = await asUser(() => svc.completeMyTask({ tenantId: T1, employeeId: HIRE, taskId: ids.myTask }));
        expect(again.changed).toBe(false);
        const reopened = await asUser(() => svc.reopenMyTask({ tenantId: T1, employeeId: HIRE, taskId: ids.myTask }));
        expect(reopened).toMatchObject({ changed: true, task: { completed: false, completedAt: null } });

        const events = fake.current.events();
        expect(events.map((e) => e.eventName)).toEqual(["hr.onboarding.task_updated.v1", "hr.onboarding.task_updated.v1"]);
        expect(events[0].payload.payload).toMatchObject({ taskId: String(ids.myTask), status: "COMPLETED" });
        expect(events[0].payload.actor.id).toBe(String(HIRE));
        expect(events[1].payload.payload.status).toBe("PENDING");
    });

    it("refuses an HR task, another hire's task and a missing one with the same 404", async () => {
        for (const taskId of [ids.hrTask, ids.theirTask, 424242]) {
            expect(await failure(asUser(() => svc.completeMyTask({ tenantId: T1, employeeId: HIRE, taskId }))))
                .toMatchObject({ status: 404, code: "HR-ONBOARDING-NOT-FOUND", message: "Task not found" });
        }
        expect(fake.current.all("onboardingTask").find((t) => t.id === ids.theirTask).completed).toBe(false);
        expect(fake.current.events()).toHaveLength(0);
    });

    it("refuses changes once the checklist is complete", async () => {
        fake.current.all("onboardingChecklist").find((c) => c.id === ids.mine).status = "COMPLETED";
        expect(await failure(asUser(() => svc.reopenMyTask({ tenantId: T1, employeeId: HIRE, taskId: ids.myDone }))))
            .toMatchObject({ status: 409, code: "HR-ONBOARDING-CHECKLIST-CLOSED" });
    });

    it("every write ran in a transaction under the caller's tenant", async () => {
        await asUser(() => svc.completeMyTask({ tenantId: T1, employeeId: HIRE, taskId: ids.myTask }));
        const writes = fake.current.state.ops.filter((op) => ["updateMany", "create"].includes(op.op));
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every((op) => op.tx != null && op.tenant === T1)).toBe(true);
    });
});

describe("document upload", () => {
    const upload = (extra = {}) => asUser(() => svc.uploadMyDocument({
        tenantId: T1, employeeId: HIRE, title: "  Passport  ", category: "IDENTITY", fileName: "../my passport.pdf", mimeType: "application/pdf", contentBase64: PDF_B64, ...extra,
    }));

    it("stores the file in DAM and records a PENDING NEW_HIRE document with an event to HR", async () => {
        const out = await upload();
        expect(uploadFileToDAM).toHaveBeenCalledWith(
            expect.objectContaining({ mimetype: "application/pdf", originalname: "my passport.pdf", buffer: expect.any(Buffer) }),
            "document",
        );
        expect(out).toMatchObject({ fileName: "my passport.pdf", mimeType: "application/pdf", document: { title: "Passport", category: "IDENTITY", mediaId: 777, source: "NEW_HIRE", reviewStatus: "PENDING", requiresSign: false } });
        const row = fake.current.all("onboardingDocument").find((d) => d.mediaId === 777);
        expect(row).toMatchObject({ tenantId: T1, checklistId: ids.mine, employeeId: HIRE, source: "NEW_HIRE", reviewStatus: "PENDING" });
        const [event] = fake.current.events();
        expect(event.eventName).toBe("hr.onboarding.document_uploaded.v1");
        expect(event.payload.payload).toEqual({
            documentId: String(row.id), checklistId: String(ids.mine), employeeId: String(HIRE), source: "NEW_HIRE", reviewStatus: "PENDING", hrOwnerId: String(HR),
        });
        expect(JSON.stringify(event)).not.toMatch(/Passport|passport/);
    });

    it("validates before anything reaches DAM", async () => {
        expect(await failure(upload({ mimeType: "image/gif", fileName: "a.gif" }))).toMatchObject({ status: 400, code: "HR-ONBOARDING-UPLOAD-TYPE" });
        expect(await failure(upload({ contentBase64: "%%%%" }))).toMatchObject({ status: 400, code: "HR-ONBOARDING-UPLOAD-CONTENT" });
        expect(await failure(upload({ title: "   " }))).toMatchObject({ status: 400, code: "HR-ONBOARDING-VALIDATION" });
        expect(await failure(asUser(() => svc.uploadMyDocument({ tenantId: T1, employeeId: BUDDY, title: "x", fileName: "a.pdf", mimeType: "application/pdf", contentBase64: PDF_B64 }), { employeeId: BUDDY })))
            .toMatchObject({ status: 404, code: "HR-ONBOARDING-SELF-NO-CHECKLIST" });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("a DAM failure answers a plain 502 and stores nothing", async () => {
        uploadFileToDAM.mockResolvedValueOnce([]);
        const before = fake.current.all("onboardingDocument").length;
        expect(await failure(upload())).toMatchObject({ status: 502, code: "HR-ONBOARDING-DAM-UNAVAILABLE" });
        expect(fake.current.all("onboardingDocument")).toHaveLength(before);
        expect(fake.current.events()).toHaveLength(0);
    });

    it("a failed record removes the DAM asset again", async () => {
        const realCreate = fake.current.db.onboardingDocument.create;
        fake.current.db.onboardingDocument.create = () => ({ then: (_res, rej) => rej(new Error("db down")) });
        const before = fake.current.all("onboardingDocument").length;
        await expect(upload()).rejects.toThrow("db down");
        fake.current.db.onboardingDocument.create = realCreate;
        expect(deleteDamAsset).toHaveBeenCalledWith(777);
        expect(fake.current.all("onboardingDocument")).toHaveLength(before);
    });
});

describe("document sign", () => {
    it("signs the HR-supplied document once, with an event", async () => {
        const out = await asUser(() => svc.signMyDocument({ tenantId: T1, employeeId: HIRE, documentId: ids.policy, now: NOW }));
        expect(out.document).toMatchObject({ id: ids.policy, signed: true });
        expect(fake.current.all("onboardingDocument").find((d) => d.id === ids.policy)).toMatchObject({ signedAt: NOW, signedByEmpId: HIRE });
        const [event] = fake.current.events();
        expect(event.eventName).toBe("hr.onboarding.document_signed.v1");
        expect(event.payload.payload).toMatchObject({ documentId: String(ids.policy), signedByEmpId: String(HIRE), employeeId: String(HIRE) });
        expect(await failure(asUser(() => svc.signMyDocument({ tenantId: T1, employeeId: HIRE, documentId: ids.policy }))))
            .toMatchObject({ status: 409, code: "HR-ONBOARDING-DOCUMENT-ALREADY-SIGNED" });
    });

    it("refuses an upload, another hire's document and a document needing no signature", async () => {
        expect(await failure(asUser(() => svc.signMyDocument({ tenantId: T1, employeeId: HIRE, documentId: ids.rejected }))))
            .toMatchObject({ status: 409, code: "HR-ONBOARDING-DOCUMENT-NOT-SIGNABLE" });
        expect(await failure(asUser(() => svc.signMyDocument({ tenantId: T1, employeeId: HIRE, documentId: ids.theirDoc }))))
            .toMatchObject({ status: 404, message: "Document not found" });
        expect(fake.current.all("onboardingDocument").find((d) => d.id === ids.theirDoc).signedAt).toBeNull();
    });
});

describe("survey submit", () => {
    it("submits the issued survey once and emits survey_submitted without the answers", async () => {
        const out = await asUser(() => svc.submitMySurvey({ tenantId: T1, employeeId: HIRE, type: "DAY_30", responses: { roleClarity: 4, comments: "Great start" }, now: NOW }));
        expect(out.survey).toMatchObject({ id: ids.s30, type: "DAY_30" });
        expect(fake.current.all("onboardingSurvey").find((s) => s.id === ids.s30)).toMatchObject({ submittedAt: NOW, responses: { roleClarity: 4, comments: "Great start" } });
        const [event] = fake.current.events();
        expect(event.eventName).toBe("hr.onboarding.survey_submitted.v1");
        expect(event.payload.payload).toEqual({ surveyId: String(ids.s30), checklistId: String(ids.mine), employeeId: String(HIRE), surveyType: "DAY_30" });
        expect(JSON.stringify(event)).not.toMatch(/Great start/);
        expect(await failure(asUser(() => svc.submitMySurvey({ tenantId: T1, employeeId: HIRE, type: "DAY_30", responses: { q: 1 } }))))
            .toMatchObject({ status: 409, code: "HR-ONBOARDING-SURVEY-ALREADY-SUBMITTED" });
    });

    it("refuses a survey not yet issued, bad answers and a bad type", async () => {
        expect(await failure(asUser(() => svc.submitMySurvey({ tenantId: T1, employeeId: HIRE, type: "DAY_60", responses: { q: 1 } }))))
            .toMatchObject({ status: 404, code: "HR-ONBOARDING-SURVEY-NOT-ISSUED" });
        expect(await failure(asUser(() => svc.submitMySurvey({ tenantId: T1, employeeId: HIRE, type: "DAY_30", responses: {} }))))
            .toMatchObject({ status: 400, code: "HR-ONBOARDING-SURVEY-RESPONSES" });
        expect(await failure(asUser(() => svc.submitMySurvey({ tenantId: T1, employeeId: HIRE, type: "DAY_30", responses: { q: { nested: true } } }))))
            .toMatchObject({ status: 400, code: "HR-ONBOARDING-SURVEY-RESPONSES" });
        expect(await failure(asUser(() => svc.submitMySurvey({ tenantId: T1, employeeId: HIRE, type: "DAY_120", responses: { q: 1 } }))))
            .toMatchObject({ status: 400, code: "HR-ONBOARDING-VALIDATION" });
    });

    it("another hire's issued survey is not the caller's", async () => {
        // OTHER's DAY_30 is issued; BUDDY has no checklist at all.
        expect(await failure(asUser(() => svc.submitMySurvey({ tenantId: T1, employeeId: BUDDY, type: "DAY_30", responses: { q: 1 } }), { employeeId: BUDDY })))
            .toMatchObject({ status: 404, code: "HR-ONBOARDING-SURVEY-NOT-ISSUED" });
    });
});

describe("HR review and the pending list", () => {
    async function pendingUpload() {
        await asUser(() => svc.uploadMyDocument({ tenantId: T1, employeeId: HIRE, title: "Passport", fileName: "p.pdf", mimeType: "application/pdf", contentBase64: PDF_B64 }));
        return fake.current.all("onboardingDocument").find((d) => d.mediaId === 777).id;
    }

    it("lists the pending uploads with the employee's name", async () => {
        const id = await pendingUpload();
        const out = await asUser(() => svc.listPendingOnboardingDocuments({ tenantId: T1 }), { employeeId: HR });
        expect(out.total).toBe(1);
        expect(out.items).toEqual([expect.objectContaining({ id, employeeId: HIRE, employeeName: "Ayesha Khan", title: "Passport", reviewStatus: "PENDING" })]);
        const none = await asUser(() => svc.listPendingOnboardingDocuments({ tenantId: T2 }), { tenantId: T2, employeeId: 201 });
        expect(none.total).toBe(0);
    });

    it("verifies once, with an event to the employee", async () => {
        const id = await pendingUpload();
        const out = await asUser(() => svc.reviewOnboardingDocument({ tenantId: T1, reviewerId: HR, documentId: id, decision: "VERIFIED", now: NOW }), { employeeId: HR });
        expect(out.document).toMatchObject({ reviewStatus: "VERIFIED", reviewedById: HR });
        const event = fake.current.events().at(-1);
        expect(event.eventName).toBe("hr.onboarding.document_reviewed.v1");
        expect(event.payload.payload).toMatchObject({ documentId: String(id), employeeId: String(HIRE), reviewStatus: "VERIFIED", reviewedById: String(HR) });
        expect(await failure(asUser(() => svc.reviewOnboardingDocument({ tenantId: T1, reviewerId: HR, documentId: id, decision: "REJECTED", note: "x" }), { employeeId: HR })))
            .toMatchObject({ status: 409, code: "HR-ONBOARDING-DOCUMENT-ALREADY-REVIEWED" });
    });

    it("a rejection needs a note, which the new hire then sees", async () => {
        const id = await pendingUpload();
        expect(await failure(asUser(() => svc.reviewOnboardingDocument({ tenantId: T1, reviewerId: HR, documentId: id, decision: "REJECTED", note: "  " }), { employeeId: HR })))
            .toMatchObject({ status: 400, code: "HR-ONBOARDING-VALIDATION" });
        await asUser(() => svc.reviewOnboardingDocument({ tenantId: T1, reviewerId: HR, documentId: id, decision: "REJECTED", note: "Expired passport" }), { employeeId: HR });
        const portal = await asUser(() => svc.getMyOnboarding({ tenantId: T1, employeeId: HIRE }));
        expect(portal.documents.find((d) => d.id === id)).toMatchObject({ reviewStatus: "REJECTED", reviewNote: "Expired passport" });
        expect(JSON.stringify(fake.current.events().at(-1))).not.toMatch(/Expired passport/);
    });

    it("refuses an HR-supplied document, the reviewer's own upload and another tenant's document", async () => {
        expect(await failure(asUser(() => svc.reviewOnboardingDocument({ tenantId: T1, reviewerId: HR, documentId: ids.policy, decision: "VERIFIED" }), { employeeId: HR })))
            .toMatchObject({ status: 409, code: "HR-ONBOARDING-DOCUMENT-NOT-REVIEWABLE" });
        const id = await pendingUpload();
        expect(await failure(asUser(() => svc.reviewOnboardingDocument({ tenantId: T1, reviewerId: HIRE, documentId: id, decision: "VERIFIED" }))))
            .toMatchObject({ status: 403, code: "HR-ONBOARDING-REVIEW-OWN-DOCUMENT" });
        expect(await failure(asUser(() => svc.reviewOnboardingDocument({ tenantId: T2, reviewerId: 201, documentId: id, decision: "VERIFIED" }), { tenantId: T2, employeeId: 201 })))
            .toMatchObject({ status: 404 });
    });
});
