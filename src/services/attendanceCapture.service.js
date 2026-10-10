import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  captureError,
  fingerprint,
  jsonValue,
  MAX_CAPTURE_ROWS,
  parseCaptureRow,
  parseCaptureTimestamp,
  chooseEnrolment,
  validTimeZone,
} from "../lib/attendanceCapture.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const system = (fn) => mcpCtx.run({ system: true }, fn);
export const devicePublic = (device) => {
  const safe = { ...device };
  delete safe.credentialHash;
  return safe;
};
export async function captureAudit(
  tx,
  {
    tenantId,
    eventId,
    receiptId,
    actorId = "attendance-capture",
    action,
    reason,
    detail = {},
  },
) {
  return tx.attendanceCaptureAudit.create({
    data: {
      tenantId,
      eventId,
      receiptId,
      actorId: String(actorId),
      action,
      reason,
      detail: jsonValue(detail),
    },
  });
}
export async function registerCaptureDevice(
  { tenantId, actorId, sn, name, timeZone, staleAfterMinutes = 30 },
  db = prisma,
) {
  if (
    !tenantId ||
    !/^[\w.-]{1,64}$/.test(sn || "") ||
    !name?.trim() ||
    !validTimeZone(timeZone)
  )
    throw captureError("Tenant, serial, name and valid timezone are required");
  if (
    !Number.isInteger(staleAfterMinutes) ||
    staleAfterMinutes < 1 ||
    staleAfterMinutes > 10080
  )
    throw captureError("Stale threshold must be 1–10080 minutes");
  const credential = randomBytes(32).toString("hex");
  return tenantTransaction(
    db,
    async (tx) => {
      const device = await tx.attendanceCaptureDevice.create({
        data: {
          tenantId,
          sn,
          name: name.trim(),
          timeZone,
          allowedTenantIds: [tenantId],
          credentialHash: fingerprint(credential),
          staleAfterMinutes,
        },
      });
      await captureAudit(tx, {
        tenantId,
        actorId,
        action: "DEVICE_REGISTERED",
        reason: "Registered attendance device",
        detail: { sn, timeZone },
      });
      return { device: devicePublic(device), credential };
    },
    { tenantId },
  );
}
export async function updateCaptureDevice(
  { tenantId, actorId, id, active, rotateCredential = false, reason },
  db = prisma,
) {
  if (!reason?.trim()) throw captureError("A reason is required");
  const credential = rotateCredential ? randomBytes(32).toString("hex") : null;
  return tenantTransaction(
    db,
    async (tx) => {
      const device = await tx.attendanceCaptureDevice.findFirst({
        where: { id, tenantId },
      });
      if (!device) throw captureError("Device not found", 404);
      const updated = await tx.attendanceCaptureDevice.update({
        where: { id, tenantId },
        data: {
          ...(typeof active === "boolean" ? { active } : {}),
          ...(credential
            ? {
                credentialHash: fingerprint(credential),
                legacyKeyAllowed: false,
              }
            : {}),
        },
      });
      await captureAudit(tx, {
        tenantId,
        actorId,
        action: credential ? "DEVICE_CREDENTIAL_ROTATED" : "DEVICE_UPDATED",
        reason,
        detail: { id, active: updated.active },
      });
      return {
        device: devicePublic(updated),
        ...(credential ? { credential } : {}),
      };
    },
    { tenantId },
  );
}
export async function authenticateCaptureDevice(sn, credential, db = prisma) {
  const device = await system(
    async () =>
      await db.attendanceCaptureDevice.findUnique({
        where: { sn: String(sn || "") },
      }),
  );
  const expected =
    device?.credentialHash ||
    (device?.legacyKeyAllowed && process.env.HR_ATTENDANCE_INTAKE_KEY
      ? fingerprint(process.env.HR_ATTENDANCE_INTAKE_KEY)
      : null);
  if (
    !device?.active ||
    !expected ||
    !credential ||
    !timingSafeEqual(
      Buffer.from(fingerprint(credential)),
      Buffer.from(expected),
    )
  )
    throw captureError("Invalid device credentials", 403);
  return device;
}

