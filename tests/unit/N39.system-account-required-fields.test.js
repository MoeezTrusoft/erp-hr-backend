// N39: hr_employee_create accepted createSystemAccount without the phone, gender
// and hire date that rbac_employee_create requires. The login was never created,
// the worker retried with a generic reason, and the caller saw success.
// Pins (option B, backward compatible): a request without a phone is still
// accepted, but its intent is recorded as failed (HR-0305) with the reason, so
// the response explains why no login exists and the worker never retries it;
// gender, hire date and job title get the defaults the Create Employee wizard's
// helper already sends; a complete payload is unchanged.
import { describe, it, expect } from "@jest/globals";

const { buildSystemAccountProvisioningIntent, publicProvisioningState } = await import("../../src/jobs/system-account-provisioning.js");

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const employee = { id: 31, status: "Active", hire_date: new Date("2026-11-01T00:00:00.000Z") };
const base = { createSystemAccount: true, roleId: 65, firstName: "QA Dev", lastName: "02", systemEmail: "qa.dev02@test.com" };
const build = (data, emp = employee) => buildSystemAccountProvisioningIntent(data, emp, { tenantId: TENANT });

describe("N39 · system-account provisioning sends what RBAC requires", () => {
  it("accepts a request with no phone but records the intent as failed with the reason (no retries)", () => {
    const intent = build(base);
    expect(intent.status).toBe("TERMINAL_FAILED");
    expect(intent.lastErrorCode).toBe("HR-0305");
    expect(intent.lastError).toMatch(/phone/i);
    expect(publicProvisioningState({ ...intent, id: "p1" })).toMatchObject({ status: "failed", code: "HR-0305" });
  });

  it("a request with a phone is queued as before", () => {
    const intent = build({ ...base, mobilePhone: "923005550002" });
    expect(intent.status).toBe("PENDING");
    expect(intent.lastError).toBeUndefined();
  });

  it("uses mobilePhone, else workPhone", () => {
    expect(build({ ...base, mobilePhone: "923005550002" }).payload.phone).toBe("923005550002");
    expect(build({ ...base, workPhone: "4235550002" }).payload.phone).toBe("4235550002");
  });

  it("fills gender, hire date and job title with the wizard helper's defaults", () => {
    const { payload } = build({ ...base, mobilePhone: "923005550002" });
    expect(payload.gender).toBe("unspecified");
    expect(payload.job_title).toBe("Employee");
    expect(payload.hire_date).toBe("2026-11-01T00:00:00.000Z");
    const noDate = build({ ...base, mobilePhone: "1" }, { id: 32, status: "Active" }).payload.hire_date;
    expect(noDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps a complete payload exactly as before", () => {
    const { payload } = build({ ...base, mobilePhone: "923005550002", gender: "Female", hireDate: "2026-10-15", jobTitle: "Software Developer" });
    expect(payload).toMatchObject({ phone: "923005550002", gender: "Female", hire_date: "2026-10-15", job_title: "Software Developer", hrEmployeeId: 31, roles: [{ roleId: 65 }] });
  });

  it("still returns no intent when no system account is requested", () => {
    expect(buildSystemAccountProvisioningIntent({ createSystemAccount: false }, employee, { tenantId: TENANT })).toBeNull();
  });
});
