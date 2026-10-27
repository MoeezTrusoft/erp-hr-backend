// tests/unit/recruitment-intake-portal.test.js
//
// Recruitment Phase 2 — the public intake paths:
//
//   * KNOCKOUT at submit: answers are checked against the question's rule, the
//     outcome is stored on the application and the answers, and with the
//     `knockout` flag on exactly one PENDING disposition is scheduled in the
//     intake transaction (none with the flag off);
//   * D-11 DNC: an address on the register gets the byte-identical success body,
//     nothing is created, no email is sent, and the log carries a hash, never
//     the address — on apply, draft save and the status-link request;
//   * D-16: a duplicate with an invalid form is refused like a new one, and a
//     lost unique race answers like a success;
//   * SOURCE capture (channel vocabulary, posting must be this requisition's
//     active posting, detail trimmed and capped) and the draft's resume carried
//     through submit into the candidate and the parse queue;
//   * the public job detail lists the form but never the knockout fields.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");

const flags = { portal: true, knockout: false };
const state = {};

const requisitionRow = () => ({
    id: 5,
    tenantId: TENANT,
    title: "Backend Engineer",
    status: "POSTED",
    openings: 1,
    closesAt: null,
    postings: [{ id: 88, channel: "LINKEDIN", isActive: true, closedAt: null }],
});

const knockoutQuestion = {
    id: 1,
    requisitionId: 5,
    tenantId: TENANT,
    type: "BOOLEAN",
    prompt: "Do you hold a work permit?",
    required: true,
    knockout: true,
    knockoutRule: { values: [false] },
    weights: { true: 3, false: 0 },
    maxScore: 3,
    options: null,
    isActive: true,
};
const scoredQuestion = {
    id: 2,
    requisitionId: 5,
    tenantId: TENANT,
    type: "SINGLE_CHOICE",
    prompt: "Years of Node?",
    required: false,
    knockout: false,
    knockoutRule: null,
    options: [{ value: "1", label: "1" }, { value: "5", label: "5+" }],
    weights: { 1: 1, 5: 4 },
    maxScore: 5,
    isActive: true,
};

const prisma = {
    jobRequisition: { findFirst: jest.fn(async () => state.requisition) },
    applicationQuestion: { findMany: jest.fn(async () => state.questions) },
    candidateDncEntry: { findFirst: jest.fn(async () => state.dnc) },
    candidate: {
        findFirst: jest.fn(async () => state.candidate),
        create: jest.fn(async ({ data }) => ({ id: 70, ...data })),
        update: jest.fn(async ({ data }) => ({ id: state.candidate?.id, ...data })),
    },
    application: {
        findFirst: jest.fn(async () => state.duplicate),
        create: jest.fn(async ({ data }) => {
            if (state.raceLost) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
            return { id: 900, ...data };
        }),
    },
    applicationAnswer: { createMany: jest.fn(async ({ data }) => ({ count: data.length })) },
    applicationStageHistory: { create: jest.fn(async () => ({ id: 1 })) },
    candidateConsent: { create: jest.fn(async () => ({ id: 1 })) },
    candidateEmailVerification: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    },
    dispositionReasonCode: {
        findFirst: jest.fn(async () => null),
        createMany: jest.fn(async ({ data }) => ({ count: data.length })),
    },
    scheduledDisposition: { upsert: jest.fn(async ({ create }) => ({ id: 44, ...create })) },
    applicationDraft: {
        upsert: jest.fn(async ({ create }) => ({ id: 3, ...create })),
        findUnique: jest.fn(async () => state.draftRow),
        update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (fn) => fn(prisma)),
};

