// F-07 / ARCH-00 P-02 / ARCH-05 §7.1 / ARCH-06 §9.1
import { describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";

const payrollService = {
  getEmployeePayrollData: jest.fn(async () => ({ id: 1 })),
  getPayslipById: jest.fn(async () => ({ id: 9, employeeId: 7 })),
  getEmployeePayslips: jest.fn(async () => ({ items: [] })),
};

jest.unstable_mockModule("../../src/services/payrollService.js", () => payrollService);
jest.unstable_mockModule("../../src/services/bankFileService.js", () => ({}));
jest.unstable_mockModule("../../src/lib/c4Access.js", () => ({ auditC4Read: jest.fn() }));
jest.unstable_mockModule("../../src/utils/httpError.js", () => ({
  respondServerError: jest.fn((_req, res, error) => res.status(500).json({ error: error.message })),
  respondPreconditionAware: jest.fn(() => false),
}));

const payroll = await import("../../src/controllers/payrollController.js");
const { authorizeHrRoute } = await import("../../src/middlewares/routeAuthorization.middleware.js");
const { runController } = await import("../../src/mcp/controllers/_runner.js");
const selfMcp = await import("../../src/mcp/controllers/selfMcpController.js");

const response = () => {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn(() => res);
  return res;
};

const signedRequest = ({ employeeId = 7, userId = 501 } = {}) => ({
  method: "GET",
  originalUrl: "/api/employee",
  path: "/api/employee",
  route: { path: "/" },
  headers: {},
  body: {},
  internalService: {
    tenantId: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007",
    claims: {
      sub: "erp-gateway",
      tid: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007",
      userId,
      employeeId,
      roles: ["EMPLOYEE"],
      scope: "hr.employee.read",
    },
  },
});

describe("F-07 signed employee actor identity", () => {
  it("establishes distinct signed userId and employeeId fields without req.user.id", () => {
    const req = signedRequest();
    const res = response();
    const next = jest.fn();

    authorizeHrRoute(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ userId: 501, employeeId: 7 });
    expect(req.user).not.toHaveProperty("id");
  });

  it("the MCP controller runner preserves both namespaces without synthesizing id", async () => {
    let observed;
    await runController(async (req, res) => {
      observed = req.user;
      res.json({ success: true });
    }, { user: { userId: 501, employeeId: 7, roles: ["EMPLOYEE"] } });

    expect(observed).toMatchObject({ userId: 501, employeeId: 7 });
    expect(observed).not.toHaveProperty("id");
  });

  it.each([
    ["payroll data", payroll.getEmployeePayrollData, { employeeId: "7" }],
    ["employee payslips", payroll.getEmployeePayslips, { employeeId: "7" }],
  ])("uses employeeId, not RBAC userId, for own %s", async (_label, controller, params) => {
    const req = {
      params,
      query: {},
      user: { userId: 501, employeeId: 7, role: "EMPLOYEE", tenantId: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007" },
    };
    const res = response();

    await controller(req, res);

    expect(res.statusCode).toBe(200);
  });

  it("compares payslip ownership only against the HR employee ID", async () => {
    const req = {
      params: { id: "9" },
      user: { userId: 7, employeeId: 8, role: "EMPLOYEE", tenantId: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007" },
    };
    const res = response();

    await payroll.getPayslipById(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("denies self-service for an account with no employee link instead of using userId", async () => {
    await expect(selfMcp.mcpGetSelfAttendance({
      userId: 7,
      employeeId: null,
      roles: ["EMPLOYEE"],
    })).rejects.toThrow(expect.objectContaining({ status: 403, code: "HR-0701" }));
  });

  it("keeps listed self and ownership paths free of ambiguous req.user.id", () => {
    const files = [
      "payrollController.js",
      "leave.controller.js",
      "timesheetController.js",
      "timeEntryController.js",
      "workScheduleController.js",
      "overtimeController.js",
      "log.controller.js",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`../../src/controllers/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/req\.user\??\.id\b/);
    }
  });

  it("does not substitute RBAC userId for employeeId in related MCP self paths", () => {
    const files = [
      "../../src/mcp/controllers/selfMcpController.js",
      "../../src/mcp/controllers/onboardingMcpController.js",
      "../../src/mcp/controllers/employeeMcpController.js",
      "../../src/mcp/tools/attendanceTools.js",
      "../../src/mcp/tools/employeeTools.js",
      "../../src/mcp/tools/overtimeShiftTools.js",
      "../../src/mcp/tools/shiftTemplateSwapTools.js",
      "../../src/utils/logs.js",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/employeeId\s*(?:\|\||\?\?)\s*(?:user\??\.)?userId/);
      expect(source).not.toMatch(/employeeId\s*\?\?\s*userId/);
    }
  });
});
