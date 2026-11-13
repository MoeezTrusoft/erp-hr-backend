// src/services/attendanceDeviceAccess.service.js
//
// ATT-DEVICE-ACCESS-01 — companies configure the capture devices they use.
//
// A device belongs to the company that registered it. Another company can ask
// to use it; only the owning company can approve. Approval adds the requester
// to the device's allowedTenantIds, after which each company resolves punches
// against its own enrolments only. Either side can end the access later, and
// the owner can never be removed from its own device.
//
// Requests are read by two companies, so every operation runs under SYSTEM with
// explicit company filters rather than the single-tenant ORM scope.
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { captureError } from "../lib/attendanceCapture.js";
import { captureAudit } from "./attendanceCapture.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const OPEN = ["PENDING", "APPROVED"];
const system = (fn) => mcpCtx.run({ system: true }, fn);
const required = (value, label) => {
  if (typeof value !== "string" || !value.trim())
    throw captureError(`${label} is required`, 400);
  return value.trim().slice(0, 2000);
};

// A device as another company sees it: no credential, no list of other users.
const sharedView = (d) => ({
  id: d.id,
  sn: d.sn,
  name: d.name,
  timeZone: d.timeZone,
  active: d.active,
  ownerTenantId: d.tenantId,
  lastSeenAt: d.lastSeenAt ?? null,
});
const ownedView = (d) => ({ ...sharedView(d), allowedTenantIds: d.allowedTenantIds });

const transaction = (db, fn) =>
  system(() => tenantTransaction(db, fn, { system: true }));

async function lockDevice(tx, deviceId) {
  if (tx.$executeRaw)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-access:${deviceId}`}))`;
}

async function setCompanies(tx, device, next, { actorId, reason, requestId }) {
  const allowedTenantIds = [...new Set(next)].sort();
  await tx.attendanceCaptureDevice.update({
    where: { id: device.id },
    data: { allowedTenantIds },
  });
  await captureAudit(tx, {
    tenantId: device.tenantId,
    actorId,
    action: "DEVICE_ROUTING_CHANGED",
    reason,
    detail: {
      sn: device.sn,
      previous: device.allowedTenantIds,
      allowedTenantIds,
      ...(requestId ? { requestId } : {}),
    },
  });
}

async function emit(tx, tenantId, eventName, actorId, request) {
  await enqueueHrDomainEvent(tx, {
    tenantId,
    eventName,
    actorId: String(actorId),
    aggregateType: "AttendanceDeviceAccess",
    aggregateId: request.id,
    payload: {
      requestId: request.id,
      deviceId: request.deviceId,
      sn: request.sn,
      state: request.state,
      requestingTenantId: request.tenantId,
      ownerTenantId: request.ownerTenantId,
    },
  });
}

export async function requestDeviceAccess(
  { tenantId, actorId, sn, reason },
  db = prisma,
) {
  const why = required(reason, "Reason");
  return transaction(db, async (tx) => {
    const device = await tx.attendanceCaptureDevice.findUnique({
      where: { sn: String(sn || "") },
    });
    if (!device?.active)
      throw captureError("Device not found or not active", 404);
    if (device.tenantId === tenantId)
      throw captureError("Your company owns this device", 409);
    if (device.allowedTenantIds.includes(tenantId))
      throw captureError("Your company already uses this device", 409);
    await lockDevice(tx, device.id);
    const open = await tx.attendanceDeviceAccessRequest.findFirst({
      where: { deviceId: device.id, tenantId, state: { in: OPEN } },
    });
    if (open)
      throw captureError("An open request for this device already exists", 409);
    const request = await tx.attendanceDeviceAccessRequest.create({
      data: {
        tenantId,
        ownerTenantId: device.tenantId,
        deviceId: device.id,
        sn: device.sn,
        state: "PENDING",
        reason: why,
        requestedBy: String(actorId),
        version: 1,
      },
    });
    await emit(tx, device.tenantId, "hr.attendance.device_access_requested.v1", actorId, request);
    return request;
  });
}

async function openRequest(tx, { id, version }) {
  const request = await tx.attendanceDeviceAccessRequest.findUnique({
    where: { id },
  });
  return { request, stale: request && request.version !== version };
}

