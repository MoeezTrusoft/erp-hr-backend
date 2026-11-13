import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { mcpCtx, getCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { assertPermission } from "../lib/assertPermission.js";
import { isAttendanceHr, isManagement } from "../lib/attendanceAnomalyRules.js";
import { dateRange, dateKey } from "../lib/attendanceDates.js";
import { hash } from "./approval/adapters.js";
import { listCheckInOuts } from "./timesheetReport.service.js";
import logger from "../lib/logger.js";
import {
  attendanceExportInput,
  attendanceViewInput,
} from "../lib/attendanceWorkspaceSchemas.js";

const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const json = (value) => JSON.parse(JSON.stringify(value));
const settingsHash = (filters, columns, format) =>
  hash([
    Object.fromEntries(
      Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
    ),
    columns,
    format,
  ]);
function identity(exporting = false) {
  const ctx = getCtx(),
    user = ctx.user;
  if (!ctx.actorVerified || !user?.tenantId || !user?.userId)
    fail("An authenticated account is required", 403);
  assertPermission(
    ctx.permissions,
    exporting ? "EXPORT" : "GET",
    "hr:attendance",
  );
  return { user, tenantId: user.tenantId, ownerUserId: String(user.userId) };
}
async function scopeIds(db, user) {
  const rows = await db.employee.findMany({
    where: {
      tenant_id: user.tenantId,
      ...(!isAttendanceHr(user) && !isManagement(user)
        ? {
            OR: [
              { id: Number(user.employeeId) || -1 },
              { managerId: Number(user.employeeId) || -1 },
            ],
          }
        : {}),
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
const summary = (row) => ({
  reference: row.id,
  status: +new Date(row.expiresAt) <= Date.now() ? "EXPIRED" : row.status,
  progress: row.progress,
  total: row.total,
  filters: row.filters,
  columns: row.columns,
  format: row.format,
  error: row.error,
  generatedAt: row.generatedAt,
  expiresAt: row.expiresAt,
  company: row.tenantId,
});
const jobFields = {id:true,tenantId:true,status:true,progress:true,total:true,filters:true,columns:true,format:true,error:true,generatedAt:true,expiresAt:true};

export async function startAttendanceExport(
  { id, filters, columns, format },
  db = prisma,
) {
  ({ id, filters, columns, format } = attendanceExportInput.parse({
    id,
    filters,
    columns,
    format,
  }));
  const who = identity(true);
  dateRange(filters.from, filters.to, 92);
  return tenantTransaction(
    db,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${who.tenantId + ":attendance-export:" + who.ownerUserId},0))`;
      const prior = await tx.attendanceExportJob.findFirst({
        where: { id, tenantId: who.tenantId, ownerUserId: who.ownerUserId },
        select:jobFields,
      });
      if (prior) {
        if (
          settingsHash(prior.filters, prior.columns, prior.format) !==
          settingsHash(filters, columns, format)
        )
          fail(
            "This export reference belongs to different settings. Start a new export.",
          );
        return summary(prior);
      }
      if (
        (await tx.attendanceExportJob.count({
          where: {
            tenantId: who.tenantId,
            ownerUserId: who.ownerUserId,
            status: { in: ["QUEUED", "PROCESSING"] },
            expiresAt: { gt: new Date() },
          },
        })) >= 2
      )
        fail("Two exports are already running. Wait for one to finish.");
      const employeeIds = await scopeIds(tx, who.user);
      const row = await tx.attendanceExportJob.create({
        data: {
          id,
          tenantId: who.tenantId,
          ownerUserId: who.ownerUserId,
          filters,
          columns,
          format,
          employeeIds,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      await tx.attendanceRuleAudit.create({
        data: {
          tenantId: who.tenantId,
          actorId: who.ownerUserId,
          action: "ATTENDANCE_EXPORT_QUEUED",
          data: {
            reference: id,
            filters,
            columns,
            format,
            expiresAt: row.expiresAt.toISOString(),
          },
        },
      });
      return summary(row);
    },
    { tenantId: who.tenantId },
  );
}
export async function listAttendanceExports(_input = {}, db = prisma) {
  const who = identity(true);
  return {
    items: (
      await db.attendanceExportJob.findMany({
        where: { tenantId: who.tenantId, ownerUserId: who.ownerUserId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select:jobFields,
      })
    ).map(summary),
  };
}
async function ownJob(db, id, who) {
  const row = await db.attendanceExportJob.findFirst({
    where: { id, tenantId: who.tenantId, ownerUserId: who.ownerUserId },
    select:{...jobFields,employeeIds:true},
  });
  if (!row) fail("Export not found", 404);
  return row;
}
export async function readAttendanceExport({ id }, db = prisma) {
  return summary(await ownJob(db, id, identity(true)));
}
export async function downloadAttendanceExport({ id, page = 1 }, db = prisma) {
  const who = identity(true),
    row = await ownJob(db, id, who);
  if (+row.expiresAt <= Date.now())
    fail("This export has expired. Generate a new export.", 410);
  if (row.status !== "READY") fail("The export is not ready for download.");
  const permitted = new Set(await scopeIds(db, who.user));
  if (row.employeeIds.some((employeeId) => !permitted.has(employeeId)))
    fail(
      "Your employee scope changed. Generate a new export with your current access.",
      403,
    );
  const pageSize = 1000,total=row.total;
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    (page > 1 && (page - 1) * pageSize >= total)
  )
    fail("Export page is out of range", 422);
  // Slice inside PostgreSQL so polling and paged downloads never transfer the
  // entire large artifact from storage for every page.
  const path=`$.items[${(page-1)*pageSize} to ${page*pageSize-1}]`;
  const pages=await tenantTransaction(db,tx=>tx.$queryRaw`SELECT jsonb_path_query_array(artifact, ${path}::jsonpath) AS items FROM attendance_export_jobs WHERE id=${id}::uuid AND "tenantId"=${who.tenantId}::uuid AND "ownerUserId"=${who.ownerUserId} AND status='READY' AND "expiresAt">${new Date()}`,{tenantId:who.tenantId});
  if(!pages.length)fail('This export has expired. Generate a new export.',410);
  const last = page * pageSize >= total;
  if (last)
    await db.attendanceRuleAudit.create({
      data: {
        tenantId: who.tenantId,
        actorId: who.ownerUserId,
        action: "ATTENDANCE_EXPORT_DOWNLOADED",
        data: { reference: id, rows: total },
      },
    });
  return {
    ...summary(row),
    page,
    items: pages[0].items,
    hasMore: !last,
  };
}

// Durable leased jobs. A server restart leaves the job claim recoverable; a stale
// worker cannot replace the result of a later owner of the lease.
export async function drainAttendanceExports({
  db = prisma,
  now = new Date(),
} = {}) {
  const token = randomUUID();
  const job = await mcpCtx.run({ system: true }, () =>
    tenantTransaction(
      db,
      async (tx) => {
        await tx.attendanceExportJob.updateMany({
          where: { expiresAt: { lte: now }, status: { not: "EXPIRED" } },
          data: { status: "EXPIRED", artifact: Prisma.DbNull },
        });
        const rows =
          await tx.$queryRaw`SELECT id FROM attendance_export_jobs WHERE "expiresAt">${now} AND (status='QUEUED' OR (status='PROCESSING' AND "leaseUntil"<${now})) ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!rows.length) return null;
        return tx.attendanceExportJob.update({
          where: { id: rows[0].id },
          data: {
            status: "PROCESSING",
            progress: 10,
            leaseToken: token,
            leaseUntil: new Date(+now + 900000),
          },
        });
      },
      { system: true },
    ),
  );
  if (!job) return { processed: 0 };
  await mcpCtx.run({ user: { tenantId: job.tenantId } }, async () => {
    try {
      const result = await listCheckInOuts({
        ...job.filters,
        tenantId: job.tenantId,
        employeeIds: job.employeeIds,
        exportMode: true,
        exportLimit: 100000,
        page: 1,
      });
      if (result.total > 100000)
        fail(
          "This export exceeds 100,000 daily rows. Narrow the dates or scope.",
        );
      const items = result.items.map((row) => ({
        employeeCode: row.employee?.code,
        date: dateKey(row.date),
        calendar: row.calendarStatus,
        outcome: row.status,
        processing: row.processingState,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        decimalHours: row.totalHours,
        timeZone: row.timeZone,
      }));
      await tenantTransaction(
        db,
        async (tx) => {
          const changed = await tx.attendanceExportJob.updateMany({
            where: {
              id: job.id,
              tenantId: job.tenantId,
              status: "PROCESSING",
              leaseToken: token,
              expiresAt: { gt: new Date() },
            },
            data: {
              status: "READY",
              progress: 100,
              total: result.total,
              artifact: json({ items }),
              generatedAt: new Date(),
              leaseUntil: null,
            },
          });
          if (changed.count)
            await tx.attendanceRuleAudit.create({
              data: {
                tenantId: job.tenantId,
                actorId: job.ownerUserId,
                action: "ATTENDANCE_EXPORT_READY",
                data: { reference: job.id, rows: items.length },
              },
            });
        },
        { tenantId: job.tenantId, txOptions: { timeout: 60000 } },
      );
    } catch (error) {
      logger.error(
        { reference: job.id, err: { message: error.message } },
        "Attendance export generation failed",
      );
      await db.attendanceExportJob.updateMany({
        where: {
          id: job.id,
          tenantId: job.tenantId,
          status: "PROCESSING",
          leaseToken: token,
        },
        data: {
          status: "FAILED",
          error:
            error.status === 409
              ? error.message
              : "Export generation failed. Retry with a new export reference.",
          leaseUntil: null,
        },
      });
    }
  });
  return { processed: 1, reference: job.id };
}

