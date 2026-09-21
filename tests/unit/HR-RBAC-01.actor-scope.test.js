// HR-RBAC-01 — actor-scoping unit tests (T1.1/T1.2/T1.3, audit 2026-09-21).
//
// C1: hr_my_payslip with an explicit payslipId ignored employeeId for any
// VIEW-granted session — a plain employee could open ANY tenant payslip by
// id. These tests pin the fix at both layers:
//   • actorScope helper: who counts as "admin surface", who gets pinned
//   • tool layer: employee scope refuses a foreign employeeId (403) and the
//     service resolves an explicit payslipId ONLY within the caller's own
//     slips (employeeScoped where-clause)
//   • admin surface unchanged: unbound HR/admin + explicit payslipId still
//     resolves any tenant row (HR-PAYSLIP-ADMIN-VIEW-01 stays intact)
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// ── actorScope helper tests (pure, no mocks needed) ─────────────────────────
const actorScope = await import("../../src/mcp/utils/actorScope.js");

describe("HR-RBAC-01 resolveActorScope", () => {
  it("pins an employee session (VIEW-only) to the acting employee", () => {
    const scope = actorScope.resolveActorScope(
      { employeeId: 489, isAdmin: false },
      { "hr:payroll": ["VIEW"] },
    );
    expect(scope).toEqual({ actingEmployeeId: 489, canViewOthers: false });
  });

  it("treats the verified admin claim as admin surface", () => {
    const scope = actorScope.resolveActorScope({ employeeId: null, isAdmin: true }, {});
    expect(scope.canViewOthers).toBe(true);
  });

  it("recognizes payroll WRITE/EXPORT as the admin surface", () => {
    for (const actions of [["EDIT"], ["EXPORT"], ["CREATE"], ["DELETE"], ["VIEW", "EDIT"]]) {
      const scope = actorScope.resolveActorScope(
        { employeeId: null, isAdmin: false },
        { "hr:payroll": actions },
      );
      expect(scope.canViewOthers).toBe(true);
    }
  });

  it("does NOT grant admin surface off hr:attendance or hr:leave writes", () => {
    const scope = actorScope.resolveActorScope(
      { employeeId: 489, isAdmin: false },
      { "hr:attendance": ["EDIT", "CREATE"], "hr:leave": ["EDIT"] },
    );
    expect(scope.canViewOthers).toBe(false);
  });

  it("supports the dotted canonical permission form too", () => {
    const scope = actorScope.resolveActorScope(
      { employeeId: 1, isAdmin: false },
      ["hr.payroll.update"],
    );
    expect(scope.canViewOthers).toBe(true);
  });

  it("returns a null acting id for unbound sessions", () => {
    const scope = actorScope.resolveActorScope({ employeeId: null, isAdmin: false }, {});
    expect(scope.actingEmployeeId).toBeNull();
  });
});

describe("HR-RBAC-01 assertEmployeeScope", () => {
  const employee = { actingEmployeeId: 489, canViewOthers: false };
  const admin = { actingEmployeeId: null, canViewOthers: true };

  it("pins the employee to their own id and ignores their own explicit id", () => {
    expect(actorScope.assertEmployeeScope({ ...employee, explicit: 489 })).toBe(489);
    expect(actorScope.assertEmployeeScope({ ...employee, explicit: null })).toBe(489);
  });

  it("403s when an employee selects a foreign employeeId", () => {
    expect(() => actorScope.assertEmployeeScope({ ...employee, explicit: 480 })).toThrow(
      /does not belong to the acting session/,
    );
  });

  it("403s when an unbound session names any explicit employeeId", () => {
    expect(() =>
      actorScope.assertEmployeeScope({ actingEmployeeId: null, canViewOthers: false, explicit: 480 }),
    ).toThrow(/no employee is bound/);
  });

  it("400s when an employee-scope session has no binding and no explicit id", () => {
    expect(() =>
      actorScope.assertEmployeeScope({ actingEmployeeId: null, canViewOthers: false, explicit: null }),
    ).toThrow(/no employee bound/);
  });

  it("admin surface keeps explicit-wins and unbound null semantics", () => {
    expect(actorScope.assertEmployeeScope({ ...admin, explicit: 480 })).toBe(480);
    expect(actorScope.assertEmployeeScope({ ...admin, explicit: null })).toBeNull();
  });

  it("allowUnbound lets an employee-scope unbound session pass null (row decides)", () => {
    expect(
      actorScope.assertEmployeeScope({
        actingEmployeeId: null,
        canViewOthers: false,
        explicit: null,
        allowUnbound: true,
      }),
    ).toBeNull();
  });
});