export async function decideDeviceAccess(
  { tenantId, actorId, id, version, decision, reason },
  db = prisma,
) {
  const why = required(reason, "Reason");
  if (!["APPROVE", "REJECT"].includes(decision))
    throw captureError("Decision must be APPROVE or REJECT", 400);
  return transaction(db, async (tx) => {
    const { request, stale } = await openRequest(tx, { id, version });
    if (!request || ![request.tenantId, request.ownerTenantId].includes(tenantId))
      throw captureError("Request not found", 404);
    if (request.ownerTenantId !== tenantId)
      throw captureError("Only the company that owns the device can decide", 403);
    await lockDevice(tx, request.deviceId);
    if (stale) throw captureError("Request changed; reload and try again", 409);
    if (request.state !== "PENDING")
      throw captureError(`Request is already ${request.state.toLowerCase()}`, 409);
    const approve = decision === "APPROVE";
    if (approve) {
      const device = await tx.attendanceCaptureDevice.findUnique({
        where: { id: request.deviceId },
      });
      if (!device?.active || device.tenantId !== tenantId)
        throw captureError("Device is no longer active for your company", 409);
      await setCompanies(tx, device, [...device.allowedTenantIds, request.tenantId], {
        actorId,
        reason: why,
        requestId: request.id,
      });
    }
    const decided = await tx.attendanceDeviceAccessRequest.update({
      where: { id: request.id },
      data: {
        state: approve ? "APPROVED" : "REJECTED",
        decidedBy: String(actorId),
        decidedAt: new Date(),
        decisionReason: why,
        version: { increment: 1 },
      },
    });
    await emit(tx, request.tenantId, "hr.attendance.device_access_decided.v1", actorId, decided);
    return decided;
  });
}

export async function withdrawDeviceAccessRequest(
  { tenantId, actorId, id, version, reason },
  db = prisma,
) {
  const why = required(reason, "Reason");
  return transaction(db, async (tx) => {
    const { request, stale } = await openRequest(tx, { id, version });
    if (!request || request.tenantId !== tenantId)
      throw captureError("Request not found", 404);
    if (stale) throw captureError("Request changed; reload and try again", 409);
    if (request.state !== "PENDING")
      throw captureError("Only a pending request can be withdrawn", 409);
    return tx.attendanceDeviceAccessRequest.update({
      where: { id: request.id },
      data: {
        state: "WITHDRAWN",
        endedBy: String(actorId),
        endedAt: new Date(),
        endReason: why,
        version: { increment: 1 },
      },
    });
  });
}

// The owner removes another company (`companyTenantId`), or a company gives up
// its own access (no `companyTenantId`). Access granted before requests existed
// is removed the same way.
export async function endDeviceAccess(
  { tenantId, actorId, sn, companyTenantId, reason },
  db = prisma,
) {
  const why = required(reason, "Reason");
  return transaction(db, async (tx) => {
    const device = await tx.attendanceCaptureDevice.findUnique({
      where: { sn: String(sn || "") },
    });
    if (!device || (device.tenantId !== tenantId && !device.allowedTenantIds.includes(tenantId)))
      throw captureError("Device not found", 404);
    const company = companyTenantId || tenantId;
    if (company !== tenantId && device.tenantId !== tenantId)
      throw captureError("Only the company that owns the device can remove another company", 403);
    if (company === device.tenantId)
      throw captureError("The owning company cannot be removed from its own device", 409);
    await lockDevice(tx, device.id);
    if (!device.allowedTenantIds.includes(company))
      throw captureError("That company does not use this device", 409);
    await setCompanies(
      tx,
      device,
      device.allowedTenantIds.filter((t) => t !== company),
      { actorId, reason: why },
    );
    const approved = await tx.attendanceDeviceAccessRequest.findFirst({
      where: { deviceId: device.id, tenantId: company, state: "APPROVED" },
    });
    if (approved) {
      const ended = await tx.attendanceDeviceAccessRequest.update({
        where: { id: approved.id },
        data: {
          state: "REVOKED",
          endedBy: String(actorId),
          endedAt: new Date(),
          endReason: why,
          version: { increment: 1 },
        },
      });
      await emit(
        tx,
        company === tenantId ? device.tenantId : company,
        "hr.attendance.device_access_ended.v1",
        actorId,
        ended,
      );
    }
    return { sn: device.sn, removedTenantId: company, applied: true };
  });
}

export async function listDeviceAccess({ tenantId }, db = prisma) {
  return system(async () => {
    const [devices, requests] = await Promise.all([
      db.attendanceCaptureDevice.findMany({ where: { active: true }, orderBy: { sn: "asc" } }),
      db.attendanceDeviceAccessRequest.findMany({
        where: { OR: [{ tenantId }, { ownerTenantId: tenantId }] },
        orderBy: { requestedAt: "desc" },
        take: 200,
      }),
    ]);
    return {
      owned: devices.filter((d) => d.tenantId === tenantId).map(ownedView),
      used: devices
        .filter((d) => d.tenantId !== tenantId && d.allowedTenantIds.includes(tenantId))
        .map(sharedView),
      incoming: requests.filter((r) => r.ownerTenantId === tenantId),
      outgoing: requests.filter((r) => r.tenantId === tenantId),
    };
  });
}
