// Recruitment Phase 5 (plan 6.9) — the access export of a data-subject
// request: everything linked to the candidate, nobody else's data, no staff
// free-text notes, stored in DAM and stamped on the request.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createPrivacyFake } from "./helpers/privacy-operations.fake.js";

let db = createPrivacyFake();
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));
const uploadFileToDAM = jest.fn();
const deleteDamAsset = jest.fn(async () => ({ ok: true }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM, deleteDamAsset }));
const logAction = jest.fn(async () => undefined);
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));

const { generateDsrAccessExport } = await import("../../../src/services/dsr-export.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T08:00:00.000Z");
const ORG = resolveRecruitmentScope({ roles: ["HR_ADMIN"] });
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT } }, fn);
const SECRET = "INTERNAL-NOTE-SHOULD-NOT-LEAK";

function seed() {
    return {
        candidate: [
            { id: 5, tenantId: TENANT, firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com", phone: "+92300", notes: `${SECRET} candidate`, resumeMediaId: 501, consentStatus: "GRANTED", createdAt: NOW, updatedAt: NOW },
            { id: 6, tenantId: TENANT, firstName: "Bilal", lastName: "Other", email: "bilal@example.com", notes: "other person" },
            { id: 7, tenantId: OTHER, firstName: "Zara", email: "ayesha@example.com" },
        ],
        jobRequisition: [{ id: 30, tenantId: TENANT, title: "Backend Engineer" }],
        application: [
            { id: 100, tenantId: TENANT, candidateId: 5, jobRequisitionId: 30, stage: "interview", status: "open", appliedAt: NOW, updatedAt: NOW, holdReason: `${SECRET} hold` },
            { id: 101, tenantId: TENANT, candidateId: 6, jobRequisitionId: 30, stage: "applied", status: "open", appliedAt: NOW },
        ],
        applicationStageHistory: [
            { id: 1, tenantId: TENANT, applicationId: 100, fromStage: "applied", toStage: "interview", source: "application", reason: `${SECRET} move`, createdAt: NOW },
            { id: 2, tenantId: TENANT, applicationId: 101, fromStage: "applied", toStage: "screening", source: "application", createdAt: NOW },
        ],
        applicationQuestion: [{ id: 70, tenantId: TENANT, prompt: "Years of Node.js?" }],
        applicationAnswer: [
            { id: 1, applicationId: 100, questionId: 70, value: "6 years, my own words", score: 3, answeredAt: NOW },
            { id: 2, applicationId: 101, questionId: 70, value: "Bilal's answer", answeredAt: NOW },
        ],
        applicationScreening: [{ id: 1, tenantId: TENANT, applicationId: 100, outcome: "PASS", reasonCode: "FIT", reviewedById: 9, reviewedAt: NOW, notes: `${SECRET} screen`, criteria: { note: SECRET } }],
        applicationScore: [{ id: 1, tenantId: TENANT, applicationId: 100, score: 81, band: "STRONG", modelVersion: "fit-v1", components: { skills: 40 }, computedAt: NOW }],
        interview: [{ id: 200, tenantId: TENANT, applicationId: 100, interviewType: "TECHNICAL", scheduledAt: NOW, durationMinutes: 60, status: "COMPLETED", notes: `${SECRET} interview` }],
        interviewInterviewer: [{ interviewId: 200, employeeId: 9, tenantId: TENANT, panelRole: "LEAD", status: "completed" }],
        interviewScorecard: [{
            id: 1, tenantId: TENANT, interviewId: 200, reviewerId: 9, status: "SUBMITTED", overallScore: 4, recommendation: "HIRE", submittedAt: NOW, notes: `${SECRET} card`,
            criterionScores: { criteria: { problemSolving: { rating: 5, notAssessed: false, note: `${SECRET} evidence` } }, decision: "NEXT_ROUND" },
        }],
        employee: [{ id: 9, tenant_id: TENANT, first_name: "Sara", last_name: "Reviewer" }],
        offer: [{
            id: 300, tenantId: TENANT, applicationId: 100, candidateId: 5, salary: "200000", currency: "PKR", status: "SENT", notes: `${SECRET} offer`, offerLetterMediaId: 601, created_at: NOW,
        }],
        offerLetterVersion: [{ id: 1, tenantId: TENANT, offerId: 300, version: 1, mediaId: 602, signedMediaId: null, signatureStatus: "SENT", createdAt: NOW }],
        candidateCommunication: [{ id: 1, tenantId: TENANT, candidateId: 5, templateId: "hr.recruitment.application_received", channel: "email", category: "STATUS", status: "SENT", data: { statusPageUrl: "https://x/status?token=LIVE" }, createdAt: NOW }],
        candidateConsent: [{ id: 1, tenantId: TENANT, candidateId: 5, purpose: "PROCESSING", status: "GRANTED", occurredAt: NOW }],
        candidateDncEntry: [
            { id: 1, tenantId: TENANT, email: "ayesha@example.com", candidateId: null, reasonCode: "CANDIDATE_REQUEST", reason: `${SECRET} dnc`, scope: "ALL", status: "LIFTED", effectiveFrom: NOW },
            { id: 2, tenantId: TENANT, email: "bilal@example.com", candidateId: 6, reasonCode: "LEGAL", reason: "x", scope: "ALL", status: "ACTIVE", effectiveFrom: NOW },
        ],
        talentPool: [{ id: 1, tenantId: TENANT, candidateId: 5, poolName: "Backend", addedAt: NOW, notes: `${SECRET} pool` }],
        talentPoolInvitation: [{ id: 1, tenantId: TENANT, candidateId: 5, poolName: "Backend", status: "ACCEPTED", invitedAt: NOW, responseNote: "Happy to stay in touch" }],
        candidateSkill: [{ id: 1, tenantId: TENANT, candidateId: 5, name: "node.js", category: "skill" }],
        candidateLegalHold: [{ id: 1, tenantId: TENANT, candidateId: 5, reason: `${SECRET} hold` }],
        candidateDataAccessRequest: [
            { id: 900, tenantId: TENANT, candidateId: null, subjectEmail: "ayesha@example.com", type: "ACCESS", status: "RECEIVED", source: "PORTAL", verifiedAt: NOW, receivedAt: NOW },
        ],
    };
}

beforeEach(() => {
    db = createPrivacyFake(seed());
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_DSR_PORTAL = "true";
    uploadFileToDAM.mockResolvedValue([{ id: 777 }]);
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_DSR_PORTAL;
});

const uploadedDocument = () => JSON.parse(uploadFileToDAM.mock.calls[0][0].buffer.toString("utf8"));

describe("generateDsrAccessExport", () => {
    it("exports everything linked to the subject, stores it in DAM and stamps the request", async () => {
        const out = await asTenant(() => generateDsrAccessExport({ tenantId: TENANT, requestId: 900, actorId: 9, scope: ORG, now: NOW }));

        expect(out).toMatchObject({ requestId: 900, candidateId: 5, exportMediaId: 777, exportGeneratedAt: NOW });
        expect(uploadFileToDAM.mock.calls[0][0]).toMatchObject({ mimetype: "application/json" });
        expect(uploadFileToDAM.mock.calls[0][1]).toBe("document");

        const doc = uploadedDocument();
        expect(doc).toMatchObject({ format: "trusoft.hr.candidate-access-export", version: 1, requestId: 900 });
        expect(doc.profile).toMatchObject({ candidateId: 5, firstName: "Ayesha", email: "ayesha@example.com", phone: "+92300" });
        const [app] = doc.applications;
        expect(doc.applications).toHaveLength(1);
        expect(app).toMatchObject({ applicationId: 100, requisition: { title: "Backend Engineer" }, stage: "interview" });
        expect(app.stageHistory).toEqual([{ fromStage: "applied", toStage: "interview", source: "application", at: NOW.toISOString() }]);
        expect(app.answers).toEqual([{ question: "Years of Node.js?", value: "6 years, my own words", score: 3, answeredAt: NOW.toISOString() }]);
        expect(app.screenings[0]).toMatchObject({ outcome: "PASS", reasonCode: "FIT", reviewer: "Sara Reviewer" });
        expect(app.fitScore).toMatchObject({ score: 81, band: "STRONG" });
        expect(app.interviews[0].panel).toEqual([{ name: "Sara Reviewer", role: "LEAD", status: "completed" }]);
        expect(app.interviews[0].scorecards[0]).toMatchObject({
            reviewer: "Sara Reviewer", recommendation: "HIRE", decision: "NEXT_ROUND",
            criteria: { problemSolving: { rating: 5, notAssessed: false } },
        });
        expect(app.offer).toMatchObject({ status: "SENT", salary: "200000" });
        expect(doc.communications[0]).toMatchObject({ templateId: "hr.recruitment.application_received", status: "SENT" });
        expect(doc.consents).toHaveLength(1);
        expect(doc.doNotContact).toEqual([expect.objectContaining({ reasonCode: "CANDIDATE_REQUEST", status: "LIFTED" })]);
        expect(doc.invitations[0]).toMatchObject({ status: "ACCEPTED", responseNote: "Happy to stay in touch" });
        expect(doc.skills[0]).toMatchObject({ name: "node.js" });
        expect(doc.documents).toEqual(expect.arrayContaining([
            { kind: "RESUME", mediaId: 501 },
            { kind: "OFFER_LETTER", offerId: 300, mediaId: 601 },
            expect.objectContaining({ kind: "OFFER_LETTER_VERSION", mediaId: 602 }),
        ]));
        expect(doc.withheld).toEqual(expect.arrayContaining([
            { field: "candidate.notes", count: 1, reason: "STAFF_FREE_TEXT" },
            { field: "interview.notes", count: 1, reason: "STAFF_FREE_TEXT" },
            { field: "scorecard.notes", count: 1, reason: "STAFF_FREE_TEXT" },
            { field: "scorecard.criterionNotes", count: 1, reason: "STAFF_FREE_TEXT" },
            { field: "offer.notes", count: 1, reason: "STAFF_FREE_TEXT" },
            { field: "screening.notes", count: 1, reason: "STAFF_FREE_TEXT" },
        ]));

        const [request] = db.rows("candidateDataAccessRequest");
        expect(request).toMatchObject({ exportMediaId: 777, exportGeneratedAt: NOW, candidateId: 5, status: "IN_PROGRESS", handledById: 9 });
        const event = db.rows("outboxEvent").find((e) => e.eventName === "hr.recruitment.dsr_export_generated.v1");
        expect(event.payload.payload).toEqual({ requestId: "900", candidateId: "5", mediaId: "777" });
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, module: "Candidate Privacy" }));
    });

    it("never carries another person's data, an internal note, a legal hold or a live link", async () => {
        await asTenant(() => generateDsrAccessExport({ tenantId: TENANT, requestId: 900, scope: ORG, now: NOW }));
        const text = uploadFileToDAM.mock.calls[0][0].buffer.toString("utf8");

        for (const leak of [SECRET, "Bilal", "bilal@example.com", "Bilal's answer", "Zara", "token=LIVE", "LEGAL"]) {
            expect(text).not.toContain(leak);
        }
        expect(db.contextLog.every((e) => e.tenantId === TENANT && !e.system)).toBe(true);
    });

    it("replaces a previous export and deletes the old file from DAM", async () => {
        db.rows("candidateDataAccessRequest")[0].exportMediaId = 555;
        await asTenant(() => generateDsrAccessExport({ tenantId: TENANT, requestId: 900, scope: ORG, now: NOW }));
        expect(deleteDamAsset).toHaveBeenCalledWith(555);
        expect(db.rows("candidateDataAccessRequest")[0].exportMediaId).toBe(777);
    });

    it.each([
        ["an unverified portal request", { verifiedAt: null }, 404, "HR-RECRUITMENT-DAR-NOT-FOUND"],
        ["a non-ACCESS request", { type: "ERASURE" }, 409, "HR-RECRUITMENT-DSR-EXPORT-TYPE"],
        ["a closed request", { status: "FULFILLED" }, 409, "HR-RECRUITMENT-DAR-ALREADY-CLOSED"],
        ["an address with no candidate", { subjectEmail: "nobody@example.com" }, 409, "HR-RECRUITMENT-DSR-NO-CANDIDATE"],
        ["a linked candidate who is someone else", { candidateId: 6 }, 409, "HR-RECRUITMENT-DSR-SUBJECT-MISMATCH"],
    ])("refuses %s and uploads nothing", async (_label, over, status, code) => {
        Object.assign(db.rows("candidateDataAccessRequest")[0], over);
        await expect(asTenant(() => generateDsrAccessExport({ tenantId: TENANT, requestId: 900, scope: ORG, now: NOW })))
            .rejects.toMatchObject({ status, code });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("refuses a narrower scope, the flag off, and reports a DAM failure without stamping", async () => {
        const managed = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 9 });
        await expect(asTenant(() => generateDsrAccessExport({ tenantId: TENANT, requestId: 900, scope: managed })))
            .rejects.toMatchObject({ status: 403 });
        uploadFileToDAM.mockResolvedValue([]);
        await expect(asTenant(() => generateDsrAccessExport({ tenantId: TENANT, requestId: 900, scope: ORG, now: NOW })))
            .rejects.toMatchObject({ status: 502, code: "HR-RECRUITMENT-DSR-EXPORT-UPLOAD-FAILED" });
        expect(db.rows("candidateDataAccessRequest")[0].exportMediaId).toBeUndefined();
        process.env.HR_RECRUITMENT_DSR_PORTAL = "false";
        await expect(asTenant(() => generateDsrAccessExport({ tenantId: TENANT, requestId: 900, scope: ORG })))
            .rejects.toMatchObject({ status: 503 });
    });
});