// ── tool-layer tests: employee scope refuses foreign selection ──────────────
const getMyPayslip = jest.fn(async (args) => ({ payslipId: args.payslipId ?? "latest", employeeId: args.employeeId }));
const getPayslipDistribution = jest.fn(async () => ({ gross: 1 }));
const getEarningTrend6mo = jest.fn(async () => ({ months: [] }));
const listMyPayslips = jest.fn(async () => ({ items: [] }));
const questionPayslip = jest.fn(async (args) => ({ payslipId: args.payslipId }));

jest.unstable_mockModule("../../src/services/myPayslip.service.js", () => ({
  getMyPayslip,
  getPayslipDistribution,
  getEarningTrend6mo,
  listMyPayslips,
  questionPayslip,
}));

const assertPermissionMock = jest.fn();
const realAssertPermission = await import("../../src/mcp/utils/assertPermission.js");
jest.unstable_mockModule("../../src/mcp/utils/assertPermission.js", () => ({
  hasPermission: realAssertPermission.hasPermission,
  assertPermission: assertPermissionMock,
}));

function makeCtx(user, permissions) {
  return { user, permissions };
}
let ctx;
jest.unstable_mockModule("../../src/mcp/context.js", () => ({
  mcpCtx: { getStore: () => ctx },
}));
jest.unstable_mockModule("../../src/mcp/utils/toolError.js", () => ({
  withToolError: (fn) => fn,
}));

const { registerMyPayslipTools } = await import("../../src/mcp/tools/myPayslipTools.js");

function makeServer() {
  const tools = new Map();
  return {
    tools,
    tool: (name, _desc, schema, handler) => tools.set(name, { schema, handler }),
  };
}

const EMPLOYEE_VIEW = { "hr:payroll": ["VIEW"], "hr:self": ["VIEW"] };
const HR_EDIT = { "hr:payroll": ["VIEW", "EDIT"] };

let server;
beforeEach(() => {
  jest.clearAllMocks();
  server = makeServer();
  registerMyPayslipTools(server);
});

describe("HR-RBAC-01 hr_my_payslip tool scoping", () => {
  it("employee + own payslipId resolves inside own slips (employeeScoped flag set)", async () => {
    ctx = makeCtx({ employeeId: 489, tenantId: "t1", isAdmin: false }, EMPLOYEE_VIEW);
    await server.tools.get("hr_my_payslip").handler({ payslipId: 370 });
    expect(getMyPayslip).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 489, payslipId: 370, employeeScoped: true }),
    );
  });

  it("employee + foreign payslipId is still scoped (service where-clause decides, no 403 leak)", async () => {
    ctx = makeCtx({ employeeId: 489, tenantId: "t1", isAdmin: false }, EMPLOYEE_VIEW);
    await server.tools.get("hr_my_payslip").handler({ payslipId: 374 });
    expect(getMyPayslip).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 489, payslipId: 374, employeeScoped: true }),
    );
  });

  it("employee + foreign employeeId argument is refused 403", async () => {
    ctx = makeCtx({ employeeId: 489, tenantId: "t1", isAdmin: false }, EMPLOYEE_VIEW);
    await expect(
      server.tools.get("hr_my_payslip").handler({ employeeId: 480 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(getMyPayslip).not.toHaveBeenCalled();
  });

  it("unbound admin (HR) + explicit payslipId keeps admin-view semantics", async () => {
    ctx = makeCtx({ employeeId: null, tenantId: "t1", isAdmin: true }, {});
    await server.tools.get("hr_my_payslip").handler({ payslipId: 374 });
    expect(getMyPayslip).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: null, payslipId: 374, employeeScoped: false }),
    );
  });

  it("HR with payroll EDIT + explicit employeeId override keeps working", async () => {
    ctx = makeCtx({ employeeId: null, tenantId: "t1", isAdmin: false }, HR_EDIT);
    await server.tools.get("hr_my_earning_trend").handler({ employeeId: 480 });
    expect(getEarningTrend6mo).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 480 }),
    );
  });

  it("employee trend/list are pinned to the acting employee", async () => {
    ctx = makeCtx({ employeeId: 489, tenantId: "t1", isAdmin: false }, EMPLOYEE_VIEW);
    await server.tools.get("hr_my_earning_trend").handler({});
    expect(getEarningTrend6mo).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 489 }));
    // A foreign employeeId on the list call is refused before any read runs.
    await expect(
      server.tools.get("hr_my_payslips_list").handler({ employeeId: "480" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(listMyPayslips).not.toHaveBeenCalled();
  });

  it("distribution tool passes the scoping flag through", async () => {
    ctx = makeCtx({ employeeId: 489, tenantId: "t1", isAdmin: false }, EMPLOYEE_VIEW);
    await server.tools.get("hr_my_payslip_distribution").handler({ payslipId: 374 });
    expect(getPayslipDistribution).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 489, payslipId: 374, employeeScoped: true }),
    );
  });
});
