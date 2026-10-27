// HR-RBAC-01 — service-layer pin: resolvePayslip's employeeScoped where-clause.
//
// Standalone file because it mocks the ENTIRE prisma module, which would bleed
// into every other test in a shared file. Pins the actual IDOR fix (T1.2): an
// explicit payslipId lookup by an employee-scoped session carries employeeId in
// the where-clause, so a foreign slip id 404s instead of resolving. Admin-view
// lookups (employeeScoped=false) keep the row-wide semantics of
// HR-PAYSLIP-ADMIN-VIEW-01.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

let findFirst;
let findMany;
let questionCreate;
let svc;

// The fake slip the mocked prisma "finds" — with earnings so getMyPayslip's
// enrichment path (YTD/leave/overtime prisma calls) resolves.
const FAKE_SLIP = {
  id: 374,
  employeeId: 489,
  grossAmount: "500000",
  netAmount: "478935",
  totalDeductions: "21065",
  status: "DISTRIBUTED",
  created_at: new Date("2026-09-01"),
  payrollRun: { periodStart: new Date("2026-08-01"), periodEnd: new Date("2026-08-31") },
  earnings: [],
  deductions: [],
};

beforeEach(async () => {
  jest.resetModules();
  findFirst = jest.fn(async () => FAKE_SLIP);
  findMany = jest.fn(async () => []);
  questionCreate = jest.fn(async ({ data }) => ({ id: 11, ...data }));
  const dbish = () => ({
    findFirst: findFirst,
    findMany: findMany,
    count: jest.fn(async () => 0),
  });
  jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
    default: {
      payrollPayslip: dbish(),
      leaveRequest: dbish(),
      overtimeRequest: dbish(),
      $transaction: jest.fn(),
    },
  }));
  jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: { warn: jest.fn() } }));
  jest.unstable_mockModule("../../src/lib/tenancy.js", () => ({
    scopedWhere: (tenantId, extra) => ({ tenantId, ...extra }),
    scopedEmployeeWhere: (tenantId, extra) => ({ tenantId, ...extra }),
  }));
  jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: jest.fn((_db, fn) => fn({
      payrollPayslip: { findFirst },
      payslipQuestion: { create: questionCreate },
    })),
  }));
  jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: jest.fn(),
  }));
  jest.unstable_mockModule("../../src/services/hrEvents.js", () => ({
    payslipQuestionRaisedEvent: jest.fn(),
  }));
  svc = await import("../../src/services/myPayslip.service.js");
});

describe("HR-RBAC-01 resolvePayslip employeeScoped where-clause", () => {
  it("narrows an explicit payslipId lookup to the caller when employeeScoped", async () => {
    await svc.getMyPayslip({ tenantId: "t1", employeeId: 489, payslipId: 374, employeeScoped: true });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 374, employeeId: 489 }),
      }),
    );
  });

  it("keeps admin-view row-wide lookup when NOT employeeScoped", async () => {
    await svc.getMyPayslip({ tenantId: "t1", employeeId: null, payslipId: 374, employeeScoped: false });
    const call = findFirst.mock.calls.at(-1)[0];
    expect(call.where).toEqual(expect.objectContaining({ id: 374 }));
    expect(call.where).not.toHaveProperty("employeeId");
  });

  it("keeps the latest-slip path keyed on employeeId in both modes", async () => {
    await svc.getMyPayslip({ tenantId: "t1", employeeId: 489, employeeScoped: true });
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ employeeId: 489 }),
      }),
    );
    await svc.getMyPayslip({ tenantId: "t1", employeeId: 480, employeeScoped: false });
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ employeeId: 480 }),
      }),
    );
  });

  it("distribution respects the same scoping flag", async () => {
    await svc.getPayslipDistribution({ tenantId: "t1", employeeId: 489, payslipId: 374, employeeScoped: true });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 374, employeeId: 489 }),
      }),
    );
  });
});

describe("D-05 employees never see DRAFT or HOLD payslips", () => {
  const RELEASED = { in: ["FINALIZED", "DISTRIBUTED"] };

  it("limits the employee's latest and explicit slip to finalized statuses", async () => {
    await svc.getMyPayslip({ tenantId: "t1", employeeId: 489, employeeScoped: true });
    expect(findFirst.mock.calls.at(-1)[0].where.status).toEqual(RELEASED);
    await svc.getMyPayslip({ tenantId: "t1", employeeId: 489, payslipId: 374, employeeScoped: true });
    expect(findFirst.mock.calls.at(-1)[0].where.status).toEqual(RELEASED);
  });

  it("keeps every status visible on the admin surface", async () => {
    await svc.getMyPayslip({ tenantId: "t1", employeeId: null, payslipId: 374, employeeScoped: false });
    expect(findFirst.mock.calls.at(-1)[0].where).not.toHaveProperty("status");
  });

  it("filters the employee's payslip list the same way", async () => {
    await svc.listMyPayslips({ tenantId: "t1", employeeId: 489, employeeScoped: true });
    expect(findMany.mock.calls.at(-1)[0].where.status).toEqual(RELEASED);
    await svc.listMyPayslips({ tenantId: "t1", employeeId: 489 });
    expect(findMany.mock.calls.at(-1)[0].where).not.toHaveProperty("status");
  });
});

describe("D-08 payslip questions", () => {
  it("writes only model fields and pins an employee to their own released slip", async () => {
    await svc.questionPayslip({ tenantId: "t1", employeeId: 489, payslipId: 374, question: "Why is tax higher?", employeeScoped: true });
    expect(findFirst.mock.calls.at(-1)[0].where).toEqual(
      expect.objectContaining({ id: 374, employeeId: 489, status: { in: ["FINALIZED", "DISTRIBUTED"] } }),
    );
    expect(Object.keys(questionCreate.mock.calls[0][0].data).sort()).toEqual(
      ["employeeId", "payslipId", "question", "status", "tenantId"],
    );
  });

  it("refuses an unbound employee-scoped session", async () => {
    findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.questionPayslip({ tenantId: "t1", employeeId: null, payslipId: 374, question: "?", employeeScoped: true }),
    ).rejects.toMatchObject({ status: 404 });
    expect(findFirst.mock.calls.at(-1)[0].where.employeeId).toBe(-1);
    expect(questionCreate).not.toHaveBeenCalled();
  });
});

describe("D-18 past payslips report credit and delivery separately", () => {
  it("uses the reconciled paid date for receivedOn", async () => {
    const paidAt = new Date("2026-10-01T10:00:00Z");
    const distributedAt = new Date("2026-09-30T08:00:00Z");
    findMany.mockResolvedValueOnce([{ id: 374, netAmount: "90", status: "DISTRIBUTED", paidAt, distributedAt, payrollRun: {} }]);
    const { items } = await svc.listMyPayslips({ tenantId: "t1", employeeId: 489, employeeScoped: true });
    expect(items[0]).toMatchObject({ receivedOn: paidAt, distributedAt });
  });
});
