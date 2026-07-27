// F-02 / ARCH-00 P-02 / ARCH-01 §4.3 / ARCH-06 §6
// The service credential authenticates the calling service; it is not a grant
// to every HR record. These tests pin the authoritative REST authorization
// boundary and its explicit employee-ownership and service-principal rules.

import { describe, expect, it, jest } from "@jest/globals";
import express from "express";
import {
  authorizeHrRoute,
  protectHrRouter,
  routeProtectionCoverage,
} from "../../../src/middlewares/routeAuthorization.middleware.js";
import { establishTenantContext } from "../../../src/middlewares/tenantContext.middleware.js";
import { mcpCtx } from "../../../src/mcp/context.js";

const response = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const request = ({
  method = "GET",
  url = "/api/employee",
  scope = "",
  claims = {},
  headers = {},
  body = {},
  knownRoute = true,
} = {}) => ({
  method,
  originalUrl: url,
  path: new URL(url, "http://hr.test").pathname,
  body,
  headers,
  route: knownRoute ? { path: "/" } : undefined,
  internalService: {
    service: claims.sub || "erp-gateway",
    claims: {
      sub: "erp-gateway",
      tid: "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007",
      userId: 41,
      employeeId: 7,
      scope,
      ...claims,
    },
  },
});

const run = (req) => {
  const res = response();
  const next = jest.fn();
  authorizeHrRoute(req, res, next);
  return { res, next };
};

