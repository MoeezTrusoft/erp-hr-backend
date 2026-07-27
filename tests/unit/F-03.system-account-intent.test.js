// F-03 / ARCH-00 P-04/P-07/P-12 / ARCH-01 §3.5, §7-§9
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockEmployeeCreate = jest.fn();
const mockEmployeeUpdate = jest.fn();
const mockEmployeeFindUnique = jest.fn();
const mockPositionFindUnique = jest.fn();
const mockRegionFindUnique = jest.fn();
const mockEmergencyCreateMany = jest.fn();
const mockMediaCreateMany = jest.fn();
const mockBankFindFirst = jest.fn();
const mockProvisioningCreate = jest.fn();
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();
const mockCreateRbacSystemAccount = jest.fn();

const prismaMock = {
  employee: { create: mockEmployeeCreate, update: mockEmployeeUpdate, findUnique: mockEmployeeFindUnique },
  position: { findUnique: mockPositionFindUnique },
  region: { findUnique: mockRegionFindUnique },
  emergencyContacts: { createMany: mockEmergencyCreateMany },
  employeeMedia: { createMany: mockMediaCreateMany },
  bankDetail: { findFirst: mockBankFindFirst },
  systemAccountProvisioning: { create: mockProvisioningCreate },
  $executeRaw: jest.fn(),
  $transaction: mockTransaction,
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaMock }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  createRbacSystemAccount: mockCreateRbacSystemAccount,
  getUserByEmployeeId: jest.fn(),
}));

const hrContractService = await import("../../src/services/hrContract.service.js");

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const CREATED_PROFILE = {
  id: 101,
  first_name: "Ada",
  last_name: "Lovelace",
  status: "Active",
  employement_status: "Active",
  employee_media_id: 555,
};

describe("F-03 system-account provisioning intent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (cb) => cb(prismaMock));
    mockEmployeeCreate.mockImplementation(async ({ data }) => ({ id: 101, ...data }));
    mockEmployeeFindUnique.mockResolvedValue(CREATED_PROFILE);
    mockBankFindFirst.mockResolvedValue(null);
    mockProvisioningCreate.mockImplementation(async ({ data }) => ({ id: "intent-1", ...data }));
  });

  it("atomically persists a tenant-scoped intent and returns pending without calling RBAC", async () => {
    const result = await hrContractService.createEmployee({
      firstName: "Ada",
      lastName: "Lovelace",
      workEmail: "ada@corp.example",
      createSystemAccount: true,
      password: "must-not-be-retained",
      roleId: 7,
      permissions: [{ permissionId: 12, granted: true }],
    }, 42, {
      tenantId: TENANT,
      correlationId: "corr-f03",
      actor: {
        userId: "42",
        employeeId: "9",
        email: "operator@corp.example",
        roles: ["hr_admin"],
        permissions: ["rbac.employee.create"],
      },
    });

    expect(mockProvisioningCreate).toHaveBeenCalledTimes(1);
    expect(mockCreateRbacSystemAccount).not.toHaveBeenCalled();
    const intent = mockProvisioningCreate.mock.calls[0][0].data;
    expect(intent).toMatchObject({
      tenantId: TENANT,
      employeeId: 101,
      status: "PENDING",
      correlationId: "corr-f03",
    });
    expect(intent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(intent.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(intent)).not.toContain("must-not-be-retained");
    expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
    expect(result.systemAccount).toEqual({
      provisioningId: "intent-1",
      status: "pending",
      attempts: 0,
      nextAttemptAt: intent.nextAttemptAt,
    });
  });

  it("rejects an untenantable provisioning request before creating the employee", async () => {
    await expect(hrContractService.createEmployee({
      firstName: "Ada",
      lastName: "Lovelace",
      createSystemAccount: true,
      roleId: 7,
    }, 42, {})).rejects.toThrow(/HR-0301/);

    expect(mockEmployeeCreate).not.toHaveBeenCalled();
    expect(mockProvisioningCreate).not.toHaveBeenCalled();
  });
});
