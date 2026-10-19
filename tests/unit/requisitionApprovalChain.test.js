// tests/unit/requisitionApprovalChain.test.js
//
// Phase 4 / decision record §2.5 — the requisition approval chain.
//
// The matrix is only worth configuring if it changes what happens, so the last
// three blocks drive the REAL approve entry points (the newer service and the
// legacy /api/hr one) rather than the pure helpers. The failure modes that get
// their own coverage, because each one is silent:
//
//   * a tenant with NO matrix must stay single-step (otherwise every existing
//     tenant's approvals silently become multi-step on upgrade), and
//   * a matrix with no RLS_MODELS entry reads back EMPTY, which makes every chain
//     vanish and every requisition approve in one step with no error anywhere.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CHAIN,
  assertChainCanComplete,
  assertNotRequester,
  assertStepDecidable,
  chainProgress,
  nextPendingStep,
  resolveApprovalChain,
  ruleApplies,
} from "../../src/lib/requisitionApprovalChain.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

const REQUISITION = {
  id: 5,
  title: "Backend Engineer",
  departmentId: 3,
  requestedById: 7,
  budgetedAmount: 250000,
  hiringReason: "NEW_HIRE",
  status: "PENDING_APPROVAL",
  // The Phase 2.2 mandatory fields, so a SUBMIT test reaches the chain guard
  // instead of stopping at the field gate for an unrelated reason.
  location: "Karachi",
  employmentType: "FULL_TIME",
  openings: 1,
  costCenterRef: "CC-100",
};

const rule = (over = {}) => ({
  stepOrder: 1,
  role: "HR_HEAD",
  approverId: null,
  minAmount: null,
  departmentId: null,
  hiringReason: null,
  requiresDistinctApprover: true,
  isActive: true,
  ...over,
});

describe("Phase 4 — which steps apply to a requisition", () => {
  it("treats an unconditional rule as applying, and an inactive one as not", () => {
    expect(ruleApplies(rule(), REQUISITION)).toBe(true);
    expect(ruleApplies(rule({ isActive: false }), REQUISITION)).toBe(false);
  });

  it("orders the chain by stepOrder, not by the order rows came back in", () => {
    const chain = resolveApprovalChain(REQUISITION, [
      rule({ stepOrder: 3, role: "FINANCE" }),
      rule({ stepOrder: 1, role: "HIRING_MANAGER" }),
      rule({ stepOrder: 2, role: "HR_HEAD" }),
    ]);
    expect(chain.map((s) => s.role)).toEqual(["HIRING_MANAGER", "HR_HEAD", "FINANCE"]);
  });

  it("scopes a step by department and by hiring reason", () => {
    expect(ruleApplies(rule({ departmentId: 3 }), REQUISITION)).toBe(true);
    expect(ruleApplies(rule({ departmentId: 4 }), REQUISITION)).toBe(false);
    expect(ruleApplies(rule({ hiringReason: "NEW_HIRE" }), REQUISITION)).toBe(true);
    expect(ruleApplies(rule({ hiringReason: "REPLACEMENT" }), REQUISITION)).toBe(false);
  });

  it("skips a threshold step only when the amount is KNOWN and BELOW it", () => {
    // REQUISITION.budgetedAmount is 250000.
    expect(ruleApplies(rule({ minAmount: 100000 }), REQUISITION)).toBe(true); // above it
    expect(ruleApplies(rule({ minAmount: 250000 }), REQUISITION)).toBe(true); // AT the threshold counts
    expect(ruleApplies(rule({ minAmount: 500000 }), REQUISITION)).toBe(false); // below it
  });

  it("satisfies any threshold step when the amount is UNKNOWN", () => {
    // The conservative direction: a missing budget figure must escalate to
    // Finance, not read as "below threshold" and skip it.
    const noAmount = { ...REQUISITION, budgetedAmount: null };
    expect(ruleApplies(rule({ minAmount: 10_000_000 }), noAmount)).toBe(true);
    expect(ruleApplies(rule({ minAmount: 10_000_000 }), { ...noAmount, budgetedAmount: undefined })).toBe(true);
  });
});

