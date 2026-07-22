// tests/unit/hrContractCreateEmployee.systemAccount.test.js
//
// Single-call orchestration: when Create-Employee sets createSystemAccount:true,
// HR creates the employee AND then internally calls RBAC to provision the login
// User (one FE call instead of two). These tests drive the SERVICE path
// (createEmployee) with a mocked Prisma + a mocked rbac.client to prove:
//   (a) the schema accepts the system-account fields and they do NOT leak into
//       the Employee DB row;
//   (b) createSystemAccount:true calls createRbacSystemAccount with the correctly
//       mapped RBAC payload, and returns systemAccount:{ userId, status:'created' };
//   (c) partial failure — RBAC returns {ok:false} / throws → employee is still
//       returned with systemAccount:{ status:'failed', ... };
//   (d) createSystemAccount:false/absent → no RBAC call, no systemAccount field;
//   (e) guard — createSystemAccount:true but roleId/password missing → skipped.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockEmployeeCreate = jest.fn();
const mockEmployeeUpdate = jest.fn();
const mockEmployeeFindUnique = jest.fn();
const mockPositionFindUnique = jest.fn();
const mockRegionFindUnique = jest.fn();
const mockEmergencyCreateMany = jest.fn();
const mockMediaCreateMany = jest.fn();
const mockBankFindFirst = jest.fn();
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
  $transaction: mockTransaction,
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaMock }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  createRbacSystemAccount: mockCreateRbacSystemAccount,
  getUserByEmployeeId: jest.fn(),
}));

const hrContractService = await import("../../src/services/hrContract.service.js");

// The row returned from the final tx findUnique (employeeProfileSelect shape).
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

describe("hrContract.createEmployee — RBAC system-account orchestration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (cb) => cb(prismaMock));
    mockEmployeeCreate.mockResolvedValue({ id: 101, status: "Active" });
    mockEmployeeFindUnique.mockResolvedValue(CREATED_PROFILE);
    mockBankFindFirst.mockResolvedValue(null);
    mockCreateRbacSystemAccount.mockResolvedValue({ ok: true, user: { id: 9001 } });
  });

  it("(a) accepts system-account fields WITHOUT leaking them into the Employee row", async () => {
    await hrContractService.createEmployee(
      {
        ...baseInput,
        createSystemAccount: true,
        systemEmail: "ada.login@corp.example",
        password: "sup3rSecret!",
        roleId: 7,
        permissions: [{ permissionId: 12, granted: true }],
      },
      42
    );

    expect(mockEmployeeCreate).toHaveBeenCalledTimes(1);
    const written = mockEmployeeCreate.mock.calls[0][0].data;
    // None of the system-account fields may become Employee columns.
    expect(written).not.toHaveProperty("password");
    expect(written).not.toHaveProperty("roleId");
    expect(written).not.toHaveProperty("createSystemAccount");
    expect(written).not.toHaveProperty("systemEmail");
    expect(written).not.toHaveProperty("permissions");
    // Real employee fields still map through.
    expect(written.first_name).toBe("Ada");
    expect(written.job_title).toBe("Engineer");
  });

  it("(b) calls createRbacSystemAccount with the correctly-mapped payload and returns created", async () => {
    const result = await hrContractService.createEmployee(
      {
        ...baseInput,
        createSystemAccount: true,
        systemEmail: "ada.login@corp.example",
        password: "sup3rSecret!",
        roleId: 7,
        permissions: [{ permissionId: 12, granted: true }, { permissionId: 13, granted: false }],
      },
      42
    );

    expect(mockCreateRbacSystemAccount).toHaveBeenCalledTimes(1);
    const payload = mockCreateRbacSystemAccount.mock.calls[0][0];
    expect(payload).toMatchObject({
      first_name: "Ada",
      last_name: "Lovelace",
      job_title: "Engineer",
      email: "ada.login@corp.example",
      phone: "+15551234567",
      gender: "female",
      status: "Active",
      password: "sup3rSecret!",
      hrEmployeeId: 101,
      mediaId: 555,
    });
    // hire_date maps through as an ISO STRING (RBAC's rbac_employee_create tool
    // requires a string; the contract Zod coerced hireDate to a Date, serialized
    // to ISO in the payload builder).
    expect(typeof payload.hire_date).toBe("string");
    expect(payload.hire_date).toBe(new Date("2026-01-01").toISOString());
    // roles[0] carries roleId + the mapped permission overrides.
    expect(payload.roles).toEqual([
      { roleId: 7, permissions: [{ permissionId: 12, granted: true }, { permissionId: 13, granted: false }] },
    ]);

    expect(result.systemAccount).toEqual({ userId: 9001, status: "created" });
    // employee profile still returned.
    expect(result.summary.id).toBe(101);
  });

  it("(b') login email falls back to workEmail when systemEmail is absent", async () => {
    await hrContractService.createEmployee(
      { ...baseInput, createSystemAccount: true, password: "sup3rSecret!", roleId: 7 },
      42
    );
    const payload = mockCreateRbacSystemAccount.mock.calls[0][0];
    expect(payload.email).toBe("ada@corp.example");
    // No permission overrides supplied → roles[0] omits permissions.
    expect(payload.roles).toEqual([{ roleId: 7 }]);
  });

  it("(c) RBAC returns {ok:false} → employee still returned with systemAccount:failed", async () => {
    mockCreateRbacSystemAccount.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden: rbac:create required",
      code: "RBAC-403",
    });

    const result = await hrContractService.createEmployee(
      { ...baseInput, createSystemAccount: true, password: "sup3rSecret!", roleId: 7 },
      42
    );

    expect(mockEmployeeFindUnique).toHaveBeenCalled(); // employee was created
    expect(result.summary.id).toBe(101);
    expect(result.systemAccount).toEqual({
      status: "failed",
      error: "Forbidden: rbac:create required",
      httpStatus: 403,
      code: "RBAC-403",
    });
  });

  it("(c') createRbacSystemAccount THROWS → employee still returned with systemAccount:failed", async () => {
    mockCreateRbacSystemAccount.mockRejectedValue(new Error("network down"));

    const result = await hrContractService.createEmployee(
      { ...baseInput, createSystemAccount: true, password: "sup3rSecret!", roleId: 7 },
      42
    );

    expect(result.summary.id).toBe(101);
    expect(result.systemAccount).toEqual({ status: "failed", error: "network down" });
  });

  it("(d) createSystemAccount absent → no RBAC call, no systemAccount field", async () => {
    const result = await hrContractService.createEmployee({ ...baseInput }, 42);
    expect(mockCreateRbacSystemAccount).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("systemAccount");
  });

  it("(d') createSystemAccount:false → no RBAC call, no systemAccount field", async () => {
    const result = await hrContractService.createEmployee(
      { ...baseInput, createSystemAccount: false, roleId: 7, password: "sup3rSecret!" },
      42
    );
    expect(mockCreateRbacSystemAccount).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("systemAccount");
  });

  it("(e) createSystemAccount:true but missing roleId/password → skipped, no RBAC call", async () => {
    const result = await hrContractService.createEmployee(
      { ...baseInput, createSystemAccount: true },
      42
    );
    expect(mockCreateRbacSystemAccount).not.toHaveBeenCalled();
    expect(result.systemAccount).toEqual({ status: "skipped", reason: "roleId and password required" });
  });
});