const sendCandidateEmail = jest.fn(async () => ({ sent: true }));
const enqueueCandidateResumeParse = jest.fn(async () => ({ queued: true }));
const getRecruitmentSettings = jest.fn(async () => ({ knockoutDelayHours: 36 }));
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
loggerMock.child = () => loggerMock;

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: loggerMock }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn(async (client, fn) => fn(client)),
    rlsTenantExtension: jest.fn((client) => client),
}));
jest.unstable_mockModule("../../src/lib/notificationClient.js", () => ({ sendCandidateEmail }));
jest.unstable_mockModule("../../src/lib/recruitment-flags.util.js", () => ({
    isRecruitmentFlagEnabled: jest.fn((key) => flags[key] === true),
}));
jest.unstable_mockModule("../../src/services/recruitment-settings.service.js", () => ({
    getRecruitmentSettings,
    RECRUITMENT_SETTINGS_DEFAULTS: { knockoutDelayHours: 24 },
}));
jest.unstable_mockModule("../../src/services/resume-parse-queue.service.js", () => ({ enqueueCandidateResumeParse }));

const { submitPublicApplication, getPublicJob, parseSourceAttribution } = await import("../../src/services/public-portal.service.js");
const { saveApplicationDraft, submitApplicationDraft } = await import("../../src/services/application-draft.service.js");
const { requestStatusLink } = await import("../../src/services/candidate-status.service.js");

const body = (overrides = {}) => ({
    firstName: "Ayesha",
    lastName: "Malik",
    email: "ayesha@example.com",
    policyVersion: "privacy-2026-09",
    answers: { 1: true, 2: "5" },
    ...overrides,
});
const submit = (overrides = {}, extra = {}) =>
    submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: body(overrides), now: NOW, ...extra });

const DNC_ROW = { id: 9, email: "ayesha@example.com", reasonCode: "CANDIDATE_REQUEST", scope: "ALL", status: "ACTIVE" };

beforeEach(() => {
    jest.clearAllMocks();
    flags.portal = true;
    flags.knockout = false;
    Object.assign(state, {
        requisition: requisitionRow(),
        questions: [knockoutQuestion, scoredQuestion],
        dnc: null,
        candidate: null,
        duplicate: null,
        raceLost: false,
        draftRow: null,
    });
});

describe("knockout at submit", () => {
    it("stores the answer total, the ceiling and a knockout per answer and per application", async () => {
        await submit({ answers: { 1: false, 2: "5" } });

        const app = prisma.application.create.mock.calls[0][0].data;
        expect(app).toMatchObject({ answerScore: 4, answerMaxScore: 8, knockedOut: true });
        const answers = prisma.applicationAnswer.createMany.mock.calls[0][0].data;
        expect(answers).toEqual([
            { applicationId: 900, questionId: 1, value: false, score: 0, knockedOut: true },
            { applicationId: 900, questionId: 2, value: "5", score: 4 },
        ]);
    });

    it("flag OFF: records the knockout only — no disposition is scheduled", async () => {
        await submit({ answers: { 1: false } });
        expect(prisma.application.create.mock.calls[0][0].data.knockedOut).toBe(true);
        expect(prisma.scheduledDisposition.upsert).not.toHaveBeenCalled();
        expect(getRecruitmentSettings).not.toHaveBeenCalled();
    });

    it("flag ON: schedules exactly one PENDING disposition at now + knockoutDelayHours", async () => {
        flags.knockout = true;
        await submit({ answers: { 1: false } });

        expect(prisma.scheduledDisposition.upsert).toHaveBeenCalledTimes(1);
        const { where, create } = prisma.scheduledDisposition.upsert.mock.calls[0][0];
        expect(where).toEqual({ applicationId_source: { applicationId: 900, source: "KNOCKOUT" } });
        expect(create).toMatchObject({
            tenantId: TENANT,
            applicationId: 900,
            source: "KNOCKOUT",
            reasonCode: "MINIMUM_REQUIREMENTS_NOT_MET",
            status: "PENDING",
            detail: { questionIds: [1] },
        });
        expect(create.executeAt.toISOString()).toBe("2026-10-21T22:00:00.000Z"); // + 36h
        // A fresh tenant gets the default reason taxonomy, MINIMUM_REQUIREMENTS_NOT_MET included.
        const seeded = prisma.dispositionReasonCode.createMany.mock.calls[0][0].data.map((r) => r.code);
        expect(seeded).toContain("MINIMUM_REQUIREMENTS_NOT_MET");
        expect(seeded.length).toBeGreaterThan(1);
    });

    it("flag ON but nothing knocked out: no disposition", async () => {
        flags.knockout = true;
        await submit();
        expect(prisma.application.create.mock.calls[0][0].data.knockedOut).toBe(false);
        expect(prisma.scheduledDisposition.upsert).not.toHaveBeenCalled();
    });

    it("a duplicate application never schedules a second disposition", async () => {
        flags.knockout = true;
        state.candidate = { id: 41, firstName: "Ayesha", status: "active", anonymizedAt: null };
        state.duplicate = { id: 555 };
        await submit({ answers: { 1: false } });
        expect(prisma.application.create).not.toHaveBeenCalled();
        expect(prisma.scheduledDisposition.upsert).not.toHaveBeenCalled();
    });
});

