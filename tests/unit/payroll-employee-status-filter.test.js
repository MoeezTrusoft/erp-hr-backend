// D-19: the employees register filters by the same status labels it displays.
// The tool used to accept "disbursed" while the service mapped "distributed",
// so that filter was silently ignored, and "finalized" could not be filtered.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { z } from "zod";

const findMany = jest.fn(async () => []);
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: {
    payrollRun: { findFirst: jest.fn(async () => ({ id: 7, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30") })) },
    payrollPayslip: { findMany },
  },
}));

const { listPayrollEmployees } = await import("../../src/services/payrollDashboard.service.js");
const { registerPayrollDashboardTools } = await import("../../src/mcp/tools/payrollDashboardTools.js");

const schemas = new Map();
registerPayrollDashboardTools({ tool: (name, _description, schema) => schemas.set(name, z.object(schema)) });
const toolArgs = schemas.get("hr_payroll_employees_list");

beforeEach(() => findMany.mockClear());

describe("payroll employees status filter", () => {
  it.each([
    ["pending", "DRAFT"],
    ["approved", "APPROVED"],
    ["hold", "HOLD"],
    ["finalized", "FINALIZED"],
    ["distributed", "DISTRIBUTED"],
    ["disbursed", "DISTRIBUTED"],
  ])("accepts %s at the tool and filters on %s", async (label, status) => {
    expect(toolArgs.safeParse({ runId: 7, status: label }).success).toBe(true);
    await listPayrollEmployees({ tenantId: "company", runId: 7, status: label });
    expect(findMany.mock.calls[0][0].where.status).toBe(status);
  });

  it("rejects an unknown label at the tool instead of ignoring it", () => {
    expect(toolArgs.safeParse({ runId: 7, status: "paid" }).success).toBe(false);
  });
});
