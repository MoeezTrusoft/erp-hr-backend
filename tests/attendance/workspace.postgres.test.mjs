import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  setup,
  db,
  people,
  company,
  other,
  prisma,
} from "../approval/fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import {
  saveAttendanceView,
  listAttendanceViews,
  deleteAttendanceView,
  startAttendanceExport,
  listAttendanceExports,
  readAttendanceExport,
  downloadAttendanceExport,
  drainAttendanceExports,
} from "../../src/services/attendanceWorkspace.service.js";
const actor = (
  role,
  fn,
  { tenantId = company, exportGrant = true, companyScope = role === "HR" } = {},
) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId,
        userId: people[role].userId,
        employeeId: people[role].id,
        roles: [companyScope ? "HR Manager" : "Employee"],
      },
      permissions: [
        "hr.attendance.read",
        ...(exportGrant ? ["hr.attendance.export"] : []),
      ],
    },
    fn,
  );

test("company-private saved views and recoverable, permission checked exports", async (t) => {
  await setup();
  await t.test(
    "saved views isolate company and owner, enforce versions and allow only supported filters",
    async () => {
      const input = {
        id: randomUUID(),
        version: 0,
        name: "Day team",
        filters: {
          month: "2026-02",
          code: "EMP-EMPLOYEE",
          sort: "date",
          direction: "asc",
        },
      };
      let view = await actor("HR", () => saveAttendanceView(input));
      assert.equal(view.version, 1);
      assert.equal(
        (await actor("OTHER", () => listAttendanceViews())).items.length,
        0,
      );
      assert.equal(
        (await actor("HR", () => listAttendanceViews(), { tenantId: other }))
          .items.length,
        0,
      );
      await assert.rejects(
        actor("HR", () =>
          saveAttendanceView({ ...input, filters: { token: "private" } }),
        ),
        /Unrecognized key/,
      );
      await assert.rejects(
        actor("HR", () => saveAttendanceView({ ...input, name: "Changed" })),
        /changed/,
      );
      view = await actor("HR", () =>
        saveAttendanceView({
          ...input,
          version: view.version,
          name: "Night team",
        }),
      );
      await assert.rejects(
        actor("OTHER", () =>
          deleteAttendanceView({ id: view.id, version: view.version }),
        ),
        /no longer available/,
      );
      await assert.rejects(
        actor("HR", () => deleteAttendanceView({ id: view.id, version: 1 })),
        /changed/,
      );
      await actor("HR", () =>
        deleteAttendanceView({ id: view.id, version: view.version }),
      );
      assert.equal(
        (await actor("HR", () => listAttendanceViews())).items.length,
        0,
      );
    },
  );
  await t.test(
    "job resumes from an expired lease; downloads reauthorize scope and expiry",
    async () => {
      const input = {
        id: randomUUID(),
        filters: {
          from: "2026-02-12",
          to: "2026-02-12",
          q: people.EMPLOYEE.employee_code,
        },
        columns: ["employeeCode", "date", "outcome"],
        format: "csv",
      };
      // TS-AWAITING-OFF-01 — a working day with no stored record is "awaiting"
      // and is no longer listed, so give the day a real record to export.
      await db((tx) =>
        tx.attendance.create({
          data: {
            tenantId: company,
            employeeId: people.EMPLOYEE.id,
            date: new Date("2026-02-12"),
            status: "PRESENT",
            processingState: "FINALIZED",
            day_credit: 1,
          },
        }),
      );
      await assert.rejects(
        actor("HR", () => startAttendanceExport(input), { exportGrant: false }),
        /permissions/,
      );
      const queued = await actor("HR", () => startAttendanceExport(input));
      assert.equal(queued.status, "QUEUED");
      assert.equal(
        (await actor("HR", () => startAttendanceExport(input))).reference,
        input.id,
      );
      await assert.rejects(
        actor("HR", () => startAttendanceExport({ ...input, format: "pdf" })),
        /different settings/,
      );
      await assert.rejects(
        actor("OTHER", () => readAttendanceExport({ id: input.id })),
        /not found/,
      );
      await assert.rejects(
        actor("HR", () => readAttendanceExport({ id: input.id }), {
          tenantId: other,
        }),
        /not found/,
      );
      assert.equal(
        (await actor("HR", () => listAttendanceExports())).items[0].reference,
        input.id,
      );
      await db((tx) =>
        tx.attendanceExportJob.update({
          where: { id: input.id },
          data: {
            status: "PROCESSING",
            leaseToken: randomUUID(),
            leaseUntil: new Date(Date.now() - 1000),
          },
        }),
      );
      for (let n = 0; n < 20; n++) {
        await drainAttendanceExports();
        if (
          (await actor("HR", () => readAttendanceExport({ id: input.id })))
            .status === "READY"
        )
          break;
      }
      const ready = await actor("HR", () =>
        readAttendanceExport({ id: input.id }),
      );
      assert.equal(ready.status, "READY");
      assert.equal(ready.progress, 100);
      assert.ok(ready.total > 0);
      await assert.rejects(
        actor("HR", () => downloadAttendanceExport({ id: input.id }), {
          exportGrant: false,
        }),
        /permissions/,
      );
      await assert.rejects(
        actor("HR", () => downloadAttendanceExport({ id: input.id }), {
          companyScope: false,
        }),
        /scope changed/,
      );
      const file = await actor("HR", () =>
        downloadAttendanceExport({ id: input.id }),
      );
      assert.equal(file.hasMore, false);
      assert.equal(file.items[0].employeeCode, people.EMPLOYEE.employee_code);
      assert.equal(file.items[0].employeeId, undefined);
      assert.equal(file.items[0].name, undefined);
      await assert.rejects(
        actor("HR", () => downloadAttendanceExport({ id: input.id, page: 2 })),
        /out of range/,
      );
      await db((tx) =>
        tx.attendanceExportJob.update({
          where: { id: input.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        }),
      );
      await assert.rejects(
        actor("HR", () => downloadAttendanceExport({ id: input.id })),
        /expired/,
      );
      await drainAttendanceExports();
      const expired = await db((tx) =>
        tx.attendanceExportJob.findUnique({ where: { id: input.id } }),
      );
      assert.equal(expired.status, "EXPIRED");
      assert.equal(expired.artifact, null);
      assert.equal(
        await db((tx) =>
          tx.attendanceRuleAudit.count({
            where: {
              tenantId: company,
              action: "ATTENDANCE_EXPORT_DOWNLOADED",
            },
          }),
        ),
        1,
      );
    },
  );
}).finally(() => prisma.$disconnect());