describe("Phase 4 — chain progress", () => {
  const chain = [
    { stepOrder: 1, role: "HIRING_MANAGER", approverId: null, requiresDistinctApprover: true },
    { stepOrder: 2, role: "HR_HEAD", approverId: null, requiresDistinctApprover: true },
    { stepOrder: 3, role: "FINANCE", approverId: null, requiresDistinctApprover: true },
  ];

  it("reports the first unsatisfied step as next", () => {
    expect(nextPendingStep(chain, []).stepOrder).toBe(1);
    expect(nextPendingStep(chain, [{ status: "APPROVED", stepOrder: 1 }]).stepOrder).toBe(2);
    expect(nextPendingStep(chain, [{ status: "APPROVED", stepOrder: 1 }, { status: "APPROVED", stepOrder: 2 }]).stepOrder).toBe(3);
  });

  it("is only complete once the LAST step is satisfied", () => {
    const partial = chainProgress(chain, [{ status: "APPROVED", stepOrder: 1 }]);
    expect(partial.complete).toBe(false);
    expect(partial.nextStep.role).toBe("HR_HEAD");

    // Out-of-order decisions still count by step, not by arrival.
    const done = chainProgress(chain, [
      { status: "APPROVED", stepOrder: 3 },
      { status: "APPROVED", stepOrder: 1 },
      { status: "APPROVED", stepOrder: 2 },
    ]);
    expect(done.complete).toBe(true);
    expect(done.nextStep).toBeNull();
  });

  it("reports an unconfigured tenant as unconfigured, not as complete", () => {
    // `configured: false` is what tells a caller this is one un-stepped decision.
    expect(chainProgress([], []).configured).toBe(false);
    expect(chainProgress([], []).complete).toBe(false);
  });
});

describe("Phase 4 — the distinct-approver rule", () => {
  it("NEVER lets the requester decide their own requisition", () => {
    // Unconditional, so it also covers a tenant with no matrix at all — which is
    // where the original gap was.
    expect(() => assertNotRequester(REQUISITION, 7)).toThrow(/cannot approve it/i);
    expect(() => assertNotRequester(REQUISITION, 8)).not.toThrow();
  });

  it("carries a code a caller can act on", () => {
    let caught;
    try {
      assertNotRequester(REQUISITION, 7);
    } catch (error) {
      caught = error;
    }
    expect(caught.code).toBe("HR-RECRUITMENT-CHAIN-SELF_APPROVAL");
    expect(caught.status).toBe(403);
  });

  it("pins a step with a named approver to that person", () => {
    const step = { stepOrder: 1, role: "HR_HEAD", approverId: 4, requiresDistinctApprover: true };
    expect(() => assertStepDecidable({ step, decisions: [], actorId: 4 })).not.toThrow();
    expect(() => assertStepDecidable({ step, decisions: [], actorId: 5 })).toThrow(/assigned to a different approver/i);
  });

  it("refuses one employee satisfying two steps of the same chain", () => {
    // Otherwise a single person holding HR_HEAD and FINANCE collapses a
    // three-step chain into one signature, and every step still looks satisfied.
    const decisions = [{ status: "APPROVED", stepOrder: 1, approverId: 9 }];
    const step = { stepOrder: 2, role: "HR_HEAD", approverId: null, requiresDistinctApprover: true };
    expect(() => assertStepDecidable({ step, decisions, actorId: 9 })).toThrow(/already decided an earlier step/i);
    expect(() => assertStepDecidable({ step, decisions, actorId: 10 })).not.toThrow();
  });

  it("allows the same employee to RE-decide their own step when the flag is off", () => {
    const decisions = [{ status: "APPROVED", stepOrder: 1, approverId: 9 }];
    const step = { stepOrder: 1, role: "HR_HEAD", approverId: null, requiresDistinctApprover: false };
    expect(() => assertStepDecidable({ step, decisions, actorId: 9 })).not.toThrow();
  });

  it("refuses a chain that could never be completed, at submit time", () => {
    // A step pinned to the requisition's own requester while requiring an
    // independent approver. Left alone this fails much later, at approval, when
    // the requisition is already submitted and nobody can decide it.
    const chain = [{ stepOrder: 1, role: "HR_HEAD", approverId: 7, requiresDistinctApprover: true }];
    expect(() => assertChainCanComplete(chain, REQUISITION)).toThrow(/could never be decided/i);
    // A requester who is NOT the pinned approver is fine.
    expect(() =>
      assertChainCanComplete([{ stepOrder: 1, role: "HR_HEAD", approverId: 8, requiresDistinctApprover: true }], REQUISITION),
    ).not.toThrow();
    // And so is the requester pinned WITHOUT the distinct requirement.
    expect(() =>
      assertChainCanComplete([{ stepOrder: 1, role: "HR_HEAD", approverId: 7, requiresDistinctApprover: false }], REQUISITION),
    ).not.toThrow();
  });
});

