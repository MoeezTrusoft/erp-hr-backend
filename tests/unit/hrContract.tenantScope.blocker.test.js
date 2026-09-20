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

// Requisition transition fixtures: the same id space, three tenants' worth of
// rows. The legacy /api/hr transition used to resolve by id alone, so tenant A
// could submit/approve/close tenant B's requisition.
// Phase 2.2 — the mandatory fields a requisition now needs before it can be
// SUBMITTED. These tests are about tenant scoping, not about the gate, so the
// fixtures simply comply; a non-complying fixture would fail for the wrong reason
// and stop proving that the tenant predicate is what gated the write.
const SUBMITTABLE = {
  departmentId: 1,
  location: "Karachi",
  employmentType: "FULL_TIME",
  openings: 1,
  requestedById: 1,
  hiringReason: "NEW_HIRE",
  costCenterRef: "CC-100",
};

const REQUISITIONS = [
  { id: 100, title: "Backend Engineer", status: "DRAFT", tenantId: TENANT_A, ...SUBMITTABLE },
  { id: 200, title: "B's Private Role", status: "DRAFT", tenantId: TENANT_B, ...SUBMITTABLE },
  { id: 300, title: "Legacy null-tenant", status: "DRAFT", tenantId: null, ...SUBMITTABLE },
];

// Phase 3.2 — the legacy /api/hr transitions now honour the canonical state
// machine too. Before that, DRAFT → APPROVED was accepted here, which meant this
// surface could approve a requisition that was never submitted — and, once the
// Phase 2.2 submission gate exists, bypass it entirely. A test that wants to
// approve or reopen therefore has to start from a status where that move is legal.
const setStatus = (id, status) => {
  REQUISITIONS.find((r) => r.id === id).status = status;
};
const APPROVALS = [];

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
  jobRequisition: {
    findFirst: jest.fn(async ({ where }) => {
      const scoped = filterByTenant(REQUISITIONS, where, "tenantId");
      const id = where?.id;
      return scoped.find((r) => (id == null ? true : r.id === id)) || null;
    }),
    findMany: jest.fn(async ({ where }) => filterByTenant(REQUISITIONS, where, "tenantId")),
    update: jest.fn(async ({ where, data }) => {
      const row = REQUISITIONS.find((r) => r.id === where.id);
      if (!row) throw new Error("Record to update not found");
      Object.assign(row, data);
      return row;
    }),
  },
  requisitionApproval: {
    create: jest.fn(async ({ data }) => {
      const row = { id: APPROVALS.length + 1, ...data };
      APPROVALS.push(row);
      return row;
    }),
  },
  // Phase 2.1 — the transition history row is written in the SAME transaction as
  // the status flip, so the fake has to accept it here too.
  requisitionTransition: {
    create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
  },
  // Phase 4 — a submission now also checks for a hiring freeze. This suite is
  // about tenant scoping, so no freeze is in effect.
  recruitmentHiringFreeze: { findFirst: jest.fn(async () => null) },
  // tenantTransaction runs `SELECT set_config(...)` through the client before the
  // callback; the fake records it so the tenant GUC is observable, not ignored.
  $executeRaw: jest.fn(async () => 1),
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
  prismaMock.jobRequisition.findFirst.mockClear();
  prismaMock.jobRequisition.update.mockClear();
  prismaMock.requisitionApproval.create.mockClear();
  prismaMock.$executeRaw.mockClear();
  APPROVALS.length = 0;
  // Restore the fixtures mutated by the transition tests.
  for (const row of REQUISITIONS) row.status = "DRAFT";
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

// Phase 1.2 — the legacy /api/hr requisition transitions. `transitionRequisition`
// resolved the row with a bare `findUnique({ where: { id } })`, so a caller in
// tenant A could move tenant B's requisition through submit/approve/reject/
// close/reopen by id. Tenant is now required and the row is fetched scoped.
describe("Phase 1.2 — requisition transitions are tenant-scoped", () => {
  it("refuses to transition a foreign tenant's requisition", async () => {
    await expect(
      hrContract.submitRequisition(200, TENANT_A, 1, "please review")
    ).rejects.toThrow(/not found/i);

    expect(prismaMock.jobRequisition.update).not.toHaveBeenCalled();
    expect(REQUISITIONS.find((r) => r.id === 200).status).toBe("DRAFT");
  });

  it("refuses a null-tenant legacy requisition", async () => {
    await expect(hrContract.approveRequisition(300, TENANT_A, 1)).rejects.toThrow(/not found/i);
    expect(prismaMock.jobRequisition.update).not.toHaveBeenCalled();
  });

  it("still transitions the caller's own requisition", async () => {
    // Also exercises the Phase 2.2 gate: submission is refused unless the
    // mandatory fields are set, and this fixture sets them.
    await hrContract.submitRequisition(100, TENANT_A, 1, "please review");

    expect(REQUISITIONS.find((r) => r.id === 100).status).toBe("PENDING_APPROVAL");
    // The lookup that gated the write carried the tenant predicate.
    expect(prismaMock.jobRequisition.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 100,
      tenantId: TENANT_A,
    });
  });

  it("fails closed when the tenant is missing rather than reading unscoped", async () => {
    await expect(hrContract.submitRequisition(100, null, 1)).rejects.toThrow(
      /tenant context is required/i
    );
    expect(prismaMock.jobRequisition.findFirst).not.toHaveBeenCalled();
  });

  it("stamps the verified tenant on the approval row it writes", async () => {
    setStatus(100, "PENDING_APPROVAL"); // only a submitted requisition may be decided
    await hrContract.approveRequisition(100, TENANT_A, 7, "within budget");

    expect(APPROVALS).toHaveLength(1);
    expect(APPROVALS[0]).toMatchObject({
      requisitionId: 100,
      approverId: 7,
      status: "APPROVED",
      tenantId: TENANT_A,
    });
  });

  it("reopens only the caller's own requisition", async () => {
    setStatus(100, "REJECTED"); // reopening is a REJECTED/CLOSED → DRAFT move
    await expect(hrContract.reopenRequisition(200, TENANT_A, 1)).rejects.toThrow(/not found/i);
    await hrContract.reopenRequisition(100, TENANT_A, 1);

    expect(REQUISITIONS.find((r) => r.id === 100).status).toBe("DRAFT");
  });
});
