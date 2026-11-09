// X3: hr:attendance_all and hr:payroll_all are READ-ONLY, tenant-wide grants (Management).
// They must widen exactly the reads they name and nothing else.
import { describe, expect, it, jest } from "@jest/globals";
import { authorizeHrRoute } from "../../src/middlewares/routeAuthorization.middleware.js";
import { assertPermission } from "../../src/lib/assertPermission.js";
import {
  assertPayrollAdminSurface,
  assertPayrollOverviewAccess,
  resolveAttendanceReadScope,
} from "../../src/mcp/utils/actorScope.js";

const ATT = ["hr.attendance_all.read"];
const PAY = ["hr.payroll_all.read"];

describe("attendance read scope", () => {
  it("read-all lifts the own-record pin; plain read does not", () => {
    expect(resolveAttendanceReadScope({ employeeId: 5 }, ATT)).toEqual({ canViewOthers: true, employeeId: null });
    expect(resolveAttendanceReadScope({ employeeId: 5 }, ["hr.attendance.read"])).toEqual({ canViewOthers: false, employeeId: 5 });
  });
  it("read-all never grants a write", () => {
    for (const verb of ["POST", "PUT", "DELETE", "EXPORT"]) expect(() => assertPermission(ATT, verb, "hr:attendance")).toThrow(/Insufficient/);
  });
  it("the payroll grant does not widen attendance", () => {
    expect(resolveAttendanceReadScope({ employeeId: 5 }, PAY).canViewOthers).toBe(false);
  });
});

describe("payroll overview gate", () => {
  it("read-all passes the overview gate but NOT the admin surface (no salary/payslip/bank/audit reads)", () => {
    expect(() => assertPayrollOverviewAccess(PAY)).not.toThrow();
    expect(() => assertPayrollAdminSurface(PAY)).toThrow(/Insufficient/);
  });
  it("admin surface still passes; plain read, attendance read-all and nothing do not", () => {
    expect(() => assertPayrollOverviewAccess(["hr.payroll.update"])).not.toThrow();
    for (const perms of [["hr.payroll.read"], ATT, [], undefined]) expect(() => assertPayrollOverviewAccess(perms)).toThrow(/Insufficient/);
  });
  it("read-all never grants a payroll write", () => {
    for (const verb of ["POST", "PUT", "DELETE", "EXPORT"]) expect(() => assertPermission(PAY, verb, "hr:payroll")).toThrow(/Insufficient/);
  });
});

const req = (method, url, scope) => ({
  method,
  originalUrl: url,
  path: new URL(url, "http://hr.test").pathname,
  body: {},
  headers: {},
  route: { path: "/" },
  internalService: { service: "erp-gateway", claims: { sub: "erp-gateway", tid: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007", userId: 41, employeeId: 7, scope } },
});
const call = (r) => {
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  authorizeHrRoute(r, res, next);
  return { allowed: next.mock.calls.length === 1, status: res.status.mock.calls[0]?.[0] };
};

describe("REST policy", () => {
  it("attendance reads accept read-all; attendance writes do not", () => {
    expect(call(req("GET", "/api/attendance/daily", ATT[0])).allowed).toBe(true);
    expect(call(req("GET", "/api/time-attendance/summary", ATT[0])).allowed).toBe(true);
    expect(call(req("POST", "/api/attendance/manual", ATT[0]))).toEqual({ allowed: false, status: 403 });
    expect(call(req("PUT", "/api/attendance/daily", ATT[0])).allowed).toBe(false);
    expect(call(req("DELETE", "/api/attendance/daily", ATT[0])).allowed).toBe(false);
  });
  it("only the payroll run register accepts payroll read-all", () => {
    expect(call(req("GET", "/api/payroll/runs", PAY[0])).allowed).toBe(true);
    for (const url of ["/api/payroll/runs/12", "/api/payroll/payslips", "/api/payroll/runs/12/bank-file", "/api/payroll/audit-logs", "/api/payroll/employees"])
      expect(call(req("GET", url, PAY[0])).allowed).toBe(false);
    expect(call(req("POST", "/api/payroll/runs", PAY[0])).allowed).toBe(false);
  });
  it("grants do not cross areas, and plain reads still work", () => {
    expect(call(req("GET", "/api/attendance/daily", PAY[0])).allowed).toBe(false);
    expect(call(req("GET", "/api/payroll/runs", ATT[0])).allowed).toBe(false);
    expect(call(req("GET", "/api/attendance/daily", "hr.attendance.read")).allowed).toBe(true);
  });
});
