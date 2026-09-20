// tests/unit/recruitmentHiringFreeze.test.js
//
// Phase 4 / decision record §2.7 — hiring freezes.
//
// A freeze is only worth having if it actually stops the two things it claims to
// stop, so these tests drive the REAL submit and publish entry points rather than
// the helper alone. Two failure modes get their own coverage because both would
// be silent:
//
//   * a freeze that "reads back empty" (the FORCE-RLS trap — a model with a
//     policy and no RLS_MODELS entry makes every read return nothing, so the gate
//     stops gating while all its unit tests still pass), and
//   * a freeze created at the wrong scope, which either stops everything or
//     nothing.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

// The requisition every gate test submits: complete (Phase 2.2) so a refusal can
// only be the freeze, and in a business unit so a department freeze can match it.
const REQUISITION = {
  id: 5,
  title: "Backend Engineer",
  departmentId: 3,
  location: "Karachi",
  employmentType: "FULL_TIME",
  openings: 1,
  requestedById: 7,
  hiringReason: "NEW_HIRE",
  costCenterRef: "CC-100",
  status: "DRAFT",
};

// A tenant-scoped in-memory freeze table, so a foreign tenant's freeze cannot be
// seen (the tenant predicate the service builds is actually applied).
let FREEZES = [];

const prisma = {
  recruitmentHiringFreeze: {
    findFirst: jest.fn(async ({ where }) => {
      const rows = FREEZES.filter(
        (f) => where.tenantId === undefined || f.tenantId === where.tenantId,
      );
      if (where.isActive !== undefined && rows.every((f) => f.isActive !== where.isActive)) return null;
      const active = rows.filter((f) => (where.isActive === undefined ? true : f.isActive === where.isActive));
      const arms = where.OR;
      if (!arms) return active[0] || null;
      return (
        active.find((f) =>
          arms.some(
            (arm) =>
              f.scope === arm.scope &&
              (arm.departmentId === undefined || f.departmentId === arm.departmentId),
          ),
        ) || null
      );
    }),
    create: jest.fn(async ({ data }) => {
      const row = { id: FREEZES.length + 1, isActive: true, liftedAt: null, liftReason: null, ...data };
      FREEZES.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = FREEZES.find((f) => f.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    findMany: jest.fn(async ({ where }) =>
      FREEZES.filter((f) => (where.tenantId === undefined ? true : f.tenantId === where.tenantId)).filter((f) =>
        where.isActive === undefined ? true : f.isActive === where.isActive,
      ),
    ),
  },
  jobRequisition: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  jobPosting: { create: jest.fn() },
  requisitionApproval: { create: jest.fn(), findMany: jest.fn(async () => []) },
  requisitionApprovalRule: { findMany: jest.fn(async () => []) },
  requisitionTransition: { create: jest.fn() },
  businessUnit: { findMany: jest.fn() },
  $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  $executeRaw: jest.fn(async () => 1),
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
// The legacy hrContract surface drags in the system-account provisioning job, so
// the rbac client fake has to cover the whole surface it imports — a partial mock
// fails at link time before a single test runs.
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

const { submitRequisition } = await import("../../src/services/requisitionMgmt.service.js");
const { postRequisition, updateRequisition } = await import("../../src/services/requisition.service.js");
const { submitRequisition: legacySubmit } = await import("../../src/services/hrContract.service.js");
const { setHiringFreeze, liftHiringFreeze, listHiringFreezes, activeFreezeFor } = await import(
  "../../src/services/recruitmentFreeze.service.js"
);

beforeEach(() => {
  jest.clearAllMocks();
  FREEZES = [];
  prisma.requisitionTransition.create.mockResolvedValue({ id: 1 });
  prisma.jobPosting.create.mockResolvedValue({ id: 1 });
  prisma.businessUnit.findMany.mockResolvedValue([]);
  prisma.jobRequisition.findMany.mockResolvedValue([]);
  prisma.jobRequisition.updateMany.mockResolvedValue({ count: 1 });
  prisma.jobRequisition.update.mockResolvedValue({ id: 5, status: "POSTED" });
});

describe("Phase 4 — hiring freeze is set, lifted and reported", () => {
  it("records who set the freeze and why, and refuses a reasonless one", async () => {
    const freeze = await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4 budget review", createdById: 9 });
    expect(freeze).toMatchObject({ scope: "COMPANY", reason: "Q4 budget review", isActive: true, createdById: 9 });
    await expect(setHiringFreeze(TENANT, { scope: "COMPANY", reason: "  " })).rejects.toThrow(/reason is required/i);
  });

  it("refuses a business-unit freeze that names no business unit", async () => {
    // The dangerous mis-scope: naming no unit must NOT quietly mean "everything".
    await expect(setHiringFreeze(TENANT, { scope: "BUSINESS_UNIT", reason: "x" })).rejects.toThrow(
      /must name the business unit/i,
    );
    await expect(setHiringFreeze(TENANT, { scope: "REGION", reason: "x" })).rejects.toThrow(/scope must be one of/);
  });

  it("is idempotent, so one decision does not become two active rows", async () => {
    const first = await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    const second = await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4 again" });
    expect(second.id).toBe(first.id);
    expect(FREEZES.filter((f) => f.isActive)).toHaveLength(1);
  });

  it("lifts with a reason and keeps the record rather than deleting it", async () => {
    const freeze = await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    const lifted = await liftHiringFreeze(TENANT, freeze.id, { reason: "budget approved", liftedById: 4 });

    expect(lifted.isActive).toBe(false);
    expect(lifted.liftReason).toBe("budget approved");
    expect(lifted.liftedAt).toBeInstanceOf(Date);
    expect(FREEZES).toHaveLength(1); // never deleted
    await expect(liftHiringFreeze(TENANT, freeze.id, { reason: "again" })).rejects.toThrow(/already lifted/i);
  });

  it("requires a reason to lift", async () => {
    const freeze = await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    await expect(liftHiringFreeze(TENANT, freeze.id, { reason: "" })).rejects.toThrow(/reason is required/i);
  });

  it("cannot see or lift another tenant's freeze", async () => {
    await setHiringFreeze(OTHER_TENANT, { scope: "COMPANY", reason: "their freeze" });
    await expect(liftHiringFreeze(TENANT, 1, { reason: "ours now" })).rejects.toThrow(/not found/i);
    expect(await listHiringFreezes(TENANT)).toHaveLength(0);
  });

  it("hides lifted freezes from the default list but keeps them available", async () => {
    const freeze = await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    await liftHiringFreeze(TENANT, freeze.id, { reason: "done" });
    expect(await listHiringFreezes(TENANT)).toHaveLength(0);
    expect(await listHiringFreezes(TENANT, { includeInactive: true })).toHaveLength(1);
  });
});

describe("Phase 4 — which requisition a freeze actually covers", () => {
  it("a company-wide freeze covers every requisition, including a department-less one", async () => {
    await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    expect(await activeFreezeFor(TENANT, 3)).toBeTruthy();
    expect(await activeFreezeFor(TENANT, null)).toBeTruthy();
  });

  it("a business-unit freeze covers only that unit's requisitions", async () => {
    await setHiringFreeze(TENANT, { scope: "BUSINESS_UNIT", departmentId: 3, reason: "unit freeze" });
    expect(await activeFreezeFor(TENANT, 3)).toBeTruthy();
    expect(await activeFreezeFor(TENANT, 4)).toBeNull();
    // A requisition with no business unit is NOT matched by a unit freeze — the
    // conservative reading, because the alternative is guessing which unit it
    // belongs to.
    expect(await activeFreezeFor(TENANT, null)).toBeNull();
  });

  it("ignores a lifted freeze", async () => {
    const freeze = await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    await liftHiringFreeze(TENANT, freeze.id, { reason: "done" });
    expect(await activeFreezeFor(TENANT, 3)).toBeNull();
  });
});

describe("Phase 4 — the freeze blocks submission and publication, and nothing else", () => {
  it("refuses to SUBMIT a frozen requisition, with the freeze's reason in the error", async () => {
    await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4 budget review" });
    prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQUISITION });

    let caught;
    try {
      await submitRequisition(5, TENANT, 9);
    } catch (error) {
      caught = error;
    }
    expect(caught.code).toBe("HR-RECRUITMENT-HIRING-FREEZE");
    expect(caught.status).toBe(409);
    expect(caught.message).toMatch(/Q4 budget review/);
    expect(caught.details.action).toBe("submission");
    // A refused submit leaves no status flip and no history row.
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
  });

  it("refuses to PUBLISH an approved requisition while frozen", async () => {
    await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQUISITION, status: "APPROVED" });

    let caught;
    try {
      await postRequisition(5, "https://jobs.example.com/5", 9, TENANT);
    } catch (error) {
      caught = error;
    }
    expect(caught.code).toBe("HR-RECRUITMENT-HIRING-FREEZE");
    expect(caught.details.action).toBe("publication");
    expect(prisma.jobPosting.create).not.toHaveBeenCalled();
  });

  it("does NOT block drafting — a frozen tenant can still prepare requisitions", async () => {
    await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    prisma.jobRequisition.findFirst
      .mockResolvedValueOnce({ ...REQUISITION, departmentId: 3 }) // pre-read
      .mockResolvedValueOnce({ ...REQUISITION }); // post-update read

    await updateRequisition(5, { location: "Lahore" }, 9, TENANT);
    expect(prisma.jobRequisition.updateMany).toHaveBeenCalled();
  });

  it("blocks an advance made through the generic update", async () => {
    await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQUISITION });

    await expect(updateRequisition(5, { status: "PENDING_APPROVAL" }, 9, TENANT)).rejects.toThrow(/hiring freeze/i);
    expect(prisma.jobRequisition.updateMany).not.toHaveBeenCalled();
  });

  it("blocks submission through the legacy /api/hr endpoint too", async () => {
    // Otherwise the freeze would be bypassable by calling the older URL.
    await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQUISITION });

    await expect(legacySubmit(5, TENANT, 9, "please review")).rejects.toThrow(/hiring freeze/i);
  });

  it("lets a non-frozen department submit while a different unit is frozen", async () => {
    await setHiringFreeze(TENANT, { scope: "BUSINESS_UNIT", departmentId: 99, reason: "other unit" });
    prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQUISITION });

    await submitRequisition(5, TENANT, 9);
    expect(prisma.jobRequisition.update).toHaveBeenCalled();
  });

  it("lets a frozen tenant close a requisition — a freeze is not a lock", async () => {
    await setHiringFreeze(TENANT, { scope: "COMPANY", reason: "Q4" });
    prisma.jobRequisition.findFirst.mockResolvedValue({ ...REQUISITION, status: "POSTED" });
    prisma.jobRequisition.update.mockResolvedValue({ id: 5, status: "CLOSED" });

    const { closeRequisition } = await import("../../src/services/requisitionMgmt.service.js");
    await closeRequisition(5, TENANT, 9, "no longer needed");
    expect(prisma.requisitionTransition.create).toHaveBeenCalled();
  });
});

