// tests/unit/services/recruitment-write-events.test.js
//
// F-37 (realtime) — every recruitment WRITE the frontend performs enqueues its
// outbox domain event INSIDE the transaction it writes in, so the gateway SSE
// stream can refresh other recruiters' screens.
//
// The seam: `tenantTransaction` hands the callback a DISTINCT `tx` client and
// flags the window it is open. A write is "in the transaction" when it lands on
// `tx` (never the root client), and the event is "in the same transaction" when
// enqueueHrDomainEvent receives that `tx` while the window is open, after the
// write. The mocked enqueue mirrors the real fail-closed rule: an argument with
// no tenant enqueues nothing.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";

const makeClient = () => ({
    interview: { findFirst: jest.fn(), update: jest.fn() },
    interviewScorecard: { count: jest.fn() },
    offer: { create: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    candidate: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    jobRequisition: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    businessUnit: { findMany: jest.fn(async () => []) },
    talentPool: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), delete: jest.fn() },
    talentPoolInvitation: { findFirst: jest.fn(), create: jest.fn() },
    $executeRaw: jest.fn(async () => 1),
});

const prisma = makeClient();
const tx = makeClient();
let txOpen = false;
const enqueued = [];

const tenantTransaction = jest.fn(async (_client, fn) => {
    txOpen = true;
    try {
        return await fn(tx);
    } finally {
        txOpen = false;
    }
});
const enqueueHrDomainEvent = jest.fn(async (client, args) => {
    if (!args?.tenantId) return null; // fail-closed, as the real writer
    enqueued.push({ client, args, txOpen, order: enqueueHrDomainEvent.mock.invocationCallOrder.at(-1) });
    return { id: enqueued.length };
});
const upsertInterviewScorecard = jest.fn(async () => ({ id: 1 }));

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({
    tenantTransaction,
    isTenantTransaction: () => txOpen,
    rlsTenantExtension: (client) => client,
}));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/interview-scorecard.service.js", () => ({
    upsertInterviewScorecard,
    default: upsertInterviewScorecard,
}));
jest.unstable_mockModule("../../../src/services/applicationWorkflow.service.js", () => ({
    transitionApplicationStageInTransaction: jest.fn(async () => ({ success: true })),
    transitionApplicationStage: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({
    assertCommunicationsAllowed: jest.fn(async () => undefined),
    computeRetentionUntil: jest.fn(async () => null),
}));
jest.unstable_mockModule("../../../src/services/approval/adapters.js", () => ({ consumeApproval: jest.fn() }));
jest.unstable_mockModule("../../../src/services/approval/legacy.js", () => ({
    legacyDecision: jest.fn(),
    legacySubmit: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({
    uploadFileToDAM: jest.fn(),
    deleteDamAsset: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/recruitmentHandoff.service.js", () => ({
    getOfferHandoff: jest.fn(),
    runOfferHandoff: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/requisitionWorkflow.service.js", () => ({
    assertRequisitionTransition: jest.fn((_from, to) => String(to).toUpperCase()),
    assertRequisitionAdvanceAllowed: jest.fn(async () => undefined),
    recordRequisitionTransition: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../../src/services/rbac.client.js", () => ({
    getDepartmentById: jest.fn(async () => null),
    listDepartments: jest.fn(async () => []),
}));
jest.unstable_mockModule("../../../src/services/requisitionApprovalChain.service.js", () => ({
    emitRequisitionSubmittedEvent: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../../src/services/requisitionPublication.service.js", () => ({
    publishRequisition: jest.fn(),
    closeActivePostingsForRequisition: jest.fn(async () => 0),
}));
jest.unstable_mockModule("../../../src/services/financeValidity.service.js", () => ({
    assertFinanceValidityAtSubmit: jest.fn(async () => null),
}));
jest.unstable_mockModule("../../../src/services/applicationService.js", () => ({ createApplication: jest.fn() }));

const interviewSvc = await import("../../../src/services/interview.service.js");
const offerSvc = await import("../../../src/services/offer.service.js");
const requisitionSvc = await import("../../../src/services/requisition.service.js");
const requisitionMgmt = await import("../../../src/services/requisitionMgmt.service.js");
const talentPool = await import("../../../src/services/talentPool.service.js");
const talentPoolMgmt = await import("../../../src/services/talentPoolMgmt.service.js");

// Ids-only: every payload value is an id string, a status/enum fact, a number,
// a boolean, an ISO instant, null, or a list of those. No names / emails /
// salary / free text can hide in a payload that passes this.
const ID_ONLY_KEYS = /(Id|Ids|At|status|Status|decision|outcome|version|reused|overridden|changedFields|reason|reasonCode|surveyType|completed)$/;
const expectIdsOnly = (payload) => {
    for (const [key, value] of Object.entries(payload)) {
        expect(key).toMatch(ID_ONLY_KEYS);
        if (Array.isArray(value)) value.forEach((v) => expect(typeof v).toBe("string"));
        else if (value !== null) expect(["string", "number", "boolean"]).toContain(typeof value);
    }
};

const onlyEvent = (name) => {
    expect(enqueued).toHaveLength(1);
    const [e] = enqueued;
    expect(e.args.eventName).toBe(name);
    expect(e.client).toBe(tx); // the SAME transaction client the write used
    expect(e.txOpen).toBe(true); // …while that transaction was open
    expect(e.args.tenantId).toBe(TENANT);
    expectIdsOnly(e.args.payload);
    return e;
};

const before = (writeMock, event) => {
    // the write happened, on tx, before the event was enqueued
    expect(writeMock).toHaveBeenCalled();
    expect(writeMock.mock.invocationCallOrder[0]).toBeLessThan(event.order);
};

beforeEach(() => {
    jest.clearAllMocks();
    enqueued.length = 0;
    txOpen = false;
});

// ── hr_interview_update ──────────────────────────────────────────────────────

describe("hr_interview_update → updateInterview", () => {
    const row = (over = {}) => ({
        id: 40,
        applicationId: 9,
        status: "SCHEDULED",
        scheduledAt: new Date("2026-11-01T09:00:00Z"),
        decision: null,
        tenantId: TENANT,
        application: { candidateId: 5 },
        interviewers: [{ employeeId: 3 }, { employeeId: 4 }],
        ...over,
    });
    const arrange = (pre = row(), after = {}) => {
        prisma.interview.findFirst.mockResolvedValue(pre);
        tx.interview.findFirst.mockResolvedValue(pre);
        tx.interview.update.mockImplementation(async ({ data }) => ({ ...pre, ...data, ...after }));
    };

    it("CANCELLED → interview_cancelled.v1 in the update's transaction", async () => {
        arrange();
        await interviewSvc.updateInterview(40, { status: "CANCELLED" }, TENANT, { actorId: 12 });
        const e = onlyEvent("hr.recruitment.interview_cancelled.v1");
        before(tx.interview.update, e);
        expect(prisma.interview.update).not.toHaveBeenCalled();
        expect(e.args.actorId).toBe(12);
        expect(e.args.payload).toMatchObject({ interviewId: "40", applicationId: "9", candidateId: "5", interviewerIds: ["3", "4"] });
    });

    it("a moved scheduledAt → interview_rescheduled.v1 with the previous instant", async () => {
        arrange();
        await interviewSvc.updateInterview(40, { scheduledAt: "2026-11-02T10:00:00Z" }, TENANT);
        const e = onlyEvent("hr.recruitment.interview_rescheduled.v1");
        expect(e.args.payload).toMatchObject({
            previousScheduledAt: "2026-11-01T09:00:00.000Z",
            newScheduledAt: "2026-11-02T10:00:00.000Z",
        });
    });

    it("a decision is written to the Interview.decision COLUMN (notes kept) and emits interview_outcome_recorded.v1", async () => {
        arrange();
        tx.interviewScorecard.count.mockResolvedValue(1);
        await interviewSvc.updateInterview(40, { decision: "next_round" }, TENANT);
        const data = tx.interview.update.mock.calls[0][0].data;
        expect(data.decision).toBe("NEXT_ROUND");
        expect(data.notes).toBe("Decision: next_round");
        const e = onlyEvent("hr.recruitment.interview_outcome_recorded.v1");
        expect(e.args.payload).toMatchObject({ outcome: "NEXT_ROUND", overridden: false });
    });

    it("status COMPLETED → interview_outcome_recorded.v1", async () => {
        arrange();
        await interviewSvc.updateInterview(40, { status: "COMPLETED" }, TENANT);
        onlyEvent("hr.recruitment.interview_outcome_recorded.v1");
    });

    it("a decisive decision without a submitted scorecard is refused before any write (same gate as setInterviewOutcome)", async () => {
        arrange();
        tx.interviewScorecard.count.mockResolvedValue(0);
        await expect(interviewSvc.updateInterview(40, { decision: "NEXT_ROUND" }, TENANT)).rejects.toMatchObject({
            status: 409,
            code: "HR-RECRUITMENT-INTERVIEW-FEEDBACK-REQUIRED",
        });
        expect(tx.interview.update).not.toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);
    });

    it("an override reason passes the gate and marks the outcome overridden", async () => {
        arrange();
        tx.interviewScorecard.count.mockResolvedValue(0);
        await interviewSvc.updateInterview(40, { decision: "REJECTED", overrideReason: "panel unavailable" }, TENANT);
        const data = tx.interview.update.mock.calls[0][0].data;
        expect(data).not.toHaveProperty("overrideReason");
        expect(data.notes).toContain("Overridden without scorecard: panel unavailable");
        const e = onlyEvent("hr.recruitment.interview_outcome_recorded.v1");
        expect(e.args.payload.overridden).toBe(true);
    });

    it("the screen's option labels record the decision codes, the note keeps the label", async () => {
        expect(interviewSvc.normalizeUpdateDecision("Move to next round")).toBe("NEXT_ROUND");
        expect(interviewSvc.normalizeUpdateDecision("Hold")).toBe("HOLD");
        expect(interviewSvc.normalizeUpdateDecision("Rejected")).toBe("REJECTED");
        expect(interviewSvc.normalizeUpdateDecision(" next_round ")).toBe("NEXT_ROUND");
        expect(interviewSvc.normalizeUpdateDecision("")).toBeNull();

        arrange();
        await interviewSvc.updateInterview(40, { decision: "Hold" }, TENANT);
        const data = tx.interview.update.mock.calls[0][0].data;
        expect(data.decision).toBe("HOLD");
        expect(data.notes).toContain("Decision: Hold");
    });

    it("an unknown decision value is refused with 409", async () => {
        arrange();
        await expect(interviewSvc.updateInterview(40, { decision: "MAYBE" }, TENANT)).rejects.toMatchObject({
            status: 409,
            code: "HR-RECRUITMENT-INTERVIEW-DECISION-INVALID",
        });
        expect(tenantTransaction).not.toHaveBeenCalled();
    });

    it("any other edit → interview_updated.v1 naming the changed columns, never their values", async () => {
        arrange();
        await interviewSvc.updateInterview(40, { location: "Room 4", notes: "bring laptop" }, TENANT);
        const e = onlyEvent("hr.recruitment.interview_updated.v1");
        expect(e.args.payload.changedFields).toEqual(["location", "notes"]);
        expect(JSON.stringify(e.args.payload)).not.toContain("bring laptop");
    });

    it("feedback-only writes the scorecard after the interview transaction and announces it", async () => {
        arrange();
        await interviewSvc.updateInterview(40, { feedback: { ratings: { technical: 4 } }, reviewerId: 3 }, TENANT);
        const e = onlyEvent("hr.recruitment.interview_updated.v1");
        expect(e.args.payload.changedFields).toEqual(["scorecard"]);
        expect(upsertInterviewScorecard.mock.invocationCallOrder[0]).toBeGreaterThan(e.order);
    });

    it("feedback WITH a decision is written first, so the decision is judged on it", async () => {
        arrange();
        tx.interviewScorecard.count.mockResolvedValue(1);
        await interviewSvc.updateInterview(40, { feedback: { ratings: { technical: 4 } }, decision: "NEXT_ROUND", reviewerId: 3 }, TENANT);
        expect(upsertInterviewScorecard.mock.invocationCallOrder[0]).toBeLessThan(tx.interviewScorecard.count.mock.invocationCallOrder[0]);
        onlyEvent("hr.recruitment.interview_outcome_recorded.v1");
    });

    it("a tenantless interview row enqueues nothing", async () => {
        arrange(row({ tenantId: null }), { tenantId: null });
        await interviewSvc.updateInterview(40, { status: "CANCELLED" }, TENANT);
        expect(tx.interview.update).toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);
    });
});

// ── hr_offer_create / hr_offer_update ────────────────────────────────────────

describe("hr_offer_create → createOffer", () => {
    it("enqueues offer_created.v1 in the create's transaction, without the salary", async () => {
        tx.candidate.findFirst.mockResolvedValue({ id: 5 });
        tx.jobRequisition.findFirst.mockResolvedValue({ id: 21 });
        tx.offer.create.mockResolvedValue({ id: 70, applicationId: 9, candidateId: 5, jobRequisitionId: 21, status: "DRAFT", version: 0, salary: "987654", tenantId: TENANT, createdById: 12 });
        await offerSvc.createOffer({ applicationId: 9, candidateId: 5, jobRequisitionId: 21, salary: 987654, createdById: 12, tenantId: TENANT });
        const e = onlyEvent("hr.recruitment.offer_created.v1");
        before(tx.offer.create, e);
        expect(e.args.payload).toEqual({ offerId: "70", applicationId: "9", candidateId: "5", jobRequisitionId: "21", status: "DRAFT", version: 0, createdById: "12" });
        expect(JSON.stringify(e.args)).not.toContain("987654");
    });
});

describe("hr_offer_update → updateOffer", () => {
    const offer = (over = {}) => ({ id: 70, applicationId: 9, candidateId: 5, jobRequisitionId: 21, status: "DRAFT", version: 2, salary: "987654", tenantId: TENANT, createdById: 12, ...over });

    it("pre-read, compare-and-set and offer_updated.v1 share one transaction", async () => {
        tx.offer.findFirst.mockResolvedValueOnce(offer()).mockResolvedValueOnce(offer({ version: 3 }));
        tx.offer.updateMany.mockResolvedValue({ count: 1 });
        await offerSvc.updateOffer(70, { notes: "x", salary: 1000, expectedVersion: 2 }, TENANT);
        expect(prisma.offer.findFirst).not.toHaveBeenCalled();
        expect(prisma.offer.updateMany).not.toHaveBeenCalled();
        const e = onlyEvent("hr.recruitment.offer_updated.v1");
        before(tx.offer.updateMany, e);
        expect(e.args.payload).toEqual({ offerId: "70", applicationId: "9", candidateId: "5", jobRequisitionId: "21", status: "DRAFT", version: 3 });
        expect(JSON.stringify(e.args)).not.toMatch(/987654|salary/);
    });

    it("moving to WITHDRAWN emits offer_withdrawn.v1 instead", async () => {
        tx.offer.findFirst.mockResolvedValueOnce(offer({ status: "SENT" })).mockResolvedValueOnce(offer({ status: "WITHDRAWN", version: 3 }));
        tx.offer.updateMany.mockResolvedValue({ count: 1 });
        await offerSvc.updateOffer(70, { status: "WITHDRAWN" }, TENANT);
        const e = onlyEvent("hr.recruitment.offer_withdrawn.v1");
        expect(e.args.payload).toMatchObject({ status: "WITHDRAWN", previousStatus: "SENT", createdById: "12" });
    });

    it("a stale version writes nothing and enqueues nothing", async () => {
        tx.offer.findFirst.mockResolvedValueOnce(offer()).mockResolvedValueOnce({ version: 9 });
        tx.offer.updateMany.mockResolvedValue({ count: 0 });
        await expect(offerSvc.updateOffer(70, { notes: "x", expectedVersion: 2 }, TENANT)).rejects.toMatchObject({ status: 412 });
        expect(enqueued).toHaveLength(0);
    });

    it("a tenantless offer row enqueues nothing", async () => {
        tx.offer.findFirst.mockResolvedValue(offer({ tenantId: null }));
        tx.offer.updateMany.mockResolvedValue({ count: 1 });
        await offerSvc.updateOffer(70, { notes: "x" }, TENANT);
        expect(enqueued).toHaveLength(0);
    });
});

// ── hr_requisition_create / _close / _update → CLOSED ─────────────────────────

describe("requisitions", () => {
    it("hr_requisition_create → requisition_created.v1 in the create's transaction", async () => {
        tx.jobRequisition.create.mockResolvedValue({ id: 21, status: "DRAFT", departmentId: 4, positionId: null, requestedById: 12, title: "Backend Engineer", tenantId: TENANT });
        await requisitionSvc.createRequisition({ title: "Backend Engineer", departmentId: 4 }, 12, TENANT);
        const e = onlyEvent("hr.recruitment.requisition_created.v1");
        before(tx.jobRequisition.create, e);
        expect(e.args.payload).toEqual({ requisitionId: "21", status: "DRAFT", departmentId: "4", positionId: null, requestedById: "12" });
    });

    it("hr_requisition_close → stamps closedAt and emits requisition_closed.v1 in the close's transaction", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ id: 21, status: "POSTED", requestedById: 12, departmentId: null, tenantId: TENANT });
        tx.jobRequisition.update.mockImplementation(async ({ data }) => ({ id: 21, requestedById: 12, tenantId: TENANT, ...data }));
        await requisitionMgmt.closeRequisition(21, TENANT, 12, "filled internally");
        const data = tx.jobRequisition.update.mock.calls[0][0].data;
        expect(data.status).toBe("CLOSED");
        expect(data.closedAt).toBeInstanceOf(Date);
        const e = onlyEvent("hr.recruitment.requisition_closed.v1");
        before(tx.jobRequisition.update, e);
        expect(e.args.payload).toEqual({ requisitionId: "21", status: "CLOSED", reason: "filled internally", requestedById: "12" });
    });

    it("hr_requisition_update moving to CLOSED → closedAt + requisition_closed.v1 in the update's transaction", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ id: 21, status: "POSTED", requestedById: 12, tenantId: TENANT });
        tx.jobRequisition.updateMany.mockResolvedValue({ count: 1 });
        await requisitionSvc.updateRequisition(21, { status: "CLOSED", comments: "budget cut" }, 12, TENANT);
        expect(tx.jobRequisition.updateMany.mock.calls[0][0].data.closedAt).toBeInstanceOf(Date);
        const e = onlyEvent("hr.recruitment.requisition_closed.v1");
        before(tx.jobRequisition.updateMany, e);
        expect(e.args.payload).toMatchObject({ requisitionId: "21", status: "CLOSED", reason: "budget cut" });
    });

    it("a non-close update emits no closed event", async () => {
        prisma.jobRequisition.findFirst.mockResolvedValue({ id: 21, status: "DRAFT", requestedById: 12, tenantId: TENANT });
        tx.jobRequisition.updateMany.mockResolvedValue({ count: 1 });
        await requisitionSvc.updateRequisition(21, { title: "Renamed" }, 12, TENANT);
        expect(enqueued).toHaveLength(0);
    });
});

