// BLOCKER-1 / BLOCKER-2 (HR seed-verify, live) — tenant-leak regression.
//
// The HR seed-verify proved hr_employees_list returned ~78 FOREIGN/null-tenant
// rows and hr_attendance_list returned null-tenant junk. Root cause: the
// hrContract.listEmployees where had NO tenant predicate and the attendance
// list controller never threaded the verified tenant into its (tenant-aware)
// service. These tests drive the SERVICE path with a Prisma fake that ACTUALLY
// filters its in-memory dataset by the tenant predicate the service builds, so
// a foreign-tenant (or null-tenant) row is provably NOT returned.
//
// Employee carries the snake_case `tenant_id` column (REQ-007); the C.2 tables
// (Attendance, …) carry camelCase `tenantId`.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT_A = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const TENANT_B = "b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a";

// ── in-memory datasets: tenant A + a foreign tenant B + a null-tenant row ──────
const EMPLOYEES = [
  { id: 1, employee_code: "A-1", employee_name: "Alice A", status: "Active", tenant_id: TENANT_A },
  { id: 2, employee_code: "A-2", employee_name: "Anna A", status: "Active", tenant_id: TENANT_A },
  { id: 3, employee_code: "B-1", employee_name: "Bob B", status: "Active", tenant_id: TENANT_B },
  { id: 4, employee_code: "N-1", employee_name: "Null N", status: "Active", tenant_id: null },
];

const ATTENDANCE = [
  { id: 11, employeeId: 1, tenantId: TENANT_A, status: "PRESENT", date: new Date() },
  { id: 12, employeeId: 3, tenantId: TENANT_B, status: "PRESENT", date: new Date() },
  { id: 13, employeeId: 4, tenantId: null, status: "ABSENT", date: new Date() },
];

// Pull the tenant value the service folded into `where` (directly or nested in
// AND) for the given column. `undefined` ⇒ no scope was requested.
function tenantFromWhere(where, col) {
  if (!where || typeof where !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(where, col)) return where[col];
  if (Array.isArray(where.AND)) {
    for (const w of where.AND) {
      const v = tenantFromWhere(w, col);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function filterByTenant(rows, where, col) {
  const t = tenantFromWhere(where, col);
  if (t === undefined) return rows; // legacy unscoped path
  return rows.filter((r) => r[col] === t);
}

const prismaMock = {
  employee: {
    findMany: jest.fn(async ({ where }) => filterByTenant(EMPLOYEES, where, "tenant_id")),
    count: jest.fn(async ({ where }) => filterByTenant(EMPLOYEES, where, "tenant_id").length),
    findFirst: jest.fn(async ({ where }) => {
      const scoped = filterByTenant(EMPLOYEES, where, "tenant_id");
      const id = where?.id;
      return scoped.find((r) => (id == null ? true : r.id === id)) || null;
    }),
  },
  attendance: {
    findMany: jest.fn(async ({ where }) => filterByTenant(ATTENDANCE, where, "tenantId")),
  },
};
prismaMock.$transaction = jest.fn(async (arg) =>
  typeof arg === "function" ? arg(prismaMock) : Promise.all(arg)
);

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaMock }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));

const hrContract = await import("../../src/services/hrContract.service.js");
const attendanceSvc = await import("../../src/services/attendance.service.js");

beforeEach(() => {
  for (const fn of Object.values(prismaMock.employee)) fn.mockClear?.();
  prismaMock.attendance.findMany.mockClear();
});

describe("BLOCKER-1 — hr_employees_list is tenant-scoped (no foreign/null-tenant leak)", () => {
  it("returns ONLY tenant A's employees; excludes tenant B and null-tenant rows", async () => {
    const res = await hrContract.listEmployees({ page: 1, pageSize: 50 }, TENANT_A);
    const codes = res.items.map((e) => e.code);

    expect(codes).toEqual(expect.arrayContaining(["A-1", "A-2"]));
    expect(codes).not.toContain("B-1"); // foreign tenant
    expect(codes).not.toContain("N-1"); // null tenant
    expect(res.total).toBe(2);
  });

  it("getEmployeeProfile resolves not-found for a cross-tenant employee id", async () => {
    await expect(hrContract.getEmployeeProfile(3, TENANT_A)).rejects.toThrow(/not found/i);
    expect(await hrContract.getEmployeeProfile(1, TENANT_A)).toBeTruthy();
  });
});

describe("BLOCKER-2 — hr_attendance_list is tenant-scoped (no foreign/null-tenant leak)", () => {
  it("returns ONLY tenant A's attendance; excludes tenant B and null-tenant rows", async () => {
    const rows = await attendanceSvc.listAttendanceRecords({ tenantId: TENANT_A });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(11); // tenant A
    expect(ids).not.toContain(12); // foreign tenant
    expect(ids).not.toContain(13); // null tenant
  });
});
