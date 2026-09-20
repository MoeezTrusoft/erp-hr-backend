// tests/unit/payrollHireProvisioning.service.test.js
//
// Phase 9 — payroll owns how a hire's contractual base is stored.
//
// The rule under test is N-15 (operator law 2026-09-11): the contractual Basic
// lives in employment_terms.baseSalary, and a BASE_SALARY earning ASSIGNMENT
// alongside those terms is a DUPLICATE the pricing engine drops (four tenants
// carried both and paid 145% of package). So `baseSource: 'TERMS'` — the default
// a hire uses — must write the terms and nothing else, while the legacy
// assignment-driven pattern stays available behind an explicit opt-in.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const db = {
  employmentTerms: { findFirst: jest.fn(), create: jest.fn() },
  payrollEarningType: { findFirst: jest.fn(), create: jest.fn() },
  payrollAssignment: { findFirst: jest.fn(), create: jest.fn() },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
const logAction = jest.fn();
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));

const { provisionHireCompensation, getBaseSalaryEarningTypeId } = await import(
  "../../src/services/payrollService.js"
);

const TENANT = "11111111-1111-4111-8111-111111111111";

const HIRE = {
  employeeId: 77,
  tenantId: TENANT,
  baseSalary: "85000",
  currency: "PKR",
  startDate: new Date("2026-10-01T00:00:00Z"),
  actorId: 12,
};

describe("payroll hire compensation provisioning", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.employmentTerms.findFirst.mockResolvedValue(null);
    db.employmentTerms.create.mockResolvedValue({ id: 501, employeeId: 77 });
    db.payrollEarningType.findFirst.mockResolvedValue({ id: 4 });
    db.payrollAssignment.findFirst.mockResolvedValue(null);
    db.payrollAssignment.create.mockResolvedValue({ id: 601, employeeId: 77 });
  });

  it("stores the base on the employment terms and writes no duplicate assignment (N-15)", async () => {
    const result = await provisionHireCompensation(HIRE);

    expect(result).toMatchObject({ baseSource: "TERMS", employmentTermsId: 501 });
    expect(db.employmentTerms.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT,
          employeeId: 77,
          baseSalary: "85000",
          currency: "PKR",
          payFrequency: "MONTHLY",
        }),
      }),
    );
    // The whole point: no assignment, and therefore no earning type either.
    expect(db.payrollAssignment.create).not.toHaveBeenCalled();
    expect(db.payrollEarningType.create).not.toHaveBeenCalled();
    expect(db.payrollEarningType.findFirst).not.toHaveBeenCalled();
  });

  it("reuses existing employment terms instead of writing a second row", async () => {
    db.employmentTerms.findFirst.mockResolvedValue({ id: 502 });

    const result = await provisionHireCompensation(HIRE);

    expect(result.created.employmentTerms).toBe(false);
    expect(db.employmentTerms.create).not.toHaveBeenCalled();
  });

  it("supports the assignment-driven pattern only when explicitly requested", async () => {
    db.payrollEarningType.findFirst.mockResolvedValue(null);
    db.payrollEarningType.create.mockResolvedValue({ id: 9 });

    const result = await provisionHireCompensation({ ...HIRE, baseSource: "ASSIGNMENT" });

    expect(result).toMatchObject({ baseSource: "ASSIGNMENT", earningTypeId: 9, payrollAssignmentId: 601 });
    expect(db.payrollEarningType.create).toHaveBeenCalledTimes(1);
    expect(db.payrollAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT,
          employeeId: 77,
          earningTypeId: 9,
          isActive: true,
        }),
      }),
    );
    // The assignment pattern does not also create terms — one source of truth.
    expect(db.employmentTerms.create).not.toHaveBeenCalled();
  });

  it("does not duplicate an active base assignment on retry", async () => {
    db.payrollAssignment.findFirst.mockResolvedValue({ id: 602 });

    const result = await provisionHireCompensation({ ...HIRE, baseSource: "ASSIGNMENT" });

    expect(result.created.payrollAssignment).toBe(false);
    expect(db.payrollAssignment.create).not.toHaveBeenCalled();
  });

  it("scopes every read and write to the verified tenant", async () => {
    await provisionHireCompensation(HIRE);

    expect(db.employmentTerms.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT, employeeId: 77 }) }),
    );
    expect(db.employmentTerms.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: TENANT }) }),
    );
  });

  it("rejects an unsupported baseSource rather than guessing a table", async () => {
    await expect(provisionHireCompensation({ ...HIRE, baseSource: "BOTH" }))
      .rejects.toMatchObject({ status: 400, code: "HR-PAYROLL-BASE-SOURCE-INVALID" });
    expect(db.employmentTerms.create).not.toHaveBeenCalled();
  });

  it("fails closed without a tenant, an employee, or a salary", async () => {
    await expect(provisionHireCompensation({ ...HIRE, tenantId: null }))
      .rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
    await expect(provisionHireCompensation({ ...HIRE, employeeId: null }))
      .rejects.toMatchObject({ code: "HR-PAYROLL-EMPLOYEE-REQUIRED" });
    await expect(provisionHireCompensation({ ...HIRE, baseSalary: "  " }))
      .rejects.toMatchObject({ code: "HR-PAYROLL-SALARY-REQUIRED" });
    expect(db.employmentTerms.create).not.toHaveBeenCalled();
  });

  it("composes into a caller-owned transaction without emitting its own audit row", async () => {
    const tx = {
      employmentTerms: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 700 }) },
    };

    const result = await provisionHireCompensation(HIRE, { db: tx, audit: false });

    expect(result.employmentTermsId).toBe(700);
    expect(tx.employmentTerms.create).toHaveBeenCalledTimes(1);
    // The caller owns the audit trail; the shared client must stay untouched.
    expect(db.employmentTerms.create).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("audits through the shared path when the caller does not own the trail", async () => {
    await provisionHireCompensation(HIRE);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ module: "Employment Terms", tenantId: TENANT }),
    );
  });

  it("resolves (and only then creates) the tenant BASE_SALARY earning type", async () => {
    const id = await getBaseSalaryEarningTypeId(TENANT);

    expect(id).toBe(4);
    expect(db.payrollEarningType.create).not.toHaveBeenCalled();
    expect(db.payrollEarningType.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, code: "BASE_SALARY" },
    });
  });
});