export async function listAttendanceViews(_input = {}, db = prisma) {
  const who = identity();
  return {
    items: await db.attendanceSavedView.findMany({
      where: { tenantId: who.tenantId, ownerUserId: who.ownerUserId },
      select: { id: true, name: true, filters: true, version: true },
      orderBy: { name: "asc" },
    }),
  };
}
export async function saveAttendanceView(
  { id, version, name, filters },
  db = prisma,
) {
  ({ id, version, name, filters } = attendanceViewInput.parse({
    id,
    version,
    name,
    filters,
  }));
  const who = identity();
  return tenantTransaction(
    db,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${who.tenantId + ":attendance-view:" + who.ownerUserId},0))`;
      const where = {
        id,
        tenantId: who.tenantId,
        ownerUserId: who.ownerUserId,
      };
      const prior = await tx.attendanceSavedView.findFirst({ where });
      if (prior) {
        if (prior.version !== version)
          fail("This saved view changed. Reload before replacing it.");
        return tx.attendanceSavedView.update({
          where: { id },
          data: { name, filters, version: { increment: 1 } },
          select: { id: true, name: true, filters: true, version: true },
        });
      }
      if (version !== 0) fail("Saved view not found", 404);
      if (
        (await tx.attendanceSavedView.count({
          where: { tenantId: who.tenantId, ownerUserId: who.ownerUserId },
        })) >= 20
      )
        fail(
          "You can keep 20 saved views per company. Remove one before adding another.",
        );
      return tx.attendanceSavedView.create({
        data: { ...where, name, filters },
        select: { id: true, name: true, filters: true, version: true },
      });
    },
    { tenantId: who.tenantId },
  );
}
export async function deleteAttendanceView({ id, version }, db = prisma) {
  const who = identity();
  const result = await db.attendanceSavedView.deleteMany({
    where: {
      id,
      tenantId: who.tenantId,
      ownerUserId: who.ownerUserId,
      version,
    },
  });
  if (!result.count)
    fail(
      "Saved view changed or is no longer available. Refresh before removing it.",
    );
  return { removed: true };
}
