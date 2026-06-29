// tests/unit/hrContractCreateEmployee.test.js
//
// hr_employee_create defect (capstone-proven): the MCP tool advertises only
// firstName + lastName as required, but the service Zod additionally forced
// jobTitle / hireDate / employmentStatus / positionId, and positionId
// FK-checks against a Position that is not seeded — so a minimal create 400/500s.
//
// These tests drive the SERVICE path (createEmployee) with a mocked Prisma to
// prove:
//   - a minimal { firstName, lastName } create persists,
//   - the positionId FK lookup is skipped when positionId is absent,
//   - the positionId FK lookup runs (and can fail cleanly) when supplied.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockEmployeeCreate = jest.fn();
const mockEmployeeFindUnique = jest.fn();
const mockPositionFindUnique = jest.fn();
const mockRegionFindUnique = jest.fn();
const mockEmergencyCreateMany = jest.fn();
const mockMediaCreateMany = jest.fn();
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();

const prismaMock = {
  employee: { create: mockEmployeeCreate, findUnique: mockEmployeeFindUnique },
  position: { findUnique: mockPositionFindUnique },
  region: { findUnique: mockRegionFindUnique },
  emergencyContacts: { createMany: mockEmergencyCreateMany },
  employeeMedia: { createMany: mockMediaCreateMany },
  $transaction: mockTransaction,
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaMock }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));

const hrContractService = await import("../../src/services/hrContract.service.js");

const CREATED = { id: 101, first_name: "Ada", last_name: "Lovelace" };

describe("hrContract.createEmployee — minimal create", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // tx callback receives a tx client; reuse the same prisma mock surface
    mockTransaction.mockImplementation(async (cb) => cb(prismaMock));
    mockEmployeeCreate.mockResolvedValue({ id: 101 });
    mockEmployeeFindUnique.mockResolvedValue(CREATED);
  });

  it("persists a minimal { firstName, lastName } employee and never touches the position FK", async () => {
    const result = await hrContractService.createEmployee(
      { firstName: "Ada", lastName: "Lovelace" },
      42
    );

    expect(mockEmployeeCreate).toHaveBeenCalledTimes(1);
    const writtenData = mockEmployeeCreate.mock.calls[0][0].data;
    expect(writtenData.first_name).toBe("Ada");
    expect(writtenData.last_name).toBe("Lovelace");
    // nullable columns: no value supplied → not forced
    expect(writtenData.job_title).toBeUndefined();
    expect(writtenData.positionId).toBeUndefined();
    expect(writtenData.hire_date).toBeUndefined();

    // FK lookup must NOT run when positionId is not supplied (unseeded Position
    // must not block a minimal create)
    expect(mockPositionFindUnique).not.toHaveBeenCalled();

    // the created record is loaded back and returned as a mapped profile DTO
    expect(mockEmployeeFindUnique).toHaveBeenCalled();
    expect(result).toBeTruthy();
    expect(result.summary.id).toBe(101);
    expect(result.personal.firstName).toBe("Ada");
    expect(result.personal.lastName).toBe("Lovelace");
  });

  it("FK-validates positionId ONLY when supplied (active position succeeds)", async () => {
    mockPositionFindUnique.mockResolvedValue({ id: 7, isActive: true, title: "Engineer" });

    await hrContractService.createEmployee(
      { firstName: "Ada", lastName: "Lovelace", positionId: 7 },
      42
    );

    expect(mockPositionFindUnique).toHaveBeenCalledTimes(1);
    expect(mockPositionFindUnique.mock.calls[0][0].where).toEqual({ id: 7 });
    expect(mockEmployeeCreate.mock.calls[0][0].data.positionId).toBe(7);
  });

  it("fails cleanly when a supplied positionId does not exist (real FK violation still rejected)", async () => {
    mockPositionFindUnique.mockResolvedValue(null);

    await expect(
      hrContractService.createEmployee(
        { firstName: "Ada", lastName: "Lovelace", positionId: 999 },
        42
      )
    ).rejects.toThrow(/Position ID 999 does not exist/);

    expect(mockEmployeeCreate).not.toHaveBeenCalled();
  });

  it("still rejects a create missing the DB-required firstName", async () => {
    await expect(
      hrContractService.createEmployee({ lastName: "Lovelace" }, 42)
    ).rejects.toThrow();
    expect(mockEmployeeCreate).not.toHaveBeenCalled();
  });
});
