// tests/unit/recruitmentHandoff.service.test.js
//
// Phase 9 — an ACCEPTED offer must provision exactly one employee/onboarding
// checklist, and a failed handoff must be visible and retryable.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const tx = {
  employee: { findFirst: jest.fn(), create: jest.fn() },
  employmentTerms: { findFirst: jest.fn(), create: jest.fn() },
  payrollEarningType: { findFirst: jest.fn(), create: jest.fn() },
  payrollAssignment: { findFirst: jest.fn(), create: jest.fn() },
  onboardingChecklist: { findFirst: jest.fn(), create: jest.fn() },
  onboardingTask: { createMany: jest.fn() },
  // FR-13 residue — the checklist template resolver reads the tenant's default
  // template; none configured here, so provisioning seeds the baseline.
  onboardingChecklistTemplate: { findFirst: jest.fn(async () => null) },
  offerHandoff: { update: jest.fn() },
  offerHandoffAttempt: { create: jest.fn() },
  offer: { update: jest.fn() },
  // Outbox: the handoff announces completion, the hire and the new employee.
  outboxEvent: { create: jest.fn(async ({ data }) => ({ id: 1, ...data })) },
};

const prismaDouble = {
  offer: { findFirst: jest.fn() },
  offerHandoff: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
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

// Employee codes are allocated by main's employee-code service under an
// advisory lock; the double stands in for that allocation.
const mockPrepareEmployeeInsert = jest.fn(async (_tx, data, { tenantId, category }) => ({
  ...data,
  tenant_id: tenantId,
  employeeCategory: category,
  employee_code: "EMP-0007",
}));
jest.unstable_mockModule("../../src/services/employee-code.service.js", () => ({
  prepareEmployeeInsert: mockPrepareEmployeeInsert,
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const eventNames = () => tx.outboxEvent.create.mock.calls.map(([arg]) => arg.data.eventName);

const prisma = (await import("../../src/config/prisma.js")).default;
const { runOfferHandoff, listFailedHandoffs, HANDOFF_STATUS } = await import(
  "../../src/services/recruitmentHandoff.service.js"
);

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
    candidate: { id: 5, firstName: "Ayesha", lastName: "Khan", email: "ayesha@example.com", phone: "+92" },
  },
};

describe("Recruitment accepted-offer handoff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.offer.findFirst.mockResolvedValue(ACCEPTED_OFFER);
    prisma.offerHandoff.create.mockResolvedValue({ id: 1, offerId: 9, status: HANDOFF_STATUS.IN_PROGRESS, attemptCount: 1 });
    tx.offerHandoff.update.mockResolvedValue({ id: 1, offerId: 9, status: HANDOFF_STATUS.COMPLETED, employeeId: 77, checklistId: 55 });
    tx.offerHandoffAttempt.create.mockResolvedValue({ id: 1 });
    tx.employee.findFirst.mockResolvedValue(null);
    tx.employee.create.mockResolvedValue({
      id: 77,
      tenant_id: TENANT,
      employee_code: "EMP-0007",
      first_name: "Ayesha",
      last_name: "Khan",
      hire_date: new Date("2026-10-01T00:00:00Z"),
    });
    tx.employmentTerms.findFirst.mockResolvedValue(null);
    tx.employmentTerms.create.mockResolvedValue({ id: 1 });
    tx.payrollEarningType.findFirst.mockResolvedValue({ id: 4 });
    tx.payrollAssignment.findFirst.mockResolvedValue(null);
    tx.payrollAssignment.create.mockResolvedValue({ id: 1 });
    tx.onboardingChecklist.findFirst.mockResolvedValue(null);
    tx.onboardingChecklist.create.mockResolvedValue({ id: 55 });
    tx.onboardingTask.createMany.mockResolvedValue({ count: 12 });
  });

  it("provisions one employee and onboarding checklist for a first-time acceptance", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);

    const { handoff, replayed } = await runOfferHandoff({ offerId: 9, tenantId: TENANT });

    expect(replayed).toBe(false);
    expect(handoff.status).toBe(HANDOFF_STATUS.COMPLETED);
    expect(tx.employee.create).toHaveBeenCalledTimes(1);
    expect(tx.employee.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenant_id: TENANT, email: "ayesha@example.com" }) }),
    );
    // N-15: the contractual base lives in employment_terms, so the handoff
    // writes terms and must NOT also write a BASE_SALARY assignment — payroll
    // treats that combination as a duplicate and four tenants paid 145%.
    expect(tx.employmentTerms.create).toHaveBeenCalledTimes(1);
    expect(tx.employmentTerms.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT,
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
    const seeded = tx.onboardingTask.createMany.mock.calls[0][0].data;
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((row) => row.checklistId === 55 && row.tenantId === TENANT)).toBe(true);
  });

  it("allocates the employee code from the offer's category and announces the hire", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);

    await runOfferHandoff({ offerId: 9, tenantId: TENANT, actorId: 4 });

    expect(mockPrepareEmployeeInsert).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ email: "ayesha@example.com" }),
      { tenantId: TENANT, category: "EMPLOYEE" },
    );
    // A client-supplied code would be refused; the handoff never sends one.
    expect(mockPrepareEmployeeInsert.mock.calls[0][1].employee_code).toBeUndefined();
    expect(eventNames()).toEqual(
      expect.arrayContaining([
        "hr.employee.lifecycle.v1",
        "hr.recruitment.handoff_completed.v1",
        "hr.recruitment.candidate_hired.v1",
      ]),
    );
    // The offer already carried its category, so it is not rewritten.
    expect(tx.offer.update).not.toHaveBeenCalled();
  });

  it("fails visibly, without guessing, when a legacy acceptance has no category", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    prisma.offer.findFirst.mockResolvedValue({ ...ACCEPTED_OFFER, employeeCategory: null });
    prisma.offerHandoff.update.mockResolvedValue({ id: 1, status: HANDOFF_STATUS.FAILED });

    await expect(runOfferHandoff({ offerId: 9, tenantId: TENANT })).rejects.toMatchObject({
      code: "HR-RECRUITMENT-HANDOFF-CATEGORY-REQUIRED",
    });
    expect(tx.employee.create).not.toHaveBeenCalled();
  });

  it("lets an operator retry a legacy acceptance with the category, and stores it", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    prisma.offer.findFirst.mockResolvedValue({ ...ACCEPTED_OFFER, employeeCategory: null });

    await runOfferHandoff({ offerId: 9, tenantId: TENANT, employeeCategory: "INTERNEE" });

    expect(tx.offer.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { employeeCategory: "INTERNEE" } });
    expect(mockPrepareEmployeeInsert.mock.calls[0][2]).toEqual({ tenantId: TENANT, category: "INTERNEE" });
  });

  it("refuses a retry category that contradicts the one chosen at acceptance", async () => {
    await expect(
      runOfferHandoff({ offerId: 9, tenantId: TENANT, employeeCategory: "MANAGEMENT" }),
    ).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-HANDOFF-CATEGORY-CONFLICT" });
    expect(prisma.offerHandoff.create).not.toHaveBeenCalled();
  });

  it("does not duplicate checklist tasks when the checklist already exists", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    tx.onboardingChecklist.findFirst.mockResolvedValue({ id: 55 });

    await runOfferHandoff({ offerId: 9, tenantId: TENANT });

    expect(tx.onboardingChecklist.create).not.toHaveBeenCalled();
    expect(tx.onboardingTask.createMany).not.toHaveBeenCalled();
  });

  it("replays a COMPLETED handoff instead of provisioning a second employee", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue({
      id: 1,
      offerId: 9,
      status: HANDOFF_STATUS.COMPLETED,
      employeeId: 77,
      checklistId: 55,
    });

    const { handoff, replayed } = await runOfferHandoff({ offerId: 9, tenantId: TENANT });

    expect(replayed).toBe(true);
    expect(handoff.employeeId).toBe(77);
    expect(tx.employee.create).not.toHaveBeenCalled();
    expect(tx.onboardingChecklist.create).not.toHaveBeenCalled();
  });

  it("adopts an existing employee with the same tenant + email", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    tx.employee.findFirst.mockResolvedValue({ id: 42 });

    await runOfferHandoff({ offerId: 9, tenantId: TENANT });

    expect(tx.employee.create).not.toHaveBeenCalled();
    expect(tx.employmentTerms.create).toHaveBeenCalledTimes(1);
    expect(tx.offerHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ employeeId: 42 }) }),
    );
  });

  it("refuses to provision for an offer the candidate has not accepted", async () => {
    prisma.offer.findFirst.mockResolvedValue({ ...ACCEPTED_OFFER, status: "SENT" });

    await expect(runOfferHandoff({ offerId: 9, tenantId: TENANT }))
      .rejects.toMatchObject({ code: "HR-RECRUITMENT-HANDOFF-OFFER-NOT-ACCEPTED" });
    expect(tx.employee.create).not.toHaveBeenCalled();
  });

  it("records a FAILED handoff (with a reason) and rolls back provisioning", async () => {
    prisma.offerHandoff.findFirst.mockResolvedValue(null);
    tx.employmentTerms.create.mockRejectedValue(new Error("terms FK violation"));

    await expect(runOfferHandoff({ offerId: 9, tenantId: TENANT }))
      .rejects.toThrow("terms FK violation");

    // The failure is recorded in its own tenant transaction (the provisioning tx
    // already rolled back), so it lands on the tx double.
    expect(tx.offerHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: HANDOFF_STATUS.FAILED, lastError: "terms FK violation" }),
      }),
    );
    expect(tx.offerHandoffAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ step: "provision", status: "FAILED" }) }),
    );
    // The checklist step never ran; the whole provisioning tx aborted.
    expect(tx.onboardingChecklist.create).not.toHaveBeenCalled();
  });

  it("requires a tenant", async () => {
    await expect(runOfferHandoff({ offerId: 9, tenantId: null }))
      .rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
  });
});

describe("listFailedHandoffs — the operator fleet view (Phase 9 residue)", () => {

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
    await expect(listFailedHandoffs({ tenantId: null }))
      .rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
  });
});

describe("D-08 — HR_RECRUITMENT_OFFER_HANDOFF is read by the handoff", () => {
  afterEach(() => {
    delete process.env.HR_RECRUITMENT_OFFER_HANDOFF;
  });

  it("refuses to provision with 503 while the flag is off, before touching the handoff row", async () => {
    process.env.HR_RECRUITMENT_OFFER_HANDOFF = "disabled";
    prisma.offerHandoff.create.mockClear();

    await expect(runOfferHandoff({ offerId: 9, tenantId: TENANT })).rejects.toMatchObject({
      status: 503,
      code: "HR-RECRUITMENT-OFFER-HANDOFF-DISABLED",
    });
    expect(prisma.offerHandoff.create).not.toHaveBeenCalled();
  });
});
