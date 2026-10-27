// tests/unit/recruitmentHandoff.service.test.js
//
// Phase 9 — an ACCEPTED offer must provision exactly one employee/onboarding
// checklist, and a failed handoff must be visible and retryable.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const tx = {
  $queryRaw: jest.fn(async () => [{ id: 1 }]),
  $queryRawUnsafe: jest.fn(async () => []),
  $executeRawUnsafe: jest.fn(async () => 1),
  candidate: { findFirst: jest.fn() },
  employee: { findFirst: jest.fn(), create: jest.fn() },
  employmentTerms: { findFirst: jest.fn(), create: jest.fn() },
  payrollEarningType: { findFirst: jest.fn(), create: jest.fn() },
  payrollAssignment: { findFirst: jest.fn(), create: jest.fn() },
  onboardingChecklist: { findFirst: jest.fn(), create: jest.fn() },
  onboardingTask: { createMany: jest.fn(), findMany: jest.fn() },
  onboardingSession: { create: jest.fn() },
  // FR-13 residue — the checklist template resolver reads the tenant's default
  // template; none configured here, so provisioning seeds the baseline.
  onboardingChecklistTemplate: { findFirst: jest.fn(async () => null) },
  offerHandoff: { update: jest.fn(), findFirst: jest.fn() },
  offerHandoffAttempt: { create: jest.fn() },
};

const prismaDouble = {
  offer: { findFirst: jest.fn() },
  offerHandoff: {
    upsert: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  offerHandoffAttempt: { create: jest.fn() },
};
// `config/prisma.js` is a legacy re-export of `lib/prisma.js`, and the handoff
// now reaches payroll through `payrollService` (which imports the canonical
// `lib/prisma.js` directly). Both module paths must resolve to the double, or
// the real singleton is constructed and the test needs a database.
jest.unstable_mockModule("../../src/config/prisma.js", () => ({
  default: prismaDouble,
}));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: prismaDouble,
}));
// The real helper only opens a tx and sets the RLS GUC; the mock just hands the
// caller the same tx double so provisioning steps are assertable.
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((_client, fn) => fn(tx)),
  rlsTenantExtension: jest.fn((client) => client),
}));

jest.unstable_mockModule(
  "../../src/services/candidatePrivacy.service.js",
  () => ({
    assertCommunicationsAllowed: jest.fn(async () => ({ allowed: true })),
  }),
);
const prepareEmployeeInsert = jest.fn(async (_tx, data, { category }) => ({
  ...data,
  employeeCategory: category,
  employee_code: "BC-0001",
}));
const enqueueEmployeeLifecycle = jest.fn(async () => ({}));
jest.unstable_mockModule("../../src/services/employee-code.service.js", () => ({
  prepareEmployeeInsert,
}));
jest.unstable_mockModule(
  "../../src/services/employeeOutbox.service.js",
  () => ({
    enqueueEmployeeLifecycle,
    mapEmployeeToLifecycleInput: (employee, event) => ({
      employeeId: employee.id,
      event,
    }),
  }),
);
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: jest.fn(async () => ({})),
}));
const prisma = (await import("../../src/config/prisma.js")).default;
const { runOfferHandoff, listFailedHandoffs, HANDOFF_STATUS } =
  await import("../../src/services/recruitmentHandoff.service.js");

const ACCEPTED_OFFER = {
  id: 9,
  status: "ACCEPTED",
  salary: "85000",
  currency: "PKR",
  startDate: new Date("2026-10-01T00:00:00Z"),
  employmentType: "FULL_TIME",
  employeeCategory: "EMPLOYEE",
  applicationId: 3,
  application: {
    candidate: {
      id: 5,
      firstName: "Ayesha",
      lastName: "Khan",
      email: "ayesha@example.com",
      phone: "+92",
    },
  },
};