// Only trusted adapters call this service. HTTP authenticates the registered
// device first; operator tools supply the verified tenant, never a body tenant.
export async function receiveCapture(
  {
    sn,
    rows,
    source = "DEVICE_PUSH",
    requestKey,
    actorId,
    manualEmployeeId,
    tenantId,
    dryRun = false,
    notes,
  },
  db = prisma,
) {
  if (source === "DEVICE_SYNC" && !tenantId)
    throw captureError("Verified tenant is required for device sync", 403);
  if (
    !["DEVICE_PUSH", "DEVICE_SYNC", "DEVICE_LISTENER", "MANUAL"].includes(
      source,
    )
  )
    throw captureError("Invalid capture source");
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_CAPTURE_ROWS)
    throw captureError(`Send 1–${MAX_CAPTURE_ROWS} punch rows`);
  if (rows.some((r) => typeof r !== "string" || r.length > 4096))
    throw captureError("Each punch must be text of at most 4096 characters");
  if (requestKey && (typeof requestKey !== "string" || requestKey.length > 128))
    throw captureError("Invalid request key");
  return system(async () => {
    let device;
    if (source === "MANUAL") {
      if (!tenantId || !Number.isInteger(manualEmployeeId))
        throw captureError("Verified tenant and employee are required");
      const employee = await db.employee.findFirst({
        where: { id: manualEmployeeId, tenant_id: tenantId },
      });
      if (!employee) throw captureError("Employee not found", 404);
      const release = await db.attendanceSetupRelease.findFirst({
        where: { tenantId },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      });
      const timeZone = release?.config?.settings?.timeZone;
      if (!timeZone)
        throw captureError(
          "Publish attendance configuration before manual capture",
          409,
        );
      device = {
        tenantId,
        sn: `MANUAL:${tenantId}`,
        timeZone,
        active: true,
        allowedTenantIds: [tenantId],
      };
      sn = device.sn;
    } else {
      device = await db.attendanceCaptureDevice.findUnique({
        where: { sn: String(sn || "") },
      });
      if (!device?.active)
        throw captureError(
          "Register and activate the device before receiving punches",
          409,
        );
      if (tenantId && !device.allowedTenantIds.includes(tenantId))
        throw captureError("Device is not permitted for this tenant", 403);
    }
    const owner = tenantId || device.tenantId;
    const payloadHash = fingerprint({ sn, source, rows, notes });
    const key = requestKey || payloadHash;
    const oldReceipt = await db.attendanceCaptureReceipt.findUnique({
      where: {
        tenantId_source_requestKey: {
          tenantId: owner,
          source,
          requestKey: key,
        },
      },
    });
    if (oldReceipt) {
      if (oldReceipt.payloadHash !== payloadHash)
        throw captureError(
          "Request key already belongs to a different submission",
          409,
        );
      if (source === "DEVICE_PUSH" && !dryRun)
        await db.attendanceCaptureDevice.update({
          where: { id: device.id },
          data: { lastSeenAt: new Date() },
        });
      return {
        receiptId: oldReceipt.id,
        ...oldReceipt.summary,
        replayed: true,
      };
    }
    const parsed = rows.map((raw) => {
      try {
        return { raw, parsed: parseCaptureRow(raw, device.timeZone) };
      } catch (err) {
        return { raw, reason: err.message };
      }
    });
    const ids = [
      ...new Set(
        parsed.flatMap((r) => (r.parsed ? [r.parsed.deviceUserId] : [])),
      ),
    ];
    const enrolments =
      source === "MANUAL"
        ? []
        : await db.employeeDeviceEnrolment.findMany({
            where: { deviceUserId: { in: ids }, OR: [{ sn }, { sn: null }] },
          });
    const byDeviceUser = new Map();
    for (const row of enrolments) {
      if (!byDeviceUser.has(row.deviceUserId))
        byDeviceUser.set(row.deviceUserId, []);
      byDeviceUser.get(row.deviceUserId).push(row);
    }
    const receiptId = randomUUID();
    const events = parsed.map(({ raw, parsed: punch, reason }) => {
      const hit = punch
        ? source === "MANUAL"
          ? { employeeId: manualEmployeeId, tenantId }
          : chooseEnrolment(
              byDeviceUser.get(punch.deviceUserId) || [],
              punch.deviceUserId,
              sn,
              punch.punchedAt,
              source === "DEVICE_SYNC" ? [tenantId] : device.allowedTenantIds,
            )
        : {};
      const issue = reason || hit.reason;
      return {
        id: randomUUID(),
        tenantId: hit.tenantId || owner,
        receiptId,
        source,
        sn,
        fingerprint: fingerprint(
          punch
            ? [
                sn,
                punch.deviceUserId,
                punch.punchedAt.toISOString(),
                punch.status,
              ]
            : [sn, raw],
        ),
        deviceUserId: punch?.deviceUserId,
        raw: {
          line: raw,
          receivedAt: new Date().toISOString(),
          ...(notes ? { notes: String(notes).slice(0, 2000) } : {}),
        },
        ...(punch ? { parsed: jsonValue(punch) } : {}),
        employeeId: hit.employeeId,
        enrolmentId: hit.enrolmentId,
        state: issue ? "NEEDS_REVIEW" : "PENDING",
        reason: issue || null,
      };
    });
    if (dryRun)
      return {
        dryRun: true,
        received: rows.length,
        pending: events.filter((e) => e.state === "PENDING").length,
        issues: events
          .filter((e) => e.reason)
          .map((e) => ({ deviceUserId: e.deviceUserId, reason: e.reason })),
      };
    try {
      return await tenantTransaction(
        db,
        async (tx) => {
          // Serialize identical receipt submissions without catching a PostgreSQL
          // uniqueness error inside an already-aborted transaction.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${owner}:${source}:${key}`}))`;
          const existing = await tx.attendanceCaptureReceipt.findUnique({
            where: {
              tenantId_source_requestKey: {
                tenantId: owner,
                source,
                requestKey: key,
              },
            },
          });
          if (existing) {
            if (existing.payloadHash !== payloadHash)
              throw captureError(
                "Request key already belongs to a different submission",
                409,
              );
            return {
              receiptId: existing.id,
              ...existing.summary,
              replayed: true,
            };
          }
          const stored = await tx.attendanceCaptureEvent.createMany({
            data: events,
            skipDuplicates: true,
          });
          const inserted = await tx.attendanceCaptureEvent.findMany({
            where: { receiptId },
            select: { state: true },
          });
          const duplicateEvents = await tx.attendanceCaptureEvent.findMany({
            where: {
              fingerprint: { in: events.map((e) => e.fingerprint) },
              NOT: { receiptId },
            },
            select: { id: true, tenantId: true },
          });
          if (duplicateEvents.length)
            await tx.attendanceCaptureAudit.createMany({
              data: duplicateEvents.map((e) => ({
                tenantId: e.tenantId,
                eventId: e.id,
                receiptId,
                actorId: String(actorId || "attendance-capture"),
                action: "DUPLICATE_RECEIVED",
                reason:
                  "Repeated delivery preserved; attendance is not evaluated again",
                detail: { source },
              })),
            });
          const summary = {
            received: rows.length,
            stored: stored.count,
            duplicates: rows.length - stored.count,
            pending: inserted.filter((e) => e.state === "PENDING").length,
            needsReview: inserted.filter((e) => e.state === "NEEDS_REVIEW")
              .length,
          };
          await tx.attendanceCaptureReceipt.create({
            data: {
              id: receiptId,
              tenantId: owner,
              source,
              sn,
              requestKey: key,
              payloadHash,
              actorId: actorId == null ? null : String(actorId),
              summary,
            },
          });
          if (device.id && source === "DEVICE_PUSH")
            await tx.attendanceCaptureDevice.update({
              where: { id: device.id },
              data: { lastSeenAt: new Date() },
            });
          await captureAudit(tx, {
            tenantId: owner,
            receiptId,
            actorId,
            action: "CAPTURE_RECEIVED",
            reason: "Durable attendance receipt",
            detail: summary,
          });
          return { receiptId, ...summary, replayed: false };
        },
        { system: true, txOptions: { timeout: 30000 } },
      );
    } catch (err) {
      throw err;
    }
  });
}

