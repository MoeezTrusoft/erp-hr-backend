// X3: who may act on whose records. Four roles, deny paths, and the odd inputs.
import { describe, it, expect } from "@jest/globals";
import { SCOPE, resolveAccessScope, mayAccessEmployee } from "../../src/lib/accessScope.js";

const R = "hr:attendance";
const employee = ["hr.attendance.read"];
const hr = ["hr.attendance.read", "hr.attendance.create", "hr.attendance.update", "hr.attendance.delete", "hr.attendance.export"];
const scope = (user, permissions, isManager = false) => resolveAccessScope({ user, permissions, resource: R, isManager });

describe("resolveAccessScope", () => {
  it("Employee sees only self", () => expect(scope({ employeeId: 7 }, employee).scope).toBe(SCOPE.SELF));
  it("a line manager with a VIEW grant gets TEAM", () => expect(scope({ employeeId: 7 }, employee, true).scope).toBe(SCOPE.TEAM));
  it("a line manager WITHOUT any grant stays SELF: the reporting line alone never opens a resource", () =>
    expect(scope({ employeeId: 7 }, [], true).scope).toBe(SCOPE.SELF));
  it("HR (write-class grant) gets ALL, with or without reports", () => {
    expect(scope({ employeeId: 9 }, hr).scope).toBe(SCOPE.ALL);
    expect(scope({ employeeId: 9 }, hr, true).scope).toBe(SCOPE.ALL);
  });
  it("any single write-class action is enough for ALL", () => {
    for (const a of ["create", "update", "delete", "export"]) expect(scope({ employeeId: 9 }, [`hr.attendance.${a}`]).scope).toBe(SCOPE.ALL);
  });
  it("verified admin claim gets ALL; a truthy non-true value does not", () => {
    expect(scope({ isAdmin: true }, []).scope).toBe(SCOPE.ALL);
    expect(scope({ employeeId: 7, isAdmin: "true" }, []).scope).toBe(SCOPE.SELF);
  });
  it("no employee identity and no write grant -> NONE", () => {
    for (const employeeId of [undefined, null, 0, -1, 1.5, "abc", NaN]) expect(scope({ employeeId }, employee, true).scope).toBe(SCOPE.NONE);
  });
  it("a grant on another resource gives nothing here", () => expect(scope({ employeeId: 7 }, ["hr.payroll.update"]).scope).toBe(SCOPE.SELF));
  it("string employee id is normalised", () => expect(scope({ employeeId: "7" }, employee).actingEmployeeId).toBe(7));
  it("legacy blob permissions work too", () => expect(scope({ employeeId: 7 }, { [R]: ["EDIT"] }).scope).toBe(SCOPE.ALL));
});

describe("mayAccessEmployee", () => {
  const base = { actingEmployeeId: 7 };
  it("ALL: any valid target, never an invalid one", () => {
    expect(mayAccessEmployee({ ...base, scope: SCOPE.ALL, targetEmployeeId: 99 })).toBe(true);
    for (const t of [0, -3, null, undefined, "x"]) expect(mayAccessEmployee({ ...base, scope: SCOPE.ALL, targetEmployeeId: t })).toBe(false);
  });
  it("TEAM: self and direct reports only", () => {
    expect(mayAccessEmployee({ ...base, scope: SCOPE.TEAM, targetEmployeeId: 7 })).toBe(true);
    expect(mayAccessEmployee({ ...base, scope: SCOPE.TEAM, targetEmployeeId: 20, targetManagerId: 7 })).toBe(true);
    expect(mayAccessEmployee({ ...base, scope: SCOPE.TEAM, targetEmployeeId: 20, targetManagerId: 8 })).toBe(false);
    expect(mayAccessEmployee({ ...base, scope: SCOPE.TEAM, targetEmployeeId: 20, targetManagerId: null })).toBe(false);
  });
  it("TEAM does not reach a report's report (one level only)", () =>
    expect(mayAccessEmployee({ ...base, scope: SCOPE.TEAM, targetEmployeeId: 30, targetManagerId: 20 })).toBe(false));
  it("SELF: only own, even if the target names the caller as manager", () => {
    expect(mayAccessEmployee({ ...base, scope: SCOPE.SELF, targetEmployeeId: 7 })).toBe(true);
    expect(mayAccessEmployee({ ...base, scope: SCOPE.SELF, targetEmployeeId: 20, targetManagerId: 7 })).toBe(false);
  });
  it("NONE and a missing actor deny everything", () => {
    expect(mayAccessEmployee({ scope: SCOPE.NONE, actingEmployeeId: 7, targetEmployeeId: 7 })).toBe(false);
    expect(mayAccessEmployee({ scope: SCOPE.SELF, actingEmployeeId: null, targetEmployeeId: 7 })).toBe(false);
  });
  it("an unknown scope value fails closed", () => expect(mayAccessEmployee({ ...base, scope: "WHATEVER", targetEmployeeId: 20, targetManagerId: 7 })).toBe(false));
});
