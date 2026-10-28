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
  chooseEnrolments,
  punchFingerprint,
  legacyPunchFingerprints,
  validTimeZone,
} from "../lib/attendanceCapture.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const system = (fn) => mcpCtx.run({ system: true }, fn);

// A planned event repeats a stored one when that company's own copy exists, or
// the company-neutral (or pre-ATT-PUNCH-KEY-01) key of the same punch is
// already held by this company or still unattributed. Identity recovery owns
// resolving an unattributed event for each company that later enrols the ID.
async function partitionRepeats(db, events, sn) {
  const keys = new Map();
  for (const event of events) {
    if (!event.parsed) {
      keys.set(event.id, { own: [event.fingerprint], neutral: [] });
      continue;
    }
    const punch = {
      deviceUserId: event.parsed.deviceUserId,
      punchedAt: new Date(event.parsed.punchedAt),
    };
    keys.set(event.id, {
      own: [punchFingerprint(sn, punch, event.tenantId)],
      neutral: [punchFingerprint(sn, punch), ...legacyPunchFingerprints(sn, punch)],
    });
  }
  const all = [...new Set([...keys.values()].flatMap((k) => [...k.own, ...k.neutral]))];
  const stored = all.length
    ? await db.attendanceCaptureEvent.findMany({
        where: { fingerprint: { in: all } },
        select: { id: true, tenantId: true, employeeId: true, fingerprint: true, parsed: true },
      })
    : [];
  const byKey = new Map(stored.map((r) => [r.fingerprint, r]));
  const fresh = [],
    repeats = [];
  for (const event of events) {
    const { own, neutral } = keys.get(event.id);
    const existing =
      own.map((k) => byKey.get(k)).find(Boolean) ||
      neutral
        .map((k) => byKey.get(k))
        .find((r) => r && (r.tenantId === event.tenantId || r.employeeId == null));
    if (existing) repeats.push({ event, existing });
    else fresh.push(event);
  }
  return { fresh, repeats };
}
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
          active: false,
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
      if (active === true && !device.active)
        throw captureError("Activate through the HR onsite acceptance package after HR verification and Management approval", 409);
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
      if (device.biometricPublicKey)
        throw captureError(
          "Biometric kiosks must use the signed biometric capture endpoint",
          403,
        );
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
    const supervised =
      device.acceptanceMode === "SUPERVISED" ? "ONSITE_SUPERVISED_REVIEW" : null;
    const events = parsed.flatMap(({ raw, parsed: punch, reason }) => {
      const outcome = punch
        ? source === "MANUAL"
          ? { hits: [{ employeeId: manualEmployeeId, tenantId }], issues: [] }
          : chooseEnrolments(
              byDeviceUser.get(punch.deviceUserId) || [],
              punch.deviceUserId,
              sn,
              punch.punchedAt,
              source === "DEVICE_SYNC" ? [tenantId] : device.allowedTenantIds,
            )
        : {};
      // ATT-DEVICE-PER-COMPANY-01: one copy per company that enrolled the ID,
      // each resolved (or held for review) by that company alone.
      const targets = outcome.hits
        ? [
            ...outcome.hits.map((hit) => ({ ...hit, issue: null })),
            ...outcome.issues.map((i) => ({ tenantId: i.tenantId, issue: i.reason })),
          ]
        : [{ issue: outcome.reason || null }];
      const perCompany = targets.length > 1;
      return targets.map((target) => {
        const issue = reason || target.issue || supervised;
        return {
          id: randomUUID(),
          tenantId: target.tenantId || owner,
          receiptId,
          source,
          sn,
          fingerprint: punch
            ? punchFingerprint(sn, punch, perCompany ? target.tenantId : null)
            : fingerprint([sn, raw]),
          deviceUserId: punch?.deviceUserId,
          raw: {
            ...(device.acceptanceSiteRef ? { acceptanceSiteRef: device.acceptanceSiteRef, acceptanceMode: device.acceptanceMode } : {}),
            line: raw,
            receivedAt: new Date().toISOString(),
            ...(notes ? { notes: String(notes).slice(0, 2000) } : {}),
            ...(perCompany ? { companies: targets.map((t) => t.tenantId) } : {}),
          },
          ...(punch ? { parsed: jsonValue(punch) } : {}),
          employeeId: target.employeeId,
          enrolmentId: target.enrolmentId,
          state: issue ? "NEEDS_REVIEW" : "PENDING",
          reason: issue || null,
        };
      });
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
          const { fresh, repeats } = await partitionRepeats(tx, events, sn);
          const stored = await tx.attendanceCaptureEvent.createMany({
            data: fresh,
            skipDuplicates: true,
          });
          const inserted = await tx.attendanceCaptureEvent.findMany({
            where: { receiptId },
            select: { state: true },
          });
          if (repeats.length)
            await tx.attendanceCaptureAudit.createMany({
              data: repeats.map(({ event, existing }) => {
                const conflict =
                  existing.parsed?.status != null &&
                  event.parsed?.status != null &&
                  existing.parsed.status !== event.parsed.status;
                return {
                  tenantId: existing.tenantId,
                  eventId: existing.id,
                  receiptId,
                  actorId: String(actorId || "attendance-capture"),
                  action: conflict ? "DIRECTION_CONFLICT" : "DUPLICATE_RECEIVED",
                  reason: conflict
                    ? "Same punch re-delivered with a different direction; the stored punch is kept"
                    : "Repeated delivery preserved; attendance is not evaluated again",
                  detail: conflict
                    ? { source, storedStatus: existing.parsed.status, receivedStatus: event.parsed.status }
                    : { source },
                };
              }),
            });
          const summary = {
            received: rows.length,
            stored: stored.count,
            duplicates: events.length - stored.count,
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
  const people = await db.employee.findMany({ where: { tenant_id: tenantId, id: { in: [...new Set(rows.map(row => row.employeeId).filter(Boolean))] } }, select: { id: true, employee_code: true } });
  const codes = new Map(people.map(person => [person.id, person.employee_code]));
  return {
    items: rows.slice(0, take).map(row => ({ ...row, employeeCode: codes.get(row.employeeId) || null })),
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
      const outcome = chooseEnrolments(
        enrolments,
        row.deviceUserId,
        row.sn,
        new Date(row.parsed.punchedAt),
        device.allowedTenantIds,
      );
      if (outcome.reason) continue;
      // ATT-DEVICE-PER-COMPANY-01: a company's own held copy resolves only for
      // that company. A company-neutral unresolved event becomes the copy for
      // the company it was received under (else the first match), and every
      // other company that now enrols the ID receives its own copy.
      const perCompanyCopy = Array.isArray(row.raw?.companies);
      const hit =
        outcome.hits.find((h) => h.tenantId === row.tenantId) ||
        (perCompanyCopy ? null : outcome.hits[0]);
      if (!hit) continue;
      const copies = perCompanyCopy ? [] : outcome.hits.filter((h) => h !== hit);
      await tenantTransaction(
        db,
        async (tx) => {
          const shareCopies = async () => {
            if (!copies.length) return;
            const punch = {
              deviceUserId: row.parsed.deviceUserId,
              punchedAt: new Date(row.parsed.punchedAt),
            };
            await tx.attendanceCaptureEvent.createMany({
              data: copies.map((copy) => ({
                id: randomUUID(),
                tenantId: copy.tenantId,
                receiptId: row.receiptId,
                source: row.source,
                sn: row.sn,
                fingerprint: punchFingerprint(row.sn, punch, copy.tenantId),
                deviceUserId: row.deviceUserId,
                raw: jsonValue({
                  ...row.raw,
                  companies: outcome.hits.map((h) => h.tenantId),
                  copiedFrom: row.id,
                }),
                parsed: row.parsed,
                employeeId: copy.employeeId,
                enrolmentId: copy.enrolmentId,
                state: "PENDING",
                reason: null,
                nextAttemptAt: new Date(),
              })),
              skipDuplicates: true,
            });
            for (const copy of copies)
              await captureAudit(tx, {
                tenantId: copy.tenantId,
                eventId: row.id,
                action: "IDENTITY_RESOLVED_FOR_COMPANY",
                reason: "Another company enrolled this device ID; punch resolved for it independently",
                detail: { employeeId: copy.employeeId, enrolmentId: copy.enrolmentId },
              });
          };
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
          await shareCopies();
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
  const {attendanceActorCodes}=await import('../lib/attendanceActorCodes.js');
  const codes=await attendanceActorCodes(db,tenantId,[...audit.map(a=>a.actorId),event.biometricApprovedBy]);
  return { event:{...event,biometricApprovedByCode:codes.get(String(event.biometricApprovedBy)) || null}, punch, audit:audit.map(a=>({...a,actorCode:codes.get(String(a.actorId)) || null})) };
}
export async function reviewCaptureEvents(
  { tenantId, actorId, items, action, reason },
  db = prisma,
) {
  if (
    !reason?.trim() ||
    !items?.length ||
    items.length > 100 ||
    !["RETRY", "RESOLVE", "DISMISS", "APPROVE_BIOMETRIC"].includes(action)
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
        if (event.raw?.acceptanceMode === "SUPERVISED" && action !== "DISMISS")
          throw captureError("Supervised evidence requires an employee attendance correction with line-manager, HR and Management approval; it cannot be released by Retry or Resolve",409);
        if (event.source === "BIOMETRIC") {
          if (action === "RESOLVE")
            throw captureError(
              "Biometric identity cannot be reassigned; dismiss incorrect evidence",
              409,
            );
          if (action !== "DISMISS" && !event.raw?.biometric?.matched)
            throw captureError(
              "A failed biometric match cannot be approved",
              409,
            );
          if (
            action === "RETRY" &&
            (event.raw.biometric.pad !== "PASSED" ||
              event.raw.biometric.delayedUpload) &&
            !event.biometricApprovedBy
          )
            throw captureError(
              "Unverified liveness or delayed upload requires explicit biometric exception approval",
              409,
            );
        }
        if (action === "APPROVE_BIOMETRIC") {
          if (
            event.source !== "BIOMETRIC" ||
            !["UNKNOWN", "PASSED"].includes(event.raw?.biometric?.pad) ||
            (event.raw.biometric.pad === "PASSED" &&
              !event.raw.biometric.delayedUpload) ||
            !event.raw.biometric.matched ||
            !actorId
          )
            throw captureError(
              "Only a matched biometric with unverified liveness or delayed upload can receive exception approval",
              409,
            );
          if (String(actorId) === String(event.raw.biometric.enrolledBy))
            throw captureError(
              "A different HR operator must approve this enrolment's biometric exception",
              403,
            );
          hit = {
            biometricApprovedBy: String(actorId),
            biometricApprovedAt: new Date(),
          };
        }
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