export async function captureOverview(
  { tenantId, now = new Date() },
  db = prisma,
) {
  const [devices, counts, oldest, recent] = await Promise.all([
    db.attendanceCaptureDevice.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
    }),
    db.attendanceCaptureEvent.groupBy({
      by: ["state"],
      where: { tenantId },
      _count: { _all: true },
    }),
    db.attendanceCaptureEvent.findFirst({
      where: {
        tenantId,
        state: { in: ["PENDING", "FAILED", "NEEDS_REVIEW", "PROCESSING"] },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.attendanceCaptureEvent.findMany({
      where: { tenantId, processedAt: { gte: new Date(+now - 86400000) } },
      select: { createdAt: true, processedAt: true },
      take: 1000,
      orderBy: { processedAt: "desc" },
    }),
  ]);
  const latencies = recent
    .map((e) => +e.processedAt - +e.createdAt)
    .sort((a, b) => a - b);
  return {
    devices: devices.map((d) => ({
      ...devicePublic(d),
      stale: !d.lastSeenAt || now - d.lastSeenAt > d.staleAfterMinutes * 60000,
    })),
    counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])),
    oldestPendingAt: oldest?.createdAt,
    processingP95Ms: latencies.length
      ? latencies[
          Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
        ]
      : null,
    latencySampleSize: latencies.length,
  };
}
export async function listCaptureEvents(
  { tenantId, state, afterId, employeeId, sn, limit = 50 },
  db = prisma,
) {
  const take = Math.min(100, Math.max(1, limit));
  const cursor = afterId
    ? await db.attendanceCaptureEvent.findFirst({
        where: { id: afterId, tenantId },
      })
    : null;
  if (afterId && !cursor)
    throw captureError("Evidence cursor is no longer available", 409);
  const rows = await db.attendanceCaptureEvent.findMany({
    where: {
      tenantId,
      ...(state ? { state } : {}),
      ...(employeeId ? { employeeId } : {}),
      ...(sn ? { sn } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });
  return {
    items: rows.slice(0, take),
    nextCursor: rows.length > take ? rows[take - 1].id : null,
  };
}

export async function captureHeartbeat(
  { device, deviceTime, now = new Date() },
  db = prisma,
) {
  const clock = deviceTime
    ? parseCaptureTimestamp(deviceTime, device.timeZone)
    : null;
  return system(
    async () =>
      await db.attendanceCaptureDevice.update({
        where: { id: device.id },
        data: {
          lastSeenAt: now,
          ...(clock
            ? {
                clockOffsetSeconds: Math.round(
                  (+clock.occurredAt - +now) / 1000,
                ),
                clockSampledAt: now,
              }
            : {}),
        },
        select: { id: true, lastSeenAt: true, clockOffsetSeconds: true },
      }),
  );
}

export async function monitorCaptureDevices(
  { now = new Date(), afterId } = {},
  db = prisma,
) {
  return system(async () => {
    const devices = await db.attendanceCaptureDevice.findMany({
      where: { active: true, ...(afterId ? { id: { gt: afterId } } : {}) },
      take: 200,
      orderBy: { id: "asc" },
    });
    for (const device of devices) {
      const stale =
        now - new Date(device.lastSeenAt || device.createdAt) >
        device.staleAfterMinutes * 60000;
      const drift =
        device.clockOffsetSeconds != null &&
        Math.abs(device.clockOffsetSeconds) > 120;
      const state = stale ? "STALE" : drift ? "CLOCK_DRIFT" : "HEALTHY";
      if (state === device.lastHealthState) continue;
      await tenantTransaction(
        db,
        async (tx) => {
          const changed = await tx.attendanceCaptureDevice.updateMany({
            where: {
              id: device.id,
              lastHealthState: device.lastHealthState ?? null,
            },
            data: { lastHealthState: state },
          });
          if (!changed.count) return;
          await enqueueHrDomainEvent(tx, {
            tenantId: device.tenantId,
            eventName: "hr.attendance.device_health_changed.v1",
            actorId: "attendance-capture",
            aggregateType: "AttendanceDevice",
            aggregateId: device.id,
            payload: {
              deviceId: device.id,
              sn: device.sn,
              state,
              previousState: device.lastHealthState ?? null,
              clockOffsetSeconds: device.clockOffsetSeconds ?? null,
            },
          });
        },
        { system: true },
      );
    }
    return { nextCursor: devices.length === 200 ? devices.at(-1).id : null };
  });
}

// A newly created dated enrolment can resolve old receipts without inventing
// identities from current biometric IDs. SYSTEM is needed only for the shared
// device's routing; allowedTenantIds and the original serial remain mandatory.
export async function reconcileCaptureIdentities(
  { afterId } = {},
  db = prisma,
) {
  return system(async () => {
    const rows = await db.attendanceCaptureEvent.findMany({
      where: {
        state: "NEEDS_REVIEW",
        employeeId: null,
        reason: {
          in: [
            "UNKNOWN_IDENTITY",
            "OUTSIDE_ENROLMENT_PERIOD",
            "AMBIGUOUS_ENROLMENT",
          ],
        },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      take: 100,
      orderBy: { id: "asc" },
    });
    const sns = [...new Set(rows.map((r) => r.sn))],
      ids = [...new Set(rows.map((r) => r.deviceUserId))];
    const [devices, enrolments] = await Promise.all([
      db.attendanceCaptureDevice.findMany({
        where: { sn: { in: sns }, active: true },
      }),
      db.employeeDeviceEnrolment.findMany({
        where: {
          deviceUserId: { in: ids },
          OR: [{ sn: { in: sns } }, { sn: null }],
        },
      }),
    ]);
    for (const row of rows) {
      const device = devices.find((d) => d.sn === row.sn);
      if (!device || !row.parsed) continue;
      const hit = chooseEnrolment(
        enrolments,
        row.deviceUserId,
        row.sn,
        new Date(row.parsed.punchedAt),
        device.allowedTenantIds,
      );
      if (hit.reason) continue;
      await tenantTransaction(
        db,
        async (tx) => {
          const changed = await tx.attendanceCaptureEvent.updateMany({
            where: { id: row.id, version: row.version, employeeId: null },
            data: {
              ...hit,
              state: "PENDING",
              reason: null,
              nextAttemptAt: new Date(),
              version: { increment: 1 },
            },
          });
          if (!changed.count) return;
          if (row.tenantId !== hit.tenantId)
            await captureAudit(tx, {
              tenantId: row.tenantId,
              eventId: row.id,
              action: "IDENTITY_ROUTED",
              reason: "Resolved to a permitted company enrolment",
              detail: { destinationTenantId: hit.tenantId },
            });
          await captureAudit(tx, {
            tenantId: hit.tenantId,
            eventId: row.id,
            action: "IDENTITY_RESOLVED",
            reason: "Unambiguous dated device enrolment became available",
            detail: {
              enrolmentId: hit.enrolmentId,
              employeeId: hit.employeeId,
              sn: row.sn,
            },
          });
        },
        { system: true },
      );
    }
    return { nextCursor: rows.length === 100 ? rows.at(-1).id : null };
  });
}
export async function captureTrace({ tenantId, id }, db = prisma) {
  const event = await db.attendanceCaptureEvent.findFirst({
    where: { tenantId, id },
  });
  if (!event) throw captureError("Capture event not found", 404);
  const [audit, punch] = await Promise.all([
    db.attendanceCaptureAudit.findMany({
      where: { tenantId, eventId: id },
      orderBy: { createdAt: "asc" },
    }),
    db.attendanceDevicePunch.findFirst({
      where: { tenantId, captureEventId: id },
    }),
  ]);
  return { event, punch, audit };
}
export async function reviewCaptureEvents(
  { tenantId, actorId, items, action, reason },
  db = prisma,
) {
  if (
    !reason?.trim() ||
    !items?.length ||
    items.length > 100 ||
    !["RETRY", "RESOLVE", "DISMISS"].includes(action)
  )
    throw captureError("Provide an action, reason and 1–100 events");
  return tenantTransaction(
    db,
    async (tx) => {
      const results = [];
      for (const { id, version, employeeId } of items) {
        const event = await tx.attendanceCaptureEvent.findFirst({
          where: { id, tenantId, version },
        });
        if (!event || !["NEEDS_REVIEW", "FAILED"].includes(event.state))
          throw captureError(
            "Event changed or is not reviewable; reload the inbox",
            409,
          );
        let hit = {};
        if (action === "RESOLVE") {
          if (!event.parsed)
            throw captureError(
              "Invalid evidence cannot be relabelled; dismiss it and submit corrected evidence",
            );
          const enrolments = await tx.employeeDeviceEnrolment.findMany({
            where: {
              tenantId,
              deviceUserId: event.deviceUserId,
              OR: [{ sn: event.sn }, { sn: null }],
            },
          });
          hit = chooseEnrolment(
            enrolments,
            event.deviceUserId,
            event.sn,
            new Date(event.parsed.punchedAt),
            [tenantId],
          );
          if (hit.reason || (employeeId && hit.employeeId !== employeeId))
            throw captureError(
              "Create an unambiguous dated enrolment for this employee before resolving",
              409,
            );
        }
        if (action === "RETRY" && (!event.employeeId || !event.parsed))
          throw captureError(
            "Resolve the identity or invalid evidence first",
            409,
          );
        const changed = await tx.attendanceCaptureEvent.updateMany({
          where: { id, tenantId, version },
          data: {
            ...hit,
            state: action === "DISMISS" ? "DISMISSED" : "PENDING",
            reason: null,
            attempts: 0,
            nextAttemptAt: new Date(),
            leaseToken: null,
            leaseUntil: null,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1)
          throw captureError("Event changed; reload the inbox", 409);
        await captureAudit(tx, {
          tenantId,
          eventId: id,
          actorId,
          action,
          reason,
          detail: {
            previousState: event.state,
            previousEmployeeId: event.employeeId,
            employeeId: hit.employeeId || event.employeeId,
          },
        });
        results.push(id);
      }
      return { updated: results.length, ids: results };
    },
    { tenantId },
  );
}

// Operations-only: not exposed as a tenant MCP tool. Shared-device routing is
// configured by a deployment operator from verified company IDs.
export async function configureSharedCaptureDevice(
  { sn, allowedTenantIds, actorId, reason, previewToken },
  db = prisma,
) {
  if (
    !reason?.trim() ||
    !actorId ||
    !Array.isArray(allowedTenantIds) ||
    !allowedTenantIds.length ||
    !allowedTenantIds.every((id) =>
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id),
    )
  )
    throw captureError(
      "Verified tenant UUIDs, operator and reason are required",
    );
  return system(() =>
    tenantTransaction(
      db,
      async (tx) => {
        const device = await tx.attendanceCaptureDevice.findUnique({
          where: { sn },
        });
        if (!device || !allowedTenantIds.includes(device.tenantId))
          throw captureError(
            "Include the registered owner among permitted tenants",
            409,
          );
        const next = [...new Set(allowedTenantIds)].sort();
        const token = fingerprint({
          id: device.id,
          previous: device.allowedTenantIds,
          next,
          reason,
        });
        if (!previewToken)
          return {
            sn,
            previous: device.allowedTenantIds,
            allowedTenantIds: next,
            previewToken: token,
          };
        if (previewToken !== token)
          throw captureError("Device routing changed; preview again", 409);
        await tx.attendanceCaptureDevice.update({
          where: { id: device.id },
          data: { allowedTenantIds: next },
        });
        await captureAudit(tx, {
          tenantId: device.tenantId,
          actorId,
          action: "DEVICE_ROUTING_CHANGED",
          reason,
          detail: {
            sn,
            previous: device.allowedTenantIds,
            allowedTenantIds: next,
          },
        });
        return { sn, allowedTenantIds: next, applied: true };
      },
      { system: true },
    ),
  );
}
