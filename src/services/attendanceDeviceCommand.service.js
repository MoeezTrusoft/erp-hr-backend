// Fixing a machine's clock. HR asks once; the device agent picks the command up on its next heartbeat, sets the
// machine to the server's time and acknowledges. If the agent never does, the command stays visible as "waiting",
// and punches keep counting at the server's time meanwhile (see lib/deviceClock.js), so pay is never wrong.
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { mcpCtx } from '../mcp/context.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { captureError, wallAt } from '../lib/attendanceCapture.js';
import { DRIFT_SECONDS, describeOffset } from '../lib/deviceClock.js';
import { captureAudit } from './attendanceCapture.service.js';

const OPEN = ['PENDING', 'SENT'];
const system = (fn) => mcpCtx.run({ system: true }, fn);

export async function requestClockFix({ tenantId, actorId, sn }, db = prisma) {
  if (!tenantId) throw captureError('Verified tenant is required', 403);
  return tenantTransaction(db, async (tx) => {
    const device = await tx.attendanceCaptureDevice.findFirst({ where: { sn: String(sn || ''), tenantId } });
    if (!device) throw captureError('Device not found, or your company does not own it', 404);
    if (!device.active) throw captureError('Activate the device first', 409);
    if (!Number.isFinite(device.clockOffsetSeconds)) throw captureError("The machine has not reported its time yet. Try again after its next heartbeat", 409);
    if (Math.abs(device.clockOffsetSeconds) <= DRIFT_SECONDS) throw captureError("The machine's clock is already correct (within 2 minutes)", 409);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${device.id}:device-command`}))`;
    if (await tx.attendanceDeviceCommand.findFirst({ where: { deviceId: device.id, state: { in: OPEN } }, select: { id: true } }))
      throw captureError('A time correction for this machine is already waiting', 409);
    const command = await tx.attendanceDeviceCommand.create({
      data: { id: randomUUID(), tenantId, deviceId: device.id, sn: device.sn, type: 'SET_TIME', detail: { offsetSeconds: device.clockOffsetSeconds }, requestedBy: String(actorId ?? 'unknown') },
    });
    await captureAudit(tx, { tenantId, actorId, action: 'CLOCK_FIX_REQUESTED', reason: `Time correction requested: the machine is ${describeOffset(device.clockOffsetSeconds)}`, detail: { sn: device.sn, commandId: command.id } });
    return command;
  }, { tenantId });
}

/** Open commands for a device at its heartbeat, with the server's time to set. Unacknowledged ones are offered again. */
export async function commandsForHeartbeat(device, now = new Date(), db = prisma) {
  return system(async () => {
    const open = await db.attendanceDeviceCommand.findMany({ where: { deviceId: device.id, state: { in: OPEN } }, orderBy: { createdAt: 'asc' } });
    if (!open.length) return [];
    await db.attendanceDeviceCommand.updateMany({ where: { id: { in: open.map((c) => c.id) }, state: 'PENDING' }, data: { state: 'SENT', sentAt: now } });
    return open.map((c) => ({ id: c.id, type: c.type, serverTime: now.toISOString(), localTime: wallAt(now, device.timeZone), timeZone: device.timeZone }));
  });
}

/** The device says whether it applied the command. */
export async function ackCommand({ device, id, ok, error }, now = new Date()) {
  return system(async () => {
    const done = await prisma.attendanceDeviceCommand.updateMany({
      where: { id: String(id), deviceId: device.id, state: { in: OPEN } },
      data: { state: ok ? 'APPLIED' : 'FAILED', doneAt: now, detail: ok ? undefined : { error: String(error ?? 'The device could not apply the time').slice(0, 300) } },
    });
    if (!done.count) throw captureError('No open command with this id for this device', 404);
    return { ok: true };
  });
}

/** A heartbeat that shows the clock is right closes any waiting correction: the machine has been fixed. */
export async function closeFixedCommands(deviceId, offsetSeconds, now = new Date(), db = prisma) {
  if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > DRIFT_SECONDS) return 0;
  return system(async () => (await db.attendanceDeviceCommand.updateMany({ where: { deviceId, state: { in: OPEN } }, data: { state: 'APPLIED', doneAt: now } })).count);
}

/** Recent corrections for the company's machines, so the screen can say what is waiting. */
export async function listClockCommands({ tenantId, limit = 50 }, db = prisma) {
  return tenantTransaction(db, (tx) => tx.attendanceDeviceCommand.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 50, 200) }), { tenantId });
}