describe("D-11 — do-not-contact at portal apply", () => {
    it("answers exactly like a success, creates nothing, sends nothing, logs only a hash", async () => {
        const allowed = await submit();
        jest.clearAllMocks();

        state.dnc = DNC_ROW;
        const blocked = await submit();

        expect(blocked).toEqual(allowed);
        expect(blocked).toEqual({ received: true, requisitionId: 5 });
        expect(prisma.candidate.create).not.toHaveBeenCalled();
        expect(prisma.candidate.update).not.toHaveBeenCalled();
        expect(prisma.application.create).not.toHaveBeenCalled();
        expect(prisma.candidateEmailVerification.create).not.toHaveBeenCalled();
        expect(sendCandidateEmail).not.toHaveBeenCalled();

        const line = loggerMock.info.mock.calls.find((c) => /do-not-contact/.test(c[1]));
        expect(line[0]).toMatchObject({ tenantId: TENANT, path: "portal.apply" });
        expect(line[0].emailHash).toMatch(/^[0-9a-f]{16}$/);
        expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain("ayesha@example.com");
    });

    it("probes the register with the normalized address in the tenant", async () => {
        await submit({ email: "  Ayesha@Example.COM " });
        expect(prisma.candidateDncEntry.findFirst.mock.calls[0][0].where).toMatchObject({
            tenantId: TENANT,
            email: "ayesha@example.com",
            status: "ACTIVE",
        });
    });

    it("a DNC entry scoped to a channel intake never uses does not block", async () => {
        state.dnc = { ...DNC_ROW, scope: "SMS" };
        await submit();
        expect(prisma.application.create).toHaveBeenCalled();
    });

    it("an invalid form is refused the same way whether or not the address is on the register", async () => {
        const bad = { answers: { 1: "maybe" } };
        const allowed = await submit(bad).catch((e) => e);
        state.dnc = DNC_ROW;
        const blocked = await submit(bad).catch((e) => e);
        expect(allowed).toMatchObject({ status: 400, code: "HR-PORTAL-ANSWERS-INVALID" });
        expect(blocked).toMatchObject({ status: allowed.status, code: allowed.code, message: allowed.message });
    });
});

describe("D-16 — duplicates are no oracle", () => {
    it("a duplicate with an invalid form is refused exactly like a new one", async () => {
        const fresh = await submit({ answers: {} }).catch((e) => e);
        state.candidate = { id: 41, firstName: "Ayesha", status: "active", anonymizedAt: null };
        state.duplicate = { id: 555 };
        const dupe = await submit({ answers: {} }).catch((e) => e);
        expect(fresh).toMatchObject({ status: 400, code: "HR-PORTAL-ANSWERS-INVALID" });
        expect(dupe).toMatchObject({ status: 400, code: "HR-PORTAL-ANSWERS-INVALID", message: fresh.message });
    });

    it("a concurrent duplicate that loses the unique race still answers received", async () => {
        state.raceLost = true;
        expect(await submit()).toEqual({ received: true, requisitionId: 5 });
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });
});

