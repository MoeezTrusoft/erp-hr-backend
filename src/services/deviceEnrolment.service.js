// src/services/deviceEnrolment.service.js
//
// Which device id belonged to whom, at a given moment.
//
// HR-ATT-DEVICE-ENROLMENT-01. The intake resolves a punch by looking up the
// employee who currently carries that `biometric_id`. That is wrong twice over:
// a re-enrolled employee's new id matches nobody until somebody edits the
// employee row, and a REUSED id silently hands one person's punches to another.
//
// Enrolments are period-scoped, so a punch is matched against the id that was
// current when it happened rather than the id that is current now.
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  chooseEnrolment,
  captureError,
  enrolmentEnd,
} from "../lib/attendanceCapture.js";
import { dateOnly } from "../lib/attendanceDates.js";
import { captureAudit } from "./attendanceCapture.service.js";
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";

/**
 * Resolve device ids to { employeeId, tenantId } as at a point in time.
 *
 * One physical device serves the whole fleet, so its enrolment ids span every
 * tenant and this runs under SYSTEM context. Scoping it to one tenant would
 * silently drop every punch belonging to the others — the HR-ATT-DEVICE-INTAKE-02
 * defect, which resolved ~15% of punches on production.
 *
 * @param {string[]} deviceUserIds
 * @param {Date} at              when the punch happened
 * @param {string} [sn]          device serial; an enrolment with a null `sn`
 *                               matches any device
 * @returns {Promise<Map<string, {employeeId:number, tenantId:string|null, enrolmentId:number}>>}
 */
export async function resolveEnrolmentAt(ids, at, sn) {
  const resolver = await buildEnrolmentResolver(ids, sn);
  return new Map(
    ids.map((id) => [String(id), resolver(id, at)]).filter(([, hit]) => hit),
  );
}

/**
 * One read, then resolve each punch at ITS OWN time.
 *
 * A batch is not a moment: the device re-pushes days of backlog after a
 * reconnect, and a re-enrolment inside that window means two punches with the
 * same device id belong to two different people. Resolving the whole batch at
 * one timestamp would hand them both to whoever held the id at that instant.
 *
 * @returns {Promise<(deviceUserId: string, at: Date) => object|undefined>}
 */
/**
 * HR-ATT-PRIMARY-DEVICE-01 — the employee's PRIMARY device serial at a moment.
 *
 * Returns null when no SN-scoped primary enrolment is in force (including
 * "primary on a null-`sn` catch-all", which is not a specific device and can
 * never be primary). The lookup is period-scoped exactly like enrolment
 * resolution: the primary that matters is the one in force WHEN THE DAY
 * HAPPENED, not whichever row is flagged today.
 *
 * `at` should be a stable instant of the day being marked (the writer passes
 * midday) — a boundary midnight belongs to whichever period covers it, and
 * midday never straddles a re-enrolment close (the close is day-before).
 */
export async function resolvePrimarySnAt(employeeId, at) {
  const when = at instanceof Date ? at : new Date(at);
  const rows = await mcpCtx.run({ system: true }, async () => {
    return await prisma.employeeDeviceEnrolment.findMany({
      where: { employeeId, isPrimary: true },
      select: {
        id: true,
        sn: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
    });
  });
  const active = rows.filter(
    (r) =>
      r.sn && +new Date(r.effectiveFrom) <= +when && enrolmentEnd(r) >= +when,
  );
  return active.length === 1 ? active[0].sn : null;
}

/**
 * HR-ATT-PRIMARY-DEVICE-01 — flag one enrolment as the employee's PRIMARY
 * device (and clear the flag on the employee's other rows).
 *
 * The flag is per-employee, not per-tenant: Shah Hassan's JOC and BOC rows are
 * one human at one machine, so his primary is the DEVICE, shared across the
 * tenant split. Enrolments remain period-scoped — this sets the flag on the
 * CURRENT period; history keeps whatever was true then.
 */
/**
 * HR-ATT-PRIMARY-DEVICE-01 — list enrolments (optionally scoped to one tenant
 * and/or employee) for the admin tooling.
 */
export async function listEnrolments({ tenantId, employeeId } = {}) {
  if (!tenantId) throw captureError("Verified tenant is required", 403);
  return mcpCtx.run({ system: true }, async () => {
    return await prisma.employeeDeviceEnrolment.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(employeeId != null ? { employeeId: Number(employeeId) } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        employeeId: true,
        deviceUserId: true,
        sn: true,
        isPrimary: true,
        effectiveFrom: true,
        effectiveTo: true,
        note: true,
      },
      orderBy: [{ employeeId: "asc" }, { effectiveFrom: "desc" }],
    });
  });
}