describe("Phase 4 — the recommended chain is data, not a code path", () => {
  it("is an ordered Hiring Manager → HR Head → Finance chain", () => {
    expect(DEFAULT_CHAIN.map((s) => s.role)).toEqual(["HIRING_MANAGER", "HR_HEAD", "FINANCE"]);
    expect(DEFAULT_CHAIN.map((s) => s.stepOrder)).toEqual([1, 2, 3]);
  });

  it("makes only the Finance step conditional", () => {
    // The first two always apply; Finance is gated on the configured amount rule.
    expect(DEFAULT_CHAIN[0].minAmount).toBeUndefined();
    expect(DEFAULT_CHAIN[1].minAmount).toBeUndefined();
    expect(DEFAULT_CHAIN[2].minAmount).toBe(0);
    // It is a stored configuration, so mutating the exported object must not be
    // possible — a frozen default cannot be edited in place by a caller.
    expect(Object.isFrozen(DEFAULT_CHAIN)).toBe(true);
  });
});

// ── The chain at the real entry points ─────────────────────────────────────
let RULES = [];
let DECISIONS = [];
let REQUISITION_ROW = null;

const prisma = {
  requisitionApprovalRule: {
    findMany: jest.fn(async () => RULES),
    create: jest.fn(async ({ data }) => {
      const row = { id: RULES.length + 1, ...data };
      return row;
    }),
    updateMany: jest.fn(async () => ({ count: RULES.length })),
  },
  requisitionApproval: {
    findMany: jest.fn(async () => DECISIONS),
    create: jest.fn(async ({ data }) => {
      DECISIONS.push(data);
      return { id: DECISIONS.length, ...data };
    }),
  },
  jobRequisition: {
    findFirst: jest.fn(async () => REQUISITION_ROW),
    update: jest.fn(async ({ data }) => ({ ...REQUISITION_ROW, ...data })),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  requisitionTransition: { create: jest.fn(async ({ data }) => ({ id: 1, ...data })) },
  jobPosting: { create: jest.fn(async () => ({ id: 1 })) },
  businessUnit: { findMany: jest.fn(async () => []) },
  recruitmentHiringFreeze: { findFirst: jest.fn(async () => null) },
  $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  $executeRaw: jest.fn(async () => 1),
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  getDepartmentById: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
  createRbacSystemAccount: jest.fn(async () => ({ ok: false })),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((client, fn) => fn(client)),
  rlsTenantExtension: jest.fn((client) => client),
}));

const { approveRequisition } = await import("../../src/services/requisition.service.js");
const { submitRequisition } = await import("../../src/services/requisitionMgmt.service.js");
const { approveRequisition: legacyApprove } = await import("../../src/services/hrContract.service.js");
const { setApprovalRules, seedDefaultChain, chainFor } = await import(
  "../../src/services/requisitionApprovalChain.service.js"
);

const chainRules = [
  { stepOrder: 1, role: "HIRING_MANAGER" },
  { stepOrder: 2, role: "HR_HEAD" },
  { stepOrder: 3, role: "FINANCE" },
];

// Every jobRequisition.update call that actually MOVED the status, as opposed to
// the chain-snapshot write. A test that asserts "no update at all" cannot tell a
// correct partial approval from a missing snapshot.
const statusMoves = () =>
  prisma.jobRequisition.update.mock.calls
    .map((call) => call[0].data)
    .filter((data) => Object.prototype.hasOwnProperty.call(data, "status"))
    .map((data) => data.status);

