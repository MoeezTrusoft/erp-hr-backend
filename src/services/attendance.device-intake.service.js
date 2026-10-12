// Compatibility facade: every capture adapter uses the durable receipt pipeline.
import prisma from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { mcpCtx } from "../mcp/context.js";
import logger from "../lib/logger.js";
import { parseCaptureRow } from "../lib/attendanceCapture.js";
import {
  receiveCapture,
  reviewCaptureEvents,
} from "./attendanceCapture.service.js";

export function parseAttlogRow(line) {
  try {
    return parseCaptureRow(line, "UTC");
  } catch {
    return null;
  }
}
export async function ingestDevicePunches(args) {
  return receiveCapture({ ...args, source: "DEVICE_PUSH" });
}
// Recovery is tenant-scoped, bounded, serial-aware and uses the same audited
// resolution operation as the inbox. A cursor makes large repairs resumable.
export async function resolveOrphanPunches({
  tenantId,
  dryRun = true,
  afterId,
  deviceUserId,
  actorId = "orphan-recovery",
} = {}) {
  if (!tenantId)
    throw Object.assign(new Error("Verified tenant is required"), {
      status: 403,
    });
  return mcpCtx.run({ user: { tenantId } }, async () => {
    const rows = await prisma.attendanceCaptureEvent.findMany({
      where: {
        tenantId,
        state: "NEEDS_REVIEW",
        employeeId: null,
        ...(deviceUserId ? { deviceUserId } : {}),
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      take: 100,
      orderBy: { id: "asc" },
    });
    const results = [];
    if (!dryRun)
      for (const row of rows) {
        try {
          await reviewCaptureEvents({
            tenantId,
            actorId,
            items: [{ id: row.id, version: row.version }],
            action: "RESOLVE",
            reason: "Dated enrolment recovery",
          });
          results.push({ id: row.id, resolved: true });
        } catch (err) {
          results.push({ id: row.id, resolved: false, reason: err.message });
        }
      }
    return {
      scanned: rows.length,
      results,
      dryRun,
      nextCursor: rows.length === 100 ? rows.at(-1).id : null,
    };
  });
}

export async function listDevicePunches({
  tenantId,
  employeeId,
  deviceUserId,
  sn,
  from,
  to,
  page = 1,
  pageSize = 100,
} = {}) {
  const take = Math.min(Math.max(Number(pageSize) || 100, 1), 500);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = { ...(tenantId ? { tenantId } : {}) };
  if (employeeId != null && employeeId !== "")
    where.employeeId = Number(employeeId);
  if (deviceUserId) where.deviceUserId = String(deviceUserId);
  if (sn) where.sn = String(sn);
  if (from || to) {
    where.punchedAt = {};
    if (from) where.punchedAt.gte = new Date(from);
    if (to) where.punchedAt.lte = new Date(to);
  }

  const run = async () => {
    try {
      const [rows, total] = await Promise.all([
        prisma.attendanceDevicePunch.findMany({
          where,
          orderBy: [{ punchedAt: "desc" }, { id: "desc" }],
          take,
          skip,
        }),
        prisma.attendanceDevicePunch.count({ where }),
      ]);
      return {
        rows,
        total,
        page: Math.max(Number(page) || 1, 1),
        pageSize: take,
      };
    } catch (err) {
      // ERR-3 / fail-closed: a structural DB error (missing table P2021 or
      // missing column P2022) must not escape as an unhandled 5xx that also
      // leaks the internal schema name to the caller. Log the real cause
      // server-side; return a clean 4xx so the tool degrades without a 5xx.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === "P2021" || err.code === "P2022")
      ) {
        logger.error(
          {
            code: err.code,
            model: err.meta?.modelName,
            table: err.meta?.table,
          },
          "listDevicePunches: attendance device punch store not provisioned",
        );
        throw Object.assign(
          new Error("Attendance device punch store is not available"),
          { status: 404 },
        );
      }
      throw err;
    }
  };

  // When called outside an established MCP context (tests / internal), set one.
  return tenantId ? mcpCtx.run({ user: { tenantId } }, run) : run();
}

// Explicit deployment recovery for legacy raw orphans. This only introduces
// receipts; the worker performs attribution and evaluation with current guards.
export async function bridgeLegacyOrphans(
  { tenantId, afterId = 0, dryRun = true, actorId = "legacy-capture-recovery" },
  db = prisma,
) {
  if (!tenantId)
    throw Object.assign(new Error("Tenant owner is required"), { status: 403 });
  return mcpCtx.run({ system: true }, async () => {
    const rows = await db.attendanceDevicePunch.findMany({
      where: {
        tenantId,
        employeeId: null,
        captureEventId: null,
        id: { gt: afterId },
      },
      orderBy: { id: "asc" },
      take: 100,
    });
    const results = [];
    for (const row of rows) {
      if (!row.rawLine) {
        results.push({
          id: row.id,
          reason:
            "Original punch text is unavailable; review historical evidence",
        });
        continue;
      }
      try {
        const receipt = await receiveCapture(
          {
            sn: row.sn,
            rows: [row.rawLine],
            source: "DEVICE_LISTENER",
            requestKey: `legacy-punch:${row.id}`,
            actorId,
            dryRun,
          },
          db,
        );
        results.push({ id: row.id, ...receipt });
      } catch (err) {
        results.push({
          id: row.id,
          reason: err.status ? err.message : "Recovery failed; retry this page",
        });
      }
    }
    return {
      scanned: rows.length,
      results,
      dryRun,
      nextCursor: rows.length === 100 ? rows.at(-1).id : null,
    };
  });
}