describe("Phase 4 — the freeze control cannot silently stop working", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  it("registers the model for the RLS tenant GUC", () => {
    // The FORCE-RLS trap: a table with a tenant policy and no RLS_MODELS entry
    // reads back EMPTY for every ordinary query, so the gate would silently stop
    // gating while every test above still passed against its own fake.
    const rls = readFileSync(path.join(root, "src/lib/rlsTenant.js"), "utf8");
    expect(rls).toContain("'RecruitmentHiringFreeze'");
  });

  it("ships its policy in the same migration that creates the table", () => {
    const sql = readFileSync(
      path.join(root, "prisma/migrations/20260920240000_recruitment_hiring_freeze/migration.sql"),
      "utf8",
    );
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY tenant_isolation");
    expect(sql).not.toContain("ALWAYS");
  });

  it("resolves the freeze routes to their OWN permission, not the general one", () => {
    // First-match-wins in RESOURCE_PREFIXES is the only thing separating "a
    // recruiter may edit requisitions" from "a recruiter may lift a hiring
    // freeze". If the ordering is ever reversed this test must fail.
    const middleware = readFileSync(path.join(root, "src/middlewares/routeAuthorization.middleware.js"), "utf8");
    const freezeAt = middleware.indexOf('"/api/recruitment/freeze"');
    const generalAt = middleware.indexOf('["/api/recruitment", "hr.recruitment"]');
    expect(freezeAt).toBeGreaterThan(-1);
    expect(generalAt).toBeGreaterThan(-1);
    expect(freezeAt).toBeLessThan(generalAt);
    expect(middleware).toContain('"hr.recruitment.freeze"');
  });
});