describe("Recruitment accepted-offer handoff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.offer.findFirst.mockResolvedValue(ACCEPTED_OFFER);
    tx.candidate.findFirst.mockResolvedValue(
      ACCEPTED_OFFER.application.candidate,
    );
    prisma.offerHandoff.upsert.mockResolvedValue({
      id: 1,
      offerId: 9,
      status: HANDOFF_STATUS.IN_PROGRESS,
      attemptCount: 1,
    });
    tx.offerHandoff.findFirst.mockResolvedValue({
      id: 1,
      offerId: 9,
      status: HANDOFF_STATUS.IN_PROGRESS,
      attemptCount: 0,
    });
    tx.offerHandoff.update.mockResolvedValue({
      id: 1,
      offerId: 9,
      status: HANDOFF_STATUS.COMPLETED,
      employeeId: 77,
      checklistId: 55,
    });
    tx.offerHandoffAttempt.create.mockResolvedValue({ id: 1 });
    tx.employee.findFirst.mockResolvedValue(null);
    tx.employee.create.mockResolvedValue({ id: 77 });
    tx.employmentTerms.findFirst.mockResolvedValue(null);
    tx.employmentTerms.create.mockResolvedValue({ id: 1 });
    tx.payrollEarningType.findFirst.mockResolvedValue({ id: 4 });
    tx.payrollAssignment.findFirst.mockResolvedValue(null);
    tx.payrollAssignment.create.mockResolvedValue({ id: 1 });
    tx.onboardingChecklist.findFirst.mockResolvedValue(null);
    tx.onboardingChecklist.create.mockResolvedValue({ id: 55 });
    tx.onboardingTask.createMany.mockResolvedValue({ count: 12 });
    tx.onboardingTask.findMany.mockImplementation(async () =>
      tx.onboardingTask.createMany.mock.calls[0][0].data.map((row, index) => ({
        ...row,
        id: index + 1,
      })),
    );
    tx.onboardingSession.create.mockImplementation(async ({ data }) => ({
      id: data.title.length,
      ...data,
    }));
  });

  it("provisions one employee and onboarding checklist for a first-time acceptance", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);

    const { handoff, replayed } = await runOfferHandoff({
      offerId: 9,
      tenantId: "tenant-a",
    });

    expect(replayed).toBe(false);
    expect(handoff.status).toBe(HANDOFF_STATUS.COMPLETED);
    expect(tx.employee.create).toHaveBeenCalledTimes(1);
    expect(prepareEmployeeInsert).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ email: "ayesha@example.com" }),
      { tenantId: "tenant-a", category: "EMPLOYEE" },
    );
    expect(enqueueEmployeeLifecycle).toHaveBeenCalledTimes(1);
    expect(tx.employee.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant_id: "tenant-a",
          email: "ayesha@example.com",
        }),
      }),
    );
    // N-15: the contractual base lives in employment_terms, so the handoff
    // writes terms and must NOT also write a BASE_SALARY assignment — payroll
    // treats that combination as a duplicate and four tenants paid 145%.
    expect(tx.employmentTerms.create).toHaveBeenCalledTimes(1);
    expect(tx.employmentTerms.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-a",
          employeeId: 77,
          baseSalary: "85000",
          currency: "PKR",
        }),
      }),
    );
    expect(tx.payrollAssignment.create).not.toHaveBeenCalled();
    expect(tx.payrollEarningType.create).not.toHaveBeenCalled();
    expect(tx.onboardingChecklist.create).toHaveBeenCalledTimes(1);
    // The new checklist is seeded with the default task baseline.
    expect(tx.onboardingTask.createMany).toHaveBeenCalledTimes(1);
    expect(tx.onboardingSession.create).toHaveBeenCalledTimes(3);
    for (const [{ data }] of tx.onboardingSession.create.mock.calls) {
      expect(data).toMatchObject({ tenantId: "tenant-a", checklistId: 55 });
    }
    const seeded = tx.onboardingTask.createMany.mock.calls[0][0].data;
    expect(seeded.length).toBeGreaterThan(0);
    expect(
      seeded.every(
        (row) => row.checklistId === 55 && row.tenantId === "tenant-a",
      ),
    ).toBe(true);
  });

  it("does not duplicate checklist tasks when the checklist already exists", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    tx.onboardingChecklist.findFirst.mockResolvedValue({ id: 55 });

    await runOfferHandoff({ offerId: 9, tenantId: "tenant-a" });

    expect(tx.onboardingChecklist.create).not.toHaveBeenCalled();
    expect(tx.onboardingTask.createMany).not.toHaveBeenCalled();
    expect(tx.onboardingSession.create).not.toHaveBeenCalled();
  });

  it("replays a COMPLETED handoff instead of provisioning a second employee", async () => {
    tx.offerHandoff.findFirst.mockResolvedValue({
      id: 1,
      offerId: 9,
      status: HANDOFF_STATUS.COMPLETED,
      employeeId: 77,
      checklistId: 55,
    });

    const { handoff, replayed } = await runOfferHandoff({
      offerId: 9,
      tenantId: "tenant-a",
    });

    expect(replayed).toBe(true);
    expect(handoff.employeeId).toBe(77);
    expect(tx.employee.create).not.toHaveBeenCalled();
    expect(tx.onboardingChecklist.create).not.toHaveBeenCalled();
  });

  it("adopts an existing employee with the same tenant + email", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    tx.employee.findFirst.mockResolvedValue({ id: 42 });

    await runOfferHandoff({ offerId: 9, tenantId: "tenant-a" });

    expect(tx.employee.create).not.toHaveBeenCalled();
    expect(tx.employmentTerms.create).toHaveBeenCalledTimes(1);
    expect(tx.offerHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ employeeId: 42 }),
      }),
    );
  });

  it("refuses to provision for an offer the candidate has not accepted", async () => {
    prisma.offer.findFirst.mockResolvedValue({
      ...ACCEPTED_OFFER,
      status: "SENT",
    });

    await expect(
      runOfferHandoff({ offerId: 9, tenantId: "tenant-a" }),
    ).rejects.toMatchObject({
      code: "HR-RECRUITMENT-HANDOFF-OFFER-NOT-ACCEPTED",
    });
    expect(tx.employee.create).not.toHaveBeenCalled();
  });

  it("records a FAILED handoff (with a reason) and rolls back provisioning", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    tx.employmentTerms.create.mockRejectedValue(
      new Error("terms FK violation"),
    );

    await expect(
      runOfferHandoff({ offerId: 9, tenantId: "tenant-a" }),
    ).rejects.toThrow("terms FK violation");

    // The failure is recorded in its own tenant transaction (the provisioning tx
    // already rolled back), so it lands on the tx double.
    expect(tx.offerHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: HANDOFF_STATUS.FAILED,
          lastError: "terms FK violation",
        }),
      }),
    );
    expect(tx.offerHandoffAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ step: "provision", status: "FAILED" }),
      }),
    );
    // The checklist step never ran; the whole provisioning tx aborted.
    expect(tx.onboardingChecklist.create).not.toHaveBeenCalled();
  });

  it("requires a tenant", async () => {
    await expect(
      runOfferHandoff({ offerId: 9, tenantId: null }),
    ).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
  });
});