describe("source attribution", () => {
    it("defaults the portal channel to CAREER_SITE", async () => {
        await submit();
        expect(prisma.application.create.mock.calls[0][0].data).toMatchObject({
            sourceChannel: "CAREER_SITE",
            sourcePostingId: null,
            sourceDetail: null,
        });
    });

    it("keeps a known channel, this requisition's active posting and a trimmed detail", async () => {
        await submit({ sourceChannel: "linkedin", sourcePostingId: "88", sourceDetail: "  spring-campaign  " });
        expect(prisma.application.create.mock.calls[0][0].data).toMatchObject({
            sourceChannel: "LINKEDIN",
            sourcePostingId: 88,
            sourceDetail: "spring-campaign",
        });
    });

    it("maps an unknown channel to OTHER, drops a foreign posting and caps the detail at 200", () => {
        const postings = [{ id: 88, isActive: true }];
        expect(parseSourceAttribution({ sourceChannel: "TIKTOK", sourcePostingId: 99, sourceDetail: "x".repeat(300) }, { postings }))
            .toEqual({ sourceChannel: "OTHER", sourcePostingId: null, sourceDetail: "x".repeat(200) });
        expect(parseSourceAttribution({ sourcePostingId: "abc" }, { postings }).sourcePostingId).toBeNull();
        expect(parseSourceAttribution({ sourcePostingId: 88 }, { postings: [{ id: 88, isActive: false }] }).sourcePostingId).toBeNull();
    });
});

describe("resume carried through", () => {
    it("links a trusted resume to a new candidate and queues the parse after commit", async () => {
        await submit({}, { resumeMediaId: 321 });
        expect(prisma.candidate.create.mock.calls[0][0].data.resumeMediaId).toBe(321);
        expect(enqueueCandidateResumeParse).toHaveBeenCalledWith({ tenantId: TENANT, candidateId: 70, mediaId: 321, applicationId: 900 });
    });

    it("fills an existing candidate's empty resume slot but never replaces one", async () => {
        state.candidate = { id: 41, firstName: "A", resumeMediaId: null, status: "active", anonymizedAt: null };
        await submit({}, { resumeMediaId: 321 });
        expect(prisma.candidate.update.mock.calls[0][0].data.resumeMediaId).toBe(321);

        jest.clearAllMocks();
        state.candidate = { id: 41, firstName: "A", resumeMediaId: 7, status: "active", anonymizedAt: null };
        await submit({}, { resumeMediaId: 321 });
        expect(prisma.candidate.update.mock.calls[0][0].data).not.toHaveProperty("resumeMediaId");
    });

    it("ignores a media id in the anonymous body", async () => {
        await submit({ resumeMediaId: 999 });
        expect(prisma.candidate.create.mock.calls[0][0].data).not.toHaveProperty("resumeMediaId");
        expect(enqueueCandidateResumeParse).not.toHaveBeenCalled();
    });

    it("a parse-queue failure never fails the apply", async () => {
        enqueueCandidateResumeParse.mockResolvedValueOnce({ queued: false, reason: "QUEUE_WRITE_FAILED" });
        expect(await submit({}, { resumeMediaId: 321 })).toEqual({ received: true, requisitionId: 5 });
    });

    it("the draft submit carries source attribution but not the draft's untrusted resume id", async () => {
        state.draftRow = {
            id: 3,
            candidateId: 41,
            requisitionId: 5,
            resumeMediaId: 321,
            submittedAt: null,
            payload: { firstName: "Ayesha", answers: { 1: true }, sourceChannel: "INDEED", sourcePostingId: 88 },
            candidate: { id: 41, email: "ayesha@example.com", firstName: "Ayesha", anonymizedAt: null, status: "active" },
            requisition: { id: 5, tenantId: TENANT },
        };
        await submitApplicationDraft({ token: "tok" });
        // Draft save takes resumeMediaId from the anonymous body, so it is not
        // attached or parsed until a portal upload binds it to the draft.
        expect(prisma.candidate.create.mock.calls[0][0].data.resumeMediaId).toBeUndefined();
        expect(prisma.application.create.mock.calls[0][0].data).toMatchObject({ sourceChannel: "INDEED", sourcePostingId: 88 });
        expect(enqueueCandidateResumeParse).not.toHaveBeenCalled();
    });
});