beforeEach(() => {
  jest.clearAllMocks();
  RULES = [];
  DECISIONS = [];
  REQUISITION_ROW = { ...REQUISITION };
});

describe("Phase 4 — an unconfigured tenant keeps today's single-step approval", () => {
  it("approves in ONE decision when no matrix is configured", async () => {
    await approveRequisition(5, "APPROVED", undefined, 8, TENANT);

    expect(prisma.jobRequisition.update).toHaveBeenCalled();
    expect(prisma.jobRequisition.update.mock.calls[0][0].data.status).toBe("APPROVED");
    // Recorded as an un-stepped decision, which is exactly what it is.
    expect(DECISIONS[0].stepOrder).toBeNull();
  });

  it("still refuses self-approval with no matrix configured", async () => {
    // The gap the decision called out: this used to be allowed.
    await expect(approveRequisition(5, "APPROVED", undefined, 7, TENANT)).rejects.toThrow(
      /cannot approve it/i,
    );
    expect(DECISIONS).toHaveLength(0);
  });
});

describe("Phase 4 — a configured chain needs every step, in order", () => {
  beforeEach(() => {
    RULES = chainRules;
  });

  it("does NOT approve on the first of three steps, and reports what is next", async () => {
    const result = await approveRequisition(5, "APPROVED", "ok", 8, TENANT);

    expect(result.approvalDecision).toBe("STEP_RECORDED");
    expect(result.status).toBe("PENDING_APPROVAL");
    expect(result.approvalProgress.nextStep.role).toBe("HR_HEAD");
    // The status was NOT moved. (The one update that DID happen is the chain
    // snapshot, which carries no `status` — asserting on the absence of `update`
    // altogether would have hidden whether the snapshot was taken.)
    expect(statusMoves()).toEqual([]);
    const sources = prisma.requisitionTransition.create.mock.calls.map((c) => c[0].data.source);
    expect(sources).toEqual(["requisition.approval_step"]);
  });

  it("approves only when the LAST step is satisfied", async () => {
    await approveRequisition(5, "APPROVED", undefined, 8, TENANT); // step 1
    await approveRequisition(5, "APPROVED", undefined, 9, TENANT); // step 2
    expect(statusMoves()).toEqual([]);

    const final = await approveRequisition(5, "APPROVED", undefined, 10, TENANT); // step 3
    expect(statusMoves()).toEqual(["APPROVED"]);
    expect(final.status).toBe("APPROVED");
  });

  it("refuses one employee deciding two steps of the chain", async () => {
    await approveRequisition(5, "APPROVED", undefined, 8, TENANT);
    await expect(approveRequisition(5, "APPROVED", undefined, 8, TENANT)).rejects.toThrow(
      /already decided an earlier step/i,
    );
    // Only the first decision was recorded.
    expect(DECISIONS).toHaveLength(1);
  });

  it("records each decision against its own step and role", async () => {
    await approveRequisition(5, "APPROVED", undefined, 8, TENANT);
    await approveRequisition(5, "APPROVED", undefined, 9, TENANT);
    expect(DECISIONS.map((d) => [d.stepOrder, d.role])).toEqual([
      [1, "HIRING_MANAGER"],
      [2, "HR_HEAD"],
    ]);
  });

  it("freezes the chain at the first decision, so a later edit cannot move the goalposts", async () => {
    await approveRequisition(5, "APPROVED", undefined, 8, TENANT);
    const snapshotCall = prisma.jobRequisition.update.mock.calls.find(
      (call) => call[0].data.approvalChainSnapshot,
    );
    expect(snapshotCall[0].data.approvalChainSnapshot).toHaveLength(3);

    // Now the tenant deletes a step. The in-flight requisition must NOT notice.
    RULES = [{ stepOrder: 1, role: "HR_HEAD" }];
    const frozen = await chainFor({ ...REQUISITION_ROW, approvalChainSnapshot: snapshotCall[0].data.approvalChainSnapshot }, { tenantId: TENANT });
    expect(frozen).toHaveLength(3);
  });

  it("records a REJECTION at the step it stopped, and ends the chain", async () => {
    await approveRequisition(5, "APPROVED", undefined, 8, TENANT); // step 1 done
    await approveRequisition(5, "REJECTED", "no budget", 9, TENANT);

    expect(DECISIONS[1].status).toBe("REJECTED");
    expect(DECISIONS[1].stepOrder).toBe(2);
    expect(statusMoves()).toEqual(["REJECTED"]);
  });

  it("applies the SAME chain through the legacy /api/hr surface", async () => {
    // Otherwise the number of required signatures would depend on which URL the
    // client happened to call.
    const result = await legacyApprove(5, TENANT, 8, "ok");
    expect(result.approvalDecision).toBe("STEP_RECORDED");
    expect(DECISIONS[0].stepOrder).toBe(1);
    expect(statusMoves()).toEqual([]);
  });
});

