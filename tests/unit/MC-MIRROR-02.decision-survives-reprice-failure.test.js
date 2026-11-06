// MULTI-COMPANY-MIRROR-01 (2026-11-06) — the first company's decision must reach
// the same person's copy of the case in the other company even when the
// follow-through (re-pricing, re-evaluating that day) fails.
//
// Production, 2026-11-06: Afsha Khan's 5 Oct case was approved in HomeVision at
// 00:33Z; HomeNet's copy was still PENDING at 00:47Z and Management then rejected
// it there, because the sibling transaction had rolled the mirrored approval
// back with whatever threw inside it. The decision is the point; the re-price is
// the follow-through and now only leaves a MIRROR_REPRICE_FAILED trail.
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const writes = [];
const audits = [];

const fakeTx = {
  attendanceAnomaly: {
    updateMany: jest.fn(async (args) => {
      writes.push(["anomaly", args]);
      return { count: 1 };
    }),
  },
  hrApprovalRequest: {
    updateMany: jest.fn(async (args) => {
      writes.push(["approval", args]);
      return { count: 1 };
    }),
  },
  attendanceRuleAudit: {
    create: jest.fn(async (args) => {
      audits.push(["audit", args]);
      return { id: audits.length };
    }),
  },
};

const db = {
  attendanceAnomaly: {
    findFirst: jest.fn(async () => ({
      id: 2847,
      mirrorGroupId: "group-1",
      date: new Date("2026-10-05T00:00:00Z"),
    })),
    findMany: jest.fn(async () => [
      {
        id: 2972,
        tenantId: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
        employeeId: 559,
        factHash: "hash-1",
        date: new Date("2026-10-05T00:00:00Z"),
      },
    ]),
  },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/services/attendancePeriod.service.js", () => ({
  attendanceTransaction: async (_db, _tenantId, fn) => fn(fakeTx),
  assertAttendancePeriodOpen: async () => {},
  lockAttendancePeriod: async () => {},
}));
jest.unstable_mockModule("../../src/services/attendanceRulePayroll.service.js", () => ({
  reconcileRulePayroll: async () => {
    throw new Error("no published attendance setup for 2026-10-05");
  },
}));
jest.unstable_mockModule("../../src/services/attendanceWriter.service.js", () => ({
  applyEvaluatedShifts: async () => {},
}));

const { mirrorDecision } = await import("../../src/services/attendanceRequestMirror.service.js");

describe("mirrorDecision — the decision survives a failed re-evaluation", () => {
  beforeEach(() => {
    writes.length = 0;
    audits.length = 0;
  });

  it("still records the sibling's decision and its approval when re-pricing throws", async () => {
    const result = await mirrorDecision({
      tenantId: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
      anomalyId: 2847,
      decision: "APPROVED",
      comment: "Leave covers the day",
      deciderName: "MGMT-0001",
    });

    const anomalyWrite = writes.find(([kind]) => kind === "anomaly");
    expect(anomalyWrite?.[1]?.data?.status).toBe("APPROVED");
    const approvalWrite = writes.find(([kind]) => kind === "approval");
    expect(approvalWrite?.[1]?.data?.stage).toBe("APPROVED");
    expect(approvalWrite?.[1]?.where?.sourceRef).toBe("2972@hash-1");
    expect(result.applied).toEqual([
      {
        tenantId: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
        anomalyId: 2972,
        decidedAfterPayrollLock: false,
      },
    ]);
    const actions = audits.map(([, args]) => args.data.action);
    expect(actions).toContain("MIRRORED_APPROVED");
    expect(actions).toContain("MIRROR_REPRICE_FAILED");
  });
});