describe("D-11 — draft save and status link", () => {
    it("draft save: a register hit writes nothing, sends nothing, and still reports saved", async () => {
        state.dnc = DNC_ROW;
        const result = await saveApplicationDraft({ tenantId: TENANT, requisitionId: 5, email: "ayesha@example.com", body: { firstName: "A" } });
        expect(result.saved).toBe(true);
        expect(prisma.candidate.create).not.toHaveBeenCalled();
        expect(prisma.applicationDraft.upsert).not.toHaveBeenCalled();
        expect(sendCandidateEmail).not.toHaveBeenCalled();
        expect(loggerMock.info.mock.calls.find((c) => /do-not-contact/.test(c[1]))[0]).toMatchObject({ path: "portal.draft_save" });
    });

    it("draft save: the source attribution is kept on the draft payload", async () => {
        await saveApplicationDraft({
            tenantId: TENANT,
            requisitionId: 5,
            email: "ayesha@example.com",
            body: { firstName: "A", sourceChannel: "referral", sourcePostingId: 88, sourceDetail: " ref " },
        });
        expect(prisma.applicationDraft.upsert.mock.calls[0][0].create.payload).toMatchObject({
            sourceChannel: "REFERRAL",
            sourcePostingId: 88,
            sourceDetail: "ref",
        });
    });

    it("status link: a register hit sends no link and answers the uniform body", async () => {
        state.candidate = { id: 41, firstName: "Ayesha", email: "ayesha@example.com" };
        state.dnc = DNC_ROW;
        expect(await requestStatusLink({ tenantId: TENANT, email: "ayesha@example.com" })).toEqual({ accepted: true });
        expect(prisma.candidateEmailVerification.create).not.toHaveBeenCalled();
        expect(sendCandidateEmail).not.toHaveBeenCalled();
    });

    it("status link: an allowed candidate still gets the link", async () => {
        state.candidate = { id: 41, firstName: "Ayesha", email: "ayesha@example.com" };
        expect(await requestStatusLink({ tenantId: TENANT, email: "ayesha@example.com" })).toEqual({ accepted: true });
        expect(sendCandidateEmail).toHaveBeenCalledTimes(1);
    });
});

describe("public job detail", () => {
    it("lists the application form without weights, scores or knockout fields", async () => {
        const db = {
            jobRequisition: {
                findFirst: jest.fn(async () => ({
                    id: 5,
                    title: "Backend Engineer",
                    status: "POSTED",
                    openings: 1,
                    jobContent: {},
                    postings: [{ channel: "CAREER_SITE", externalUrl: null, isActive: true }],
                })),
            },
            applicationQuestion: { findMany: jest.fn(async () => [knockoutQuestion, scoredQuestion]) },
        };
        const job = await getPublicJob({ tenantId: TENANT, prisma: db, id: 5, now: NOW });

        expect(db.applicationQuestion.findMany.mock.calls[0][0]).toMatchObject({
            where: { requisitionId: 5, tenantId: TENANT, isActive: true },
        });
        const select = db.applicationQuestion.findMany.mock.calls[0][0].select;
        for (const key of ["knockout", "knockoutRule", "weights", "maxScore"]) expect(select).not.toHaveProperty(key);
        expect(job.questions).toEqual([
            { id: 1, label: "Do you hold a work permit?", type: "BOOLEAN", required: true, options: null },
            { id: 2, label: "Years of Node?", type: "SINGLE_CHOICE", required: false, options: scoredQuestion.options },
        ]);
        expect(JSON.stringify(job)).not.toMatch(/knockout|weights|maxScore/);
    });

    it("an unavailable job is still null, without a question read", async () => {
        const db = { jobRequisition: { findFirst: jest.fn(async () => null) }, applicationQuestion: { findMany: jest.fn() } };
        expect(await getPublicJob({ tenantId: TENANT, prisma: db, id: 5, now: NOW })).toBeNull();
        expect(db.applicationQuestion.findMany).not.toHaveBeenCalled();
    });
});