// ── talent pool ──────────────────────────────────────────────────────────────

describe("talent pool", () => {
    it("hr_talent_pool_add → talent_pool_added.v1 in the create's transaction", async () => {
        tx.talentPool.create.mockResolvedValue({ id: 8, candidateId: 5, poolName: "Future roles", addedById: 12, tenantId: TENANT });
        await talentPool.addToPool({ candidateId: 5, poolName: "Future roles", addedById: 12, tenantId: TENANT });
        expect(prisma.talentPool.create).not.toHaveBeenCalled();
        const e = onlyEvent("hr.recruitment.talent_pool_added.v1");
        before(tx.talentPool.create, e);
        expect(e.args.payload).toEqual({ talentPoolEntryId: "8", candidateId: "5", addedById: "12" });
    });

    it("hr_talent_pool_remove → pre-read, delete and talent_pool_removed.v1 in one transaction", async () => {
        tx.talentPool.findFirst.mockResolvedValue({ id: 8, candidateId: 5, tenantId: TENANT });
        tx.talentPool.delete.mockResolvedValue({ id: 8, candidateId: 5, tenantId: TENANT });
        await talentPool.removeFromPool(8, TENANT);
        expect(prisma.talentPool.delete).not.toHaveBeenCalled();
        const e = onlyEvent("hr.recruitment.talent_pool_removed.v1");
        before(tx.talentPool.delete, e);
    });

    it("a tenantless pool entry enqueues nothing", async () => {
        tx.talentPool.findFirst.mockResolvedValue({ id: 8, candidateId: 5, tenantId: null });
        tx.talentPool.delete.mockResolvedValue({ id: 8, candidateId: 5, tenantId: null });
        await talentPool.removeFromPool(8, TENANT);
        expect(enqueued).toHaveLength(0);
    });

    it("hr_talent_pool_invite → invitation row, note stamps and talent_pool_invitation_sent.v1 in one transaction", async () => {
        tx.candidate.findFirst.mockResolvedValue({ id: 5, notes: null, anonymizedAt: null, tenantId: TENANT });
        tx.talentPoolInvitation.findFirst.mockResolvedValue(null);
        tx.talentPoolInvitation.create.mockImplementation(async ({ data }) => ({ id: 31, ...data }));
        tx.talentPool.findMany.mockResolvedValue([{ id: 8, notes: "" }]);
        tx.talentPool.update.mockResolvedValue({ id: 8 });
        const result = await talentPoolMgmt.inviteCandidate({ candidateId: 5, tenantId: TENANT, addedById: 12 });
        expect(result).toMatchObject({ invited: true, updatedMemberships: 1, invitationReused: false });
        expect(prisma.talentPoolInvitation.create).not.toHaveBeenCalled();
        expect(prisma.talentPool.update).not.toHaveBeenCalled();
        const e = onlyEvent("hr.recruitment.talent_pool_invitation_sent.v1");
        before(tx.talentPoolInvitation.create, e);
        before(tx.talentPool.update, e);
        expect(e.args.payload).toMatchObject({ invitationId: "31", candidateId: "5", jobRequisitionId: null, status: "INVITED", invitedById: "12", reused: false });
    });
});
