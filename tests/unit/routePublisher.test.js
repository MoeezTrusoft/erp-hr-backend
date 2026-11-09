// X1: publishing or withdrawing an approval route is a Management decision (hr.setup.approve).
// HR can draft (hr:payroll write) but cannot publish; nobody gets it from a payroll grant or the admin claim.
import { describe, expect, it, jest } from "@jest/globals";

const service = {
  getApprovalMatrix: jest.fn(async () => ({ ok: "get" })),
  saveApprovalMatrixDraft: jest.fn(async () => ({ ok: "draft" })),
  discardApprovalMatrixDraft: jest.fn(async () => ({ ok: "discard" })),
  publishApprovalMatrix: jest.fn(async () => ({ ok: "publish" })),
  retireApprovalMatrix: jest.fn(async () => ({ ok: "retire" })),
};
jest.unstable_mockModule("../../src/services/approvalMatrix.service.js", () => service);

const { assertRoutePublisher } = await import("../../src/mcp/utils/actorScope.js");
const { registerApprovalMatrixTools } = await import("../../src/mcp/tools/approvalMatrixTools.js");
const { mcpCtx } = await import("../../src/mcp/context.js");

const tools = {};
registerApprovalMatrixTools({ tool: (name, _d, _s, handler) => { tools[name] = handler; } });
const call = (name, args, { permissions, isAdmin = false }) =>
  mcpCtx.run({ user: { tenantId: "t1", userId: 5, isAdmin }, permissions }, () => tools[name](args));

const EMPLOYEE = ["hr.attendance.read"];
const HR = ["hr.payroll.read", "hr.payroll.create", "hr.payroll.update", "hr.payroll.delete", "hr.payroll.export", "hr.setup.prepare", "hr.setup.read"];
const MANAGEMENT = ["hr.approvals.approve", "hr.setup.approve", "hr.setup.read"];
const text = (r) => r.content?.[0]?.text ?? "";

describe("assertRoutePublisher", () => {
  it("passes only with hr.setup.approve", () => {
    expect(() => assertRoutePublisher(MANAGEMENT)).not.toThrow();
    for (const p of [EMPLOYEE, HR, [], undefined, null, ["hr.setup.approve.read"], ["hr.setup"], ["hr.setup.prepare"], ["hr.approvals.approve"]])
      expect(() => assertRoutePublisher(p)).toThrow(/Management approval/);
  });
  it("accepts the legacy blob form", () => {
    expect(() => assertRoutePublisher({ "hr:setup:approve": ["VIEW"] })).not.toThrow();
    expect(() => assertRoutePublisher({ "hr:setup:approve": ["EDIT"] })).toThrow();
    expect(() => assertRoutePublisher({ "hr:payroll": ["VIEW", "EDIT", "CREATE", "DELETE", "EXPORT"] })).toThrow();
  });
  it("is a 403 with the HR-4030 code", () => {
    try { assertRoutePublisher(HR); } catch (e) { expect([e.status, e.statusCode, e.code]).toEqual([403, 403, "HR-4030"]); return; }
    throw new Error("did not throw");
  });
});

describe("approval route tools", () => {
  it("HR can read and draft but cannot publish or withdraw", async () => {
    expect((await call("hr_approval_route_get", { kind: "PAYROLL" }, { permissions: HR })).isError).toBeUndefined();
    expect((await call("hr_approval_route_save_draft", { kind: "PAYROLL", levels: [] }, { permissions: HR })).isError).toBeUndefined();
    expect((await call("hr_approval_route_discard_draft", { kind: "PAYROLL" }, { permissions: HR })).isError).toBeUndefined();
    service.publishApprovalMatrix.mockClear(); service.retireApprovalMatrix.mockClear();
    for (const name of ["hr_approval_route_publish", "hr_approval_route_retire"]) {
      const r = await call(name, { kind: "PAYROLL", reason: "x" }, { permissions: HR });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Management approval/);
    }
    expect(service.publishApprovalMatrix).not.toHaveBeenCalled();
    expect(service.retireApprovalMatrix).not.toHaveBeenCalled();
  });

  it("Management can publish and withdraw, but cannot draft (no payroll write)", async () => {
    expect((await call("hr_approval_route_publish", { kind: "PAYROLL", reason: "x" }, { permissions: MANAGEMENT })).isError).toBeUndefined();
    expect((await call("hr_approval_route_retire", { kind: "PAYROLL", reason: "x" }, { permissions: MANAGEMENT })).isError).toBeUndefined();
    expect(service.publishApprovalMatrix).toHaveBeenCalledTimes(1);
    expect(service.retireApprovalMatrix).toHaveBeenCalledTimes(1);
    expect((await call("hr_approval_route_save_draft", { kind: "PAYROLL", levels: [] }, { permissions: MANAGEMENT })).isError).toBe(true);
  });

  it("the admin claim does not bypass; Employee is refused everywhere", async () => {
    service.publishApprovalMatrix.mockClear();
    expect((await call("hr_approval_route_publish", { kind: "PAYROLL", reason: "x" }, { permissions: HR, isAdmin: true })).isError).toBe(true);
    expect(service.publishApprovalMatrix).not.toHaveBeenCalled();
    for (const name of ["hr_approval_route_get", "hr_approval_route_save_draft", "hr_approval_route_publish", "hr_approval_route_retire", "hr_approval_route_discard_draft"])
      expect((await call(name, { kind: "PAYROLL", reason: "x", levels: [] }, { permissions: EMPLOYEE })).isError).toBe(true);
  });

  it("an unauthenticated call is refused", async () => {
    const r = await tools.hr_approval_route_publish({ kind: "PAYROLL", reason: "x" });
    expect(r.isError).toBe(true);
  });
});
