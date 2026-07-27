// F-03 — createSystemAccount transitions to the durable HR-owned workflow.
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
const baseInput = {
  firstName: "Ada",
  lastName: "Lovelace",
  jobTitle: "Engineer",
  gender: "female",
  hireDate: "2026-01-01",
  mobilePhone: "+15551234567",
  workEmail: "ada@corp.example",
};
const ctx = {
  tenantId: TENANT,
  correlationId: "corr-f03",
  actor: { userId: "42", employeeId: "9", permissions: ["rbac.employee.create"], roles: ["hr_admin"] },
};

describe("F-03 hrContract.createEmployee system-account workflow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (cb) => cb(prismaMock));
    mockEmployeeCreate.mockImplementation(async ({ data }) => ({ id: 101, ...data }));
    mockEmployeeFindUnique.mockResolvedValue(CREATED_PROFILE);
    mockBankFindFirst.mockResolvedValue(null);
    mockProvisioningCreate.mockImplementation(async ({ data }) => ({ id: "intent-1", ...data }));
  });

  it("persists the mapped intent in the Employee transaction and returns pending", async () => {
    const result = await hrContractService.createEmployee({
      ...baseInput,
      createSystemAccount: true,
      systemEmail: "ada.login@corp.example",
      password: "sup3rSecret!",
      roleId: 7,
      permissions: [{ permissionId: 12, granted: true }, { permissionId: 13, granted: false }],
    }, 42, ctx);

    expect(mockCreateRbacSystemAccount).not.toHaveBeenCalled();
    const writtenEmployee = mockEmployeeCreate.mock.calls[0][0].data;
    expect(writtenEmployee).not.toHaveProperty("password");
    expect(writtenEmployee).not.toHaveProperty("roleId");
    const intent = mockProvisioningCreate.mock.calls[0][0].data;
    expect(intent.payload).toMatchObject({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada.login@corp.example",
      hrEmployeeId: 101,
      mediaId: 555,
      roles: [{
        roleId: 7,
        permissions: [{ permissionId: 12, granted: true }, { permissionId: 13, granted: false }],
      }],
    });
    expect(intent.payload.hire_date).toBe(new Date("2026-01-01").toISOString());
    expect(JSON.stringify(intent)).not.toContain("sup3rSecret!");
    expect(result.systemAccount).toMatchObject({ provisioningId: "intent-1", status: "pending", attempts: 0 });
  });

  it("falls back to workEmail and never returns a plaintext password", async () => {
    const result = await hrContractService.createEmployee({
      ...baseInput, createSystemAccount: true, roleId: 7,
    }, 42, ctx);
    expect(mockProvisioningCreate.mock.calls[0][0].data.payload.email).toBe("ada@corp.example");
    expect(JSON.stringify(result)).not.toMatch(/password/i);
  });

  it("does not create an intent when createSystemAccount is absent or false", async () => {
    await hrContractService.createEmployee(baseInput, 42);
    await hrContractService.createEmployee({ ...baseInput, createSystemAccount: false }, 42);
    expect(mockProvisioningCreate).not.toHaveBeenCalled();
    expect(mockCreateRbacSystemAccount).not.toHaveBeenCalled();
  });

  it("rejects an opted-in request without roleId before writing Employee", async () => {
    await expect(hrContractService.createEmployee({
      ...baseInput, createSystemAccount: true,
    }, 42, ctx)).rejects.toThrow(/HR-0302/);
    expect(mockEmployeeCreate).not.toHaveBeenCalled();
  });
});
