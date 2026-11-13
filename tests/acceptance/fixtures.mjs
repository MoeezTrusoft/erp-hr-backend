import { randomUUID } from "node:crypto";
const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/hr_task_assessment_test"
)
  throw new Error("Use the isolated local HR assessment test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
export const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { acceptanceCommand } =
  await import("../../src/services/attendance-acceptance/service.js");
export async function fixture() {
  const tenantId = randomUUID(),
    people = {},
    sn = "OAT-" + randomUUID().slice(0, 8);
  const grants = {
    EMP: ["hr.setup.read", "hr.setup.prepare"],
    MANAGER: ["hr.setup.read", "hr.approvals.manager"],
    HR: ["hr.setup.read", "hr.approvals.verify"],
    TECH: ["hr.setup.read", "hr.setup.prepare"],
    MGMT: ["hr.setup.read", "hr.setup.approve"],
    IT: ["hr.setup.read", "hr.setup.activate"],
    ADMIN: [],
  };
  const db = (fn) =>
    mcpCtx.run({ user: { tenantId } }, () =>
      tenantTransaction(prisma, fn, { tenantId }),
    );
  await db(async (tx) => {
    for (const [i, role] of Object.keys(grants).entries())
      people[role] = await tx.employee.create({
        data: {
          tenant_id: tenantId,
          employee_code:
            "OAT-" + role + "-" + tenantId.slice(0, 4).toUpperCase(),
          employeeCategory: "EMPLOYEE",
          first_name: "Synthetic",
          status: "Active",
          employement_status: "Active",
          userId: Math.floor(Math.random() * 1e8) + 100000 + i,
        },
      });
    people.EMP = await tx.employee.update({
      where: { id: people.EMP.id },
      data: { managerId: people.MANAGER.id },
    });
    await tx.attendanceCaptureDevice.create({
      data: {
        tenantId,
        sn,
        name: "Isolated test scanner",
        timeZone: "Asia/Karachi",
        siteId: "test-site",
        active: false,
        allowedTenantIds: [tenantId],
      },
    });
    await tx.attendanceSetupRelease.create({
      data: {
        tenantId,
        version: 1,
        effectiveFrom: new Date("2020-01-01"),
        coverageThrough: new Date("2099-12-31"),
        config: {
          settings: {
            sites: [{ id: "test-site", name: "Isolated test site" }],
          },
        },
        publishedById: people.EMP.id,
        reason: "Isolated acceptance fixture",
      },
    });
  });
  const as = (role, fn, tenant = tenantId) =>
    mcpCtx.run(
      {
        actorVerified: true,
        user: {
          tenantId: tenant,
          userId: people[role].userId,
          isAdmin: role === "ADMIN",
        },
        permissions: grants[role],
      },
      fn,
    );
  const call = (role, op, input = {}) =>
    as(role, () => acceptanceCommand("hr_attendance_acceptance_" + op, input));
  const cmd = (role, op, row, input) =>
    call(role, op, {
      slot: row?.slot || "S01",
      expectedVersion: row?.version || 0,
      requestKey: randomUUID(),
      reason: "Witnessed isolated acceptance test",
      ...input,
    }).then((r) => r.record);
  const setup = {
    location: "Isolated test site",
    siteCode: "test-site",
    headOffice: true,
    employeeCount: 30,
    leadCode: people.MANAGER.employee_code,
    technicalCode: people.TECH.employee_code,
    inventory: [
      {
        sn,
        kind: "SECUGEN",
        mode: "SUPERVISED",
        model: "HU20-A",
        baselineRef: "controlled:hardware-v1",
        manufacturerRef: "",
        padEvidenceRef: "",
      },
    ],
    baselineRef: "controlled:release-v1",
    rosterRef: "controlled:roster",
    identityRef: "controlled:identity",
    fallbackRef: "controlled:fallback",
    retentionRef: "controlled:retention",
    targetsRef: "controlled:targets-approved",
    targetsApproved: true,
    evidenceRefs: ["controlled:scope"],
    observationDates: [
      "2020-01-01",
      "2020-01-02",
      "2020-01-03",
      "2020-01-04",
      "2020-01-05",
    ],
    observationRef: "controlled:observation",
    nextReviewDate: "2099-12-01",
  };
  const complete = async (row) => {
    for (const t of row.runs) {
      row = await cmd("EMP", "run_save", row, {
        run: {
          runKey: t.runKey,
          outcome: t.allowNA ? "NA" : "PASS",
          observed: t.allowNA
            ? "This device type is excluded from the site scope"
            : "Expected result observed against frozen baseline",
          startedAt: "2020-01-01T08:00:00.000Z",
          finishedAt: "2020-01-01T08:05:00.000Z",
          witnessCode: people.MANAGER.employee_code,
          attempts: 300,
          metrics:
            "300/300 genuine; zero wrong identity; measured thresholds met. Controlled attempt ledger attached.",
          deviations: "",
          evidenceRefs: ["controlled:attempt-ledger"],
          attachmentRefs: [],
          defectRefs: [],
        },
      });
    }
    return row;
  };
  return { tenantId, people, sn, grants, db, as, call, cmd, setup, complete };
}