describe("Phase 4 — configuring the matrix", () => {
  it("rejects two steps sharing one order, naming the order", async () => {
    await expect(
      setApprovalRules(TENANT, [{ stepOrder: 1, role: "HR_HEAD" }, { stepOrder: 1, role: "FINANCE" }]),
    ).rejects.toThrow(/share step order 1/);
  });

  it("rejects an unknown role and a negative threshold", async () => {
    await expect(setApprovalRules(TENANT, [{ stepOrder: 1, role: "CEO" }])).rejects.toThrow(/role must be one of/);
    await expect(setApprovalRules(TENANT, [{ stepOrder: 1, role: "FINANCE", minAmount: -1 }])).rejects.toThrow(
      /zero or more/,
    );
  });

  it("refuses to SUBMIT a requisition whose chain could never be completed", async () => {
    // The requisition's own requester is pinned as the only approver of a step
    // that requires an independent approver. Discovered here — while the fix is
    // still cheap — instead of at approval, when the requisition is already
    // submitted and nobody can decide it.
    RULES = [{ stepOrder: 1, role: "HR_HEAD", approverId: REQUISITION.requestedById }];
    REQUISITION_ROW = { ...REQUISITION, status: "DRAFT" };

    await expect(submitRequisition(5, TENANT, 7)).rejects.toThrow(/could never be decided/i);
    expect(statusMoves()).toEqual([]);
  });

  it("seeds the recommended chain", async () => {
    await seedDefaultChain(TENANT);
    const created = prisma.requisitionApprovalRule.create.mock.calls.map((c) => c[0].data);
    expect(created.map((r) => r.role)).toEqual(["HIRING_MANAGER", "HR_HEAD", "FINANCE"]);
    expect(created[2].minAmount).toBe(0);
  });
});

describe("Phase 4 — the matrix cannot silently stop working", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  it("registers the model for the RLS tenant GUC", () => {
    // Same FORCE-RLS trap as the freeze, with a worse consequence: an empty-read
    // matrix silently collapses every chain to one step with no error anywhere.
    const rls = readFileSync(path.join(root, "src/lib/rlsTenant.js"), "utf8");
    expect(rls).toContain("'RequisitionApprovalRule'");
  });

  it("ships its policy in the same migration that creates the table", () => {
    const sql = readFileSync(
      path.join(root, "prisma/migrations/20261021001100_recruitment_approval_chain/migration.sql"),
      "utf8",
    );
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY tenant_isolation");
    // The two ACTIVE rules on one step must be impossible at the database too.
    expect(sql).toContain("requisition_approval_rules_active_step_key");
  });

  it("resolves the matrix routes to their OWN permission, not the general one", () => {
    const middleware = readFileSync(path.join(root, "src/middlewares/routeAuthorization.middleware.js"), "utf8");
    const matrixAt = middleware.indexOf('"/api/recruitment/approval-matrix"');
    const generalAt = middleware.indexOf('["/api/recruitment", "hr.recruitment"]');
    expect(matrixAt).toBeGreaterThan(-1);
    expect(generalAt).toBeGreaterThan(-1);
    expect(matrixAt).toBeLessThan(generalAt);
    expect(middleware).toContain('"hr.recruitment.approval.matrix"');
  });
});