describe("F-02 centralized HR REST authorization", () => {
  it("denies an authenticated gateway call with no authoritative grant", () => {
    const { res, next } = run(request());
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("ignores forged forwarded permission and admin headers", () => {
    const req = request({
      headers: {
        "x-is-admin": "true",
        "x-user-permissions": JSON.stringify({ "hr:employee": ["VIEW"] }),
      },
    });
    const { res, next } = run(req);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("replaces the pre-authorization ALS identity with the signed actor", () => {
    const req = request({
      scope: "hr.employee.read",
      claims: {
        userId: 41,
        employeeId: 7,
        email: "signed@example.test",
        roles: ["EMPLOYEE"],
      },
      headers: {
        "x-user-id": "999",
        "x-employee-id": "999",
        "x-user-email": "forged@example.test",
        "x-user-roles": JSON.stringify(["SUPER_ADMIN"]),
        "x-user-permissions": JSON.stringify(["hr.payroll.approve"]),
      },
    });
    req.user = {
      userId: 999,
      employeeId: 999,
      email: "forged@example.test",
      roles: ["SUPER_ADMIN"],
      permissions: ["hr.payroll.approve"],
      tenantId: req.internalService.claims.tid,
    };
    const res = response();
    let store;

    establishTenantContext(req, res, () => {
      authorizeHrRoute(req, res, () => { store = mcpCtx.getStore(); });
    });

    expect(store.actorVerified).toBe(true);
    expect(store.user).toMatchObject({
      userId: 41,
      employeeId: 7,
      email: "signed@example.test",
      roles: ["EMPLOYEE"],
      tenantId: req.internalService.claims.tid,
    });
    expect(store.permissions).toEqual(["hr.employee.read"]);
    expect(JSON.stringify(store)).not.toContain("forged@example.test");
    expect(JSON.stringify(store)).not.toContain("SUPER_ADMIN");
    expect(JSON.stringify(store)).not.toContain("hr.payroll.approve");
  });

  it("allows the exact canonical permission and rejects a wrong action", () => {
    expect(run(request({ scope: "hr.employee.read" })).next).toHaveBeenCalledTimes(1);

    const denied = run(request({ method: "POST", scope: "hr.employee.read" }));
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.status).toHaveBeenCalledWith(403);
  });

  it.each([
    ["GET", "/api/recruitment/candidates", "hr.recruitment.read"],
    ["POST", "/api/training/courses", "hr.training.create"],
    ["GET", "/api/performance/9", "hr.performance.read"],
    ["PUT", "/api/reimbursements/4/approve", "hr.reimbursement.approve"],
    ["PUT", "/api/leaves/requests/4/approve", "hr.leave.approve"],
    ["POST", "/api/payroll/runs", "hr.payroll.run"],
    ["PUT", "/api/payroll/runs/2/approve", "hr.payroll.approve"],
    ["PUT", "/api/payroll/runs/2/finalize", "hr.payroll.post"],
    ["GET", "/api/payroll/runs/2/bank-file", "hr.payroll.export"],
  ])("maps %s %s to exact semantic permission %s", (method, url, permission) => {
    expect(run(request({ method, url, scope: permission })).next).toHaveBeenCalledTimes(1);
    const wrong = run(request({ method, url, scope: `${permission}.wrong` }));
    expect(wrong.next).not.toHaveBeenCalled();
    expect(wrong.res.status).toHaveBeenCalledWith(403);
  });

  it("denies an unknown route/action mapping even when scope is broad", () => {
    const { res, next } = run(request({
      url: "/api/employee/not-a-declared-route",
      scope: "hr.employee.read hr.employee.create",
      knownRoute: false,
    }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("preserves attendance self-service only for the verified employee", () => {
    const own = run(request({
      method: "POST",
      url: "/api/attendance/checkin",
      scope: "hr.attendance.self",
      body: { employeeId: 7 },
    }));
    expect(own.next).toHaveBeenCalledTimes(1);

    const other = run(request({
      method: "POST",
      url: "/api/attendance/checkin",
      scope: "hr.attendance.self",
      body: { employeeId: 8 },
    }));
    expect(other.next).not.toHaveBeenCalled();
    expect(other.res.status).toHaveBeenCalledWith(403);
  });

  it("enforces body ownership for leave self-service", () => {
    const own = run(request({
      method: "POST",
      url: "/api/leaves/requests",
      scope: "hr.leave.self",
      body: { employeeId: 7 },
    }));
    expect(own.next).toHaveBeenCalledTimes(1);

    const other = run(request({
      method: "POST",
      url: "/api/leaves/requests",
      scope: "hr.leave.self",
      body: { employeeId: 8 },
    }));
    expect(other.next).not.toHaveBeenCalled();
    expect(other.res.status).toHaveBeenCalledWith(403);
  });

  it("declares controller ownership for opaque payslip ids", () => {
    const own = run(request({
      url: "/api/payroll/payslips/99",
      scope: "hr.payroll.self",
      claims: { roles: ["EMPLOYEE"] },
    }));
    expect(own.next).toHaveBeenCalledTimes(1);

    const unsignedRole = run(request({
      url: "/api/payroll/payslips/99",
      scope: "hr.payroll.self",
    }));
    expect(unsignedRole.next).not.toHaveBeenCalled();
    expect(unsignedRole.res.status).toHaveBeenCalledWith(403);
  });

  it("allows only the explicitly declared service principal route", () => {
    const job = request({
      method: "POST",
      url: "/api/leaves/accruals/run",
      scope: "hr.leave.run",
      claims: { sub: "svc:hr-jobs", userId: null, employeeId: null },
    });
    expect(run(job).next).toHaveBeenCalledTimes(1);

    job.originalUrl = "/api/employee";
    job.path = "/api/employee";
    const denied = run(job);
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.status).toHaveBeenCalledWith(403);
  });
});

describe("F-02 structural route coverage", () => {
  it("wraps every route in nested routers and reports no uncovered endpoint", () => {
    const child = express.Router();
    child.get("/:id", (_req, _res) => {});
    child.post("/", (_req, _res) => {});

    const root = express.Router();
    root.get("/summary", (_req, _res) => {});
    root.route("/multi")
      .get((_req, _res) => {})
      .post((_req, _res) => {});
    root.use("/children", child);

    protectHrRouter(root);
    expect(routeProtectionCoverage(root)).toEqual({ declared: 5, protected: 5 });
  });
});
