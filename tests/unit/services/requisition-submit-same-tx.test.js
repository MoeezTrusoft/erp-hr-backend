// tests/unit/services/requisition-submit-same-tx.test.js
//
// Recruitment Phase 7 (D-RECHECK) — the HR Approval Centre's submit writes the
// requisition's PENDING_APPROVAL flip, its transition row and
// hr.recruitment.requisition_submitted.v1 on ONE transaction client, whichever
// surface submitted.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const enqueued = [];
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: jest.fn(async (tx, event) => {
        enqueued.push({ tx, event });
        return { id: "evt-1" };
    }),
}));

const { onSubmit } = await import("../../../src/services/approval/adapters.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const makeTx = () => ({
    jobRequisition: { update: jest.fn(async ({ data }) => ({ id: 5, ...data })) },
    requisitionTransition: { create: jest.fn(async ({ data }) => ({ id: 1, ...data })) },
    employee: { findFirst: jest.fn(async () => ({ managerId: 9 })) },
});
const source = {
    row: { id: 5, tenantId: TENANT, status: "DRAFT", title: "Backend Engineer", departmentId: 3, requestedById: 12 },
    definition: { model: "jobRequisition" },
    snapshot: {},
};
const env = { tenantId: TENANT, who: { id: 12 }, now: new Date() };

beforeEach(() => {
    enqueued.length = 0;
});

describe("requisition submit: one transaction", () => {
    it("flips the status, records the transition and enqueues the routed event on the same tx", async () => {
        const tx = makeTx();
        await onSubmit(tx, env, "REQUISITION", source, { reason: "Need a hire", transitionSource: "requisition.submit" });
        expect(tx.jobRequisition.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { status: "PENDING_APPROVAL" } });
        expect(tx.requisitionTransition.create.mock.calls[0][0].data).toMatchObject({
            requisitionId: 5, tenantId: TENANT, fromStatus: "DRAFT", toStatus: "PENDING_APPROVAL", reason: "Need a hire", actorId: 12, source: "requisition.submit",
        });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].tx).toBe(tx);
        expect(enqueued[0].event).toMatchObject({
            eventName: "hr.recruitment.requisition_submitted.v1",
            tenantId: TENANT,
            payload: { requisitionId: "5", status: "PENDING_APPROVAL", pendingApproverId: "9", pendingStepOrder: 1 },
        });
    });

    it("a direct hr_approval_submit (no recruitment meta) records source approval.submit", async () => {
        const tx = makeTx();
        await onSubmit(tx, env, "REQUISITION", source);
        expect(tx.requisitionTransition.create.mock.calls[0][0].data).toMatchObject({ source: "approval.submit", reason: null });
        expect(enqueued).toHaveLength(1);
    });

    it("other kinds write no recruitment rows", async () => {
        const tx = { ...makeTx(), claim: { update: jest.fn(async () => ({})) } };
        await onSubmit(tx, env, "CLAIM", { ...source, definition: { model: "claim" } });
        expect(tx.requisitionTransition.create).not.toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);
    });
});
