// HR-03 — deny-by-default authorization on the payroll (C4) surface.
// Before the fix, payroll routes had NO authz middleware at all, and admin was
// taken from the forgeable `x-is-admin` header. These specs pin the new rule:
// access requires the gateway-resolved `hr:payroll` permission for the method's
// action; a forged x-is-admin grants nothing; EMPLOYEE self-access is preserved
// (the controller enforces id-ownership downstream).

import { describe, it, expect, jest } from "@jest/globals";
import { requirePermission } from "../../../src/middlewares/hrContext.middleware.js";

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn((c) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn(() => res);
  return res;
}

describe("HR-03 requirePermission — payroll authz", () => {
  it("DENIES (403) when the user has no hr:payroll permission", () => {
    const req = { method: "GET", user: { permissions: {}, role: "HR_MANAGER" } };
    const res = mockRes();
    const next = jest.fn();
    requirePermission("hr:payroll")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("DENIES a forged x-is-admin with no real permission (admin bypass removed)", () => {
    const req = { method: "POST", user: { permissions: {}, isAdmin: true } };
    const res = mockRes();
    const next = jest.fn();
    requirePermission("hr:payroll")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("ALLOWS when the user holds hr:payroll for the action", () => {
    const req = { method: "GET", user: { permissions: { "hr:payroll": ["VIEW", "CREATE"] } } };
    const res = mockRes();
    const next = jest.fn();
    requirePermission("hr:payroll")(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("DENIES a held resource but wrong action (deny-by-default per action)", () => {
    // user has VIEW only; a POST (CREATE) must be denied.
    const req = { method: "POST", user: { permissions: { "hr:payroll": ["VIEW"] } } };
    const res = mockRes();
    const next = jest.fn();
    requirePermission("hr:payroll")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allowSelf lets an EMPLOYEE through (controller enforces ownership)", () => {
    const req = { method: "GET", user: { permissions: { "hr:self": ["VIEW"] }, role: "EMPLOYEE" } };
    const res = mockRes();
    const next = jest.fn();
    requirePermission("hr:payroll", { allowSelf: true })(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allowSelf still DENIES a non-EMPLOYEE without hr:payroll", () => {
    const req = { method: "GET", user: { permissions: { "hr:self": ["VIEW"] }, role: "HR_MANAGER" } };
    const res = mockRes();
    const next = jest.fn();
    requirePermission("hr:payroll", { allowSelf: true })(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