async function verifyEmployee(tx, tenantId, employeeId) {
  if (!tenantId || !Number.isInteger(employeeId))
    throw captureError("Verified tenant and employee are required", 403);
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenant_id: tenantId },
  });
  if (!employee) throw captureError("Employee not found", 404);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enrolment:${tenantId}:${employeeId}`}))`;
}
async function changePrimary({
  tenantId,
  employeeId,
  enrolmentId,
  effectiveFrom,
  actorId,
  reason = "Primary device changed",
}) {
  const at = dateOnly(effectiveFrom || new Date().toISOString().slice(0, 10));
  return tenantTransaction(
    prisma,
    async (tx) => {
      await verifyEmployee(tx, tenantId, employeeId);
      const rows = await tx.employeeDeviceEnrolment.findMany({
        where: { tenantId, employeeId },
      });
      const active = rows.filter(
        (r) => +new Date(r.effectiveFrom) <= +at && enrolmentEnd(r) >= +at,
      );
      if (enrolmentId && !active.some((r) => r.id === enrolmentId && r.sn))
        throw captureError(
          "Choose a device-specific enrolment effective on this date",
          409,
        );
      let selected;
      for (const row of active) {
        const isPrimary = row.id === enrolmentId;
        if (row.isPrimary === isPrimary) {
          if (isPrimary) selected = row;
          continue;
        }
        let updated;
        if (+new Date(row.effectiveFrom) === +at)
          updated = await tx.employeeDeviceEnrolment.update({
            where: { id: row.id, tenantId },
            data: { isPrimary },
          });
        else {
          await tx.employeeDeviceEnrolment.update({
            where: { id: row.id, tenantId },
            data: { effectiveTo: new Date(+at - 1) },
          });
          updated = await tx.employeeDeviceEnrolment.create({
            data: {
              tenantId,
              employeeId,
              deviceUserId: row.deviceUserId,
              sn: row.sn,
              isPrimary,
              effectiveFrom: at,
              effectiveTo: row.effectiveTo,
              note: reason,
            },
          });
        }
        if (isPrimary) selected = updated;
      }
      await captureAudit(tx, {
        tenantId,
        actorId,
        action: "PRIMARY_DEVICE_CHANGED",
        reason,
        detail: {
          employeeId,
          enrolmentId: selected?.id ?? null,
          effectiveFrom: at,
        },
      });
      return (
        selected || {
          employeeId,
          cleared: active.filter((r) => r.isPrimary).length,
        }
      );
    },
    { tenantId },
  );
}
export async function setPrimaryEnrolment(args) {
  if (!args.tenantId) throw captureError("Verified tenant is required", 403);
  const target = await prisma.employeeDeviceEnrolment.findFirst({
    where: { id: args.enrolmentId, tenantId: args.tenantId },
  });
  if (!target) throw captureError("Enrolment not found", 404);
  return changePrimary({ ...args, employeeId: target.employeeId });
}
export async function clearPrimaryEnrolment(args) {
  return changePrimary(args);
}