describe("listFailedHandoffs — the operator fleet view (Phase 9 residue)", () => {
  const TENANT = "tenant-a";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns operator-shaped rows for FAILED handoffs, oldest first", async () => {
    prismaDouble.offerHandoff.findMany.mockResolvedValue([
      {
        id: 2,
        offerId: 9,
        status: "FAILED",
        attemptCount: 2,
        lastStep: "provision",
        updated_at: new Date("2026-09-20T10:00:00Z"),
        offer: {
          id: 9,
          status: "ACCEPTED",
          application: {
            id: 3,
            jobRequisition: { id: 7, title: "Senior Backend Engineer" },
            candidate: { id: 5, firstName: "Ayesha", lastName: "Khan" },
          },
        },
      },
    ]);

    const result = await listFailedHandoffs({ tenantId: TENANT });

    // FAILED-first filtering is the default; ordering is oldest-failure-first.
    expect(prismaDouble.offerHandoff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, status: "FAILED" }),
        orderBy: [{ updated_at: "asc" }],
      }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      handoffId: 2,
      status: "FAILED",
      offerId: 9,
      requisitionId: 7,
      requisitionTitle: "Senior Backend Engineer",
      candidateName: "Ayesha Khan",
    });
    // lastError deliberately stays OFF the fleet surface (it is on the
    // per-offer detail read) — assert it is not projected.
    expect(result.items[0].lastError).toBeUndefined();
  });

  it("supports an unfiltered listing when status is empty", async () => {
    prismaDouble.offerHandoff.findMany.mockResolvedValue([]);
    await listFailedHandoffs({ tenantId: TENANT, status: "" });
    expect(prismaDouble.offerHandoff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT } }),
    );
  });

  it("requires a tenant", async () => {
    await expect(listFailedHandoffs({ tenantId: null })).rejects.toMatchObject({
      code: "HR-TENANT-REQUIRED",
    });
  });
});
