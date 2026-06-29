// tests/unit/hrContractCreateEmployee.event.test.js
//
// ARCH-01 §7–§8 (outbox/events) + P2/T-P2.2/T-P2.6 (tenant) — capstone-proven
// hr_employee_create defect on the MCP CONTRACT create path
// (hrContract.service.js::createEmployee, used by the hr_employee_create tool):
//
//   (1) it persists an Employee but emits NO hr.employee.lifecycle.v1
//       EventEnvelope — nothing reaches the outbox / hr:events stream;
//   (2) the created row carries a BLANK tenant_id (the verified user.tenantId
//       from the request context / service-JWT claim is not threaded in);
//   (3) the persisted status is BLANK though the API returns "Active".
//
// These tests drive the SERVICE path with a mocked Prisma (incl. an outboxEvent
// writer) to prove the fix:
//   - exactly ONE hr.employee.lifecycle.v1 EventEnvelope is enqueued IN-TX,
//   - the verified ctx.tenantId is written to Employee.tenant_id AND carried on
//     the event envelope/payload,
//   - the effective status is persisted (not left blank),
//   - tenant comes ONLY from the verified claim, never the request body.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockEmployeeCreate = jest.fn();
const mockEmployeeFindUnique = jest.fn();
const mockPositionFindUnique = jest.fn();
const mockRegionFindUnique = jest.fn();
const mockEmergencyCreateMany = jest.fn();
const mockMediaCreateMany = jest.fn();
const mockOutboxCreate = jest.fn();
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();

const prismaMock = {
  employee: { create: mockEmployeeCreate, findUnique: mockEmployeeFindUnique },
  position: { findUnique: mockPositionFindUnique },
  region: { findUnique: mockRegionFindUnique },
  emergencyContacts: { createMany: mockEmergencyCreateMany },
  employeeMedia: { createMany: mockMediaCreateMany },
  outboxEvent: { create: mockOutboxCreate },
  $transaction: mockTransaction,
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaMock }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));

const hrContractService = await import("../../src/services/hrContract.service.js");

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const HR_EMPLOYEE_LIFECYCLE_V1 = "hr.employee.lifecycle.v1";

const CREATED = {
  id: 101,
  first_name: "Ada",
  last_name: "Lovelace",
  employee_code: "E-101",
  tenant_id: TENANT,
  status: "Active",
  hire_date: new Date("2026-06-24"),
};

describe("hrContract.createEmployee — lifecycle event + tenant (ARCH-01 §7–§8 / T-P2.2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (cb) => cb(prismaMock));
    // create returns the row the in-tx mapper sees (so the event mapper has a tenant)
    mockEmployeeCreate.mockImplementation(async ({ data }) => ({
      id: 101,
      tenant_id: data.tenant_id ?? null,
      employee_code: data.employee_code ?? null,
      first_name: data.first_name ?? null,
      last_name: data.last_name ?? null,
      employee_name: data.employee_name ?? null,
      businessUnitId: data.businessUnitId ?? null,
      positionId: data.positionId ?? null,
      status: data.status ?? null,
      hire_date: data.hire_date ?? null,
      work_email: data.work_email ?? null,
    }));
    mockEmployeeFindUnique.mockResolvedValue(CREATED);
    mockOutboxCreate.mockImplementation(async (args) => ({ id: "outbox-1", ...args.data }));
  });

  it("threads the verified ctx.tenantId into Employee.tenant_id (never null)", async () => {
    await hrContractService.createEmployee(
      { firstName: "Ada", lastName: "Lovelace" },
      42,
      { tenantId: TENANT, correlationId: "corr-1" }
    );

    expect(mockEmployeeCreate).toHaveBeenCalledTimes(1);
    expect(mockEmployeeCreate.mock.calls[0][0].data.tenant_id).toBe(TENANT);
  });

  it("enqueues exactly one hr.employee.lifecycle.v1 EventEnvelope IN-TX with the tenant + correlation", async () => {
    await hrContractService.createEmployee(
      { firstName: "Ada", lastName: "Lovelace" },
      42,
      { tenantId: TENANT, correlationId: "corr-42" }
    );

    expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
    const row = mockOutboxCreate.mock.calls[0][0].data;
    expect(row.eventName).toBe(HR_EMPLOYEE_LIFECYCLE_V1);
    expect(row.aggregateType).toBe("Employee");
    expect(row.tenantId).toBe(TENANT);
    // payload is the EventEnvelope (validate-before-write)
    expect(row.payload.name).toBe(HR_EMPLOYEE_LIFECYCLE_V1);
    expect(row.payload.tenantId).toBe(TENANT);
    expect(row.payload.correlationId).toBe("corr-42");
    expect(row.payload.payload.phase).toBe("hired");
    expect(row.payload.payload.tenantId).toBe(TENANT);
  });

  it("persists the effective status (not blank) — defaults to Active when none supplied", async () => {
    await hrContractService.createEmployee(
      { firstName: "Ada", lastName: "Lovelace" },
      42,
      { tenantId: TENANT, correlationId: "corr-1" }
    );

    const written = mockEmployeeCreate.mock.calls[0][0].data;
    expect(written.status).toBe("Active");
    expect(written.employement_status).toBe("Active");
  });

  it("takes tenant ONLY from the verified claim — a tenant in the request body is ignored", async () => {
    await hrContractService.createEmployee(
      { firstName: "Ada", lastName: "Lovelace", tenant_id: "00000000-0000-4000-8000-000000000000", tenantId: "spoofed" },
      42,
      { tenantId: TENANT, correlationId: "corr-1" }
    );

    expect(mockEmployeeCreate.mock.calls[0][0].data.tenant_id).toBe(TENANT);
    expect(mockOutboxCreate.mock.calls[0][0].data.tenantId).toBe(TENANT);
  });

  it("fails closed: no verified tenant => no event enqueued (aggregate write still proceeds)", async () => {
    await hrContractService.createEmployee(
      { firstName: "Ada", lastName: "Lovelace" },
      42,
      {} // no tenant in ctx
    );

    expect(mockEmployeeCreate).toHaveBeenCalledTimes(1);
    expect(mockOutboxCreate).not.toHaveBeenCalled();
  });
});