export async function buildEnrolmentResolver(deviceUserIds, sn) {
  const ids = [...new Set(deviceUserIds)].filter(Boolean).map(String);
  if (!ids.length) return () => undefined;

  const rows = await mcpCtx.run({ system: true }, async () => {
    return await prisma.employeeDeviceEnrolment.findMany({
      where: { deviceUserId: { in: ids } },
      select: {
        id: true,
        employeeId: true,
        tenantId: true,
        deviceUserId: true,
        effectiveFrom: true,
        effectiveTo: true,
        sn: true,
      },
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
    });
  });

  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.deviceUserId)) byId.set(r.deviceUserId, []);
    byId.get(r.deviceUserId).push(r);
  }

  const resolve = (deviceUserId, at) => {
    const hit = chooseEnrolment(
      byId.get(String(deviceUserId)) || [],
      deviceUserId,
      sn,
      new Date(at),
    );
    return hit.reason ? undefined : hit;
  };
  resolve.hasHistory = (id) => byId.has(String(id));
  return resolve;
}

/**
 * Close an employee's current enrolment and open a new one.
 *
 * The close date is the day BEFORE the new id takes effect, so the two never
 * overlap: an overlap is exactly the ambiguity this model exists to remove.
 */
export async function reEnrol({
  employeeId,
  tenantId,
  newDeviceUserId,
  sn,
  effectiveFrom,
  note,
  actorId,
  isPrimary = false,
}) {
  const from = dateOnly(effectiveFrom);
  if (!sn || !newDeviceUserId || newDeviceUserId.length > 64 || !note?.trim())
    throw captureError(
      "Device serial, user ID, effective date and reason are required",
    );
  const device = await mcpCtx.run(
    { system: true },
    async () =>
      await prisma.attendanceCaptureDevice.findUnique({ where: { sn } }),
  );
  if (!device?.active || !device.allowedTenantIds.includes(tenantId))
    throw captureError("Device is not permitted for this tenant", 403);
  // Cross-tenant collision lookup requires SYSTEM at the transaction boundary
  // so the RLS bypass GUC is set; every mutation below is explicitly scoped.
  return mcpCtx.run({ system: true }, () =>
    tenantTransaction(
      prisma,
      async (tx) => {
        await verifyEmployee(tx, tenantId, employeeId);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-id:${sn}:${newDeviceUserId}`}))`;
        const conflicts = await tx.employeeDeviceEnrolment.findMany({
          where: { deviceUserId: newDeviceUserId, OR: [{ sn }, { sn: null }] },
        });
        if (
          conflicts.some(
            (r) => r.employeeId !== employeeId && enrolmentEnd(r) >= +from,
          )
        )
          throw captureError(
            "Device ID overlaps another employee enrolment",
            409,
          );
        const rows = await tx.employeeDeviceEnrolment.findMany({
          where: { tenantId, employeeId, sn },
        });
        if (rows.some((r) => +new Date(r.effectiveFrom) >= +from))
          throw captureError(
            "An enrolment already starts on or after this date",
            409,
          );
        for (const row of rows.filter((r) => enrolmentEnd(r) >= +from))
          await tx.employeeDeviceEnrolment.update({
            where: { id: row.id, tenantId },
            data: { effectiveTo: new Date(+from - 1) },
          });
        if (isPrimary) {
          const primary = await tx.employeeDeviceEnrolment.findMany({
            where: { tenantId, employeeId, isPrimary: true, NOT: { sn } },
          });
          if (primary.some((r) => enrolmentEnd(r) >= +from))
            throw captureError(
              "Clear the existing primary from this date before assigning another device",
              409,
            );
        }
        const created = await tx.employeeDeviceEnrolment.create({
          data: {
            tenantId,
            employeeId,
            sn,
            deviceUserId: newDeviceUserId,
            effectiveFrom: from,
            isPrimary,
            note,
          },
        });
        await captureAudit(tx, {
          tenantId,
          actorId,
          action: "ENROLMENT_CREATED",
          reason: note,
          detail: created,
        });
        return created;
      },
      { system: true },
    ),
  );
}
