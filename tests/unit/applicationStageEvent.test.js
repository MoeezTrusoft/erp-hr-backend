// tests/unit/applicationStageEvent.test.js
//
// Phase 11 — the stage-change event must be enqueued on the SAME client as the
// state change, and the REST/MCP path (which supplies no client of its own) must
// run the whole transition in one tenant transaction. Otherwise a failure could
// record a stage move with no history row, or announce a move that rolled back.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const logAction = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: { marker: "root" } }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));

// The wrapper must open a tenant transaction when the caller supplies no client.
const tx = {
  application: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  applicationStageHistory: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  interview: { findFirst: jest.fn().mockResolvedValue(null) },
  offer: { findFirst: jest.fn().mockResolvedValue(null) },
  outboxEvent: { create: jest.fn().mockResolvedValue({ id: 99 }) },
};
const tenantTransaction = jest.fn((_client, fn) => fn(tx));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction,
  rlsTenantExtension: jest.fn((client) => client),
}));

const { transitionApplicationStage } = await import("../../src/services/applicationWorkflow.service.js");

// The event contract validates tenantId as a UUID, and Application.tenantId is a
// UUID column — so the tenant must be a real UUID here. A non-UUID tenant makes
// the envelope fail and the transition roll back (see the negative test below).
const TENANT = "44444444-4444-4444-8444-444444444444";
const APPLICATION = { id: 7, tenantId: TENANT, stage: "applied", offer: null };

beforeEach(() => {
  jest.clearAllMocks();
  tx.application.findFirst.mockResolvedValue({ ...APPLICATION });
  tx.application.update.mockResolvedValue({ ...APPLICATION, stage: "screening", status: "active" });
});

describe("application stage-change event", () => {
  it("runs the whole transition in ONE tenant transaction when no client is supplied", async () => {
    const result = await transitionApplicationStage({
      id: 7,
      tenantId: TENANT,
      targetStage: "screening",
      actorId: 12,
    });

    expect(tenantTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, changed: true });
  });

  it("does NOT open a transaction when the caller composes one", async () => {
    const callerTx = {
      application: { findFirst: jest.fn().mockResolvedValue({ ...APPLICATION }), update: jest.fn().mockResolvedValue({ ...APPLICATION, stage: "screening" }) },
      applicationStageHistory: { create: jest.fn() },
      interview: { findFirst: jest.fn() },
      offer: { findFirst: jest.fn().mockResolvedValue(null) },
      outboxEvent: { create: jest.fn() },
    };

    await transitionApplicationStage({ id: 7, tenantId: TENANT, targetStage: "screening", db: callerTx });

    // The caller owns the transaction boundary; nesting another would deadlock.
    expect(tenantTransaction).not.toHaveBeenCalled();
    expect(callerTx.applicationStageHistory.create).toHaveBeenCalled();
  });

  it("announces the change on the same client as the state write", async () => {
    await transitionApplicationStage({
      id: 7,
      tenantId: TENANT,
      targetStage: "rejected",
      reason: "Not a fit",
      actorId: 12,
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    const written = tx.outboxEvent.create.mock.calls[0][0].data;
    expect(written.eventName).toBe("hr.recruitment.application_stage_changed.v1");
    expect(written.tenantId).toBe(TENANT);
    // The payload must show the move and its enforced reason, not just the target.
    expect(written.payload.payload).toMatchObject({
      fromStage: "applied",
      toStage: "rejected",
      reason: "Not a fit",
    });
  });

  it("does not emit when the transition is a no-op", async () => {
    tx.application.findFirst.mockResolvedValue({ ...APPLICATION, stage: "screening" });

    const result = await transitionApplicationStage({
      id: 7,
      tenantId: TENANT,
      targetStage: "screening",
    });

    expect(result).toMatchObject({ changed: false });
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("takes the event tenant from the ROW, not from the request argument", async () => {
    // The stored tenant is the authoritative one (Application.tenantId is a UUID
    // column). Deriving the envelope tenant from the row means a request can never
    // make an event appear to belong to another tenant.
    await transitionApplicationStage({
      id: 7,
      tenantId: "tenant-a",
      targetStage: "screening",
      actorId: 12,
    });

    const written = tx.outboxEvent.create.mock.calls[0][0].data;
    expect(written.tenantId).toBe(TENANT);
    expect(JSON.stringify(written)).not.toContain("tenant-a");
  });

  it("fails the write rather than emitting an unreadable event", async () => {
    // Contract validation runs BEFORE the row is written, so a malformed envelope
    // aborts the transition instead of publishing something consumers cannot parse.
    tx.application.update.mockResolvedValue({ ...APPLICATION, tenantId: "not-a-uuid", stage: "screening" });

    await expect(transitionApplicationStage({
      id: 7,
      tenantId: TENANT,
      targetStage: "screening",
      actorId: 12,
    })).rejects.toThrow(/Invalid UUID/);
  });
});
