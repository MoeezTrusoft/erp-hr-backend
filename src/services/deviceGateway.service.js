// HR device gateway: shared logic for the ADMS push connector (src/routes/iclock.routes.js) and the
// SDK pull connector (deviceGatewayPull.service.js). Both hand rows to the existing intake
// (receiveCapture), which stores a durable receipt and de-duplicates; nothing here writes punches itself.
import client from 'prom-client';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { mcpCtx } from '../mcp/context.js';
import { MAX_CAPTURE_ROWS } from '../lib/attendanceCapture.js';
import { batches } from '../lib/deviceGateway/admsProtocol.js';
import { receiveCapture, captureHeartbeat } from './attendanceCapture.service.js';

const log = logger.child({ component: 'device-gateway' });
// Prisma queries are lazy: await INSIDE the context, or the query runs after it has ended (HR-4030).
const system = (fn) => mcpCtx.run({ system: true }, async () => await fn());

const metric = (name, make) => client.register.getSingleMetric(name) || make();
export const metrics = {
    rows: metric('hr_device_rows_total', () => new client.Counter({
        name: 'hr_device_rows_total', help: 'Punch rows handed to the HR intake',
        labelNames: ['sn', 'connector', 'result'],
    })),
    requests: metric('hr_device_requests_total', () => new client.Counter({
        name: 'hr_device_requests_total', help: 'Device gateway requests and pull cycles',
        labelNames: ['connector', 'kind', 'result'],
    })),
    lastContact: metric('hr_device_last_contact_seconds', () => new client.Gauge({
        name: 'hr_device_last_contact_seconds', help: 'Unix time of the last successful contact per device',
        labelNames: ['sn', 'connector'],
    })),
    clockOffset: metric('hr_device_clock_offset_seconds', () => new client.Gauge({
        name: 'hr_device_clock_offset_seconds', help: 'Device clock minus server clock (pull connector)',
        labelNames: ['sn'],
    })),
};

/** Registered, active, non-kiosk device for a serial, or null. */
export async function findActiveDevice(sn, db = prisma) {
    const device = await system(() => db.attendanceCaptureDevice.findUnique({ where: { sn: String(sn) } }));
    if (!device?.active || device.biometricPublicKey) return null;
    return device;
}

/** Hands rows to the intake in batches. Throws on the first failed batch (the caller retries; replays are safe). */
export async function forwardRows({ sn, rows, connector, source }, deps = {}) {
    const intake = deps.receiveCapture ?? receiveCapture;
    const total = { received: 0, stored: 0, duplicates: 0, pending: 0, needsReview: 0 };
    for (const batch of batches(rows, MAX_CAPTURE_ROWS)) {
        try {
            const s = await intake({ sn, rows: batch, source });
            for (const k of Object.keys(total)) total[k] += Number(s?.[k] ?? 0);
            metrics.rows.inc({ sn, connector, result: 'accepted' }, batch.length);
        } catch (err) {
            metrics.rows.inc({ sn, connector, result: 'failed' }, batch.length);
            log.warn({ sn, connector, status: err.status, err: err.message }, 'device rows not accepted');
            throw err;
        }
    }
    return total;
}

/** Records contact (and the device clock when known). Returns HR's open commands only when asked. */
export async function heartbeat({ device, connector, deviceTime, withCommands = false }, deps = {}) {
    const beat = await (deps.captureHeartbeat ?? captureHeartbeat)({ device, deviceTime, withCommands });
    metrics.lastContact.set({ sn: device.sn, connector }, Math.floor(Date.now() / 1000));
    if (Number.isFinite(beat?.clockOffsetSeconds) && deviceTime) metrics.clockOffset.set({ sn: device.sn }, beat.clockOffsetSeconds);
    return beat;
}

/** Small key-value store for ADMS stamps and pull cursors: Redis when configured, else process memory. */
export function createStateStore(redis) {
    const memory = new Map();
    const key = (k) => `hr:device-gateway:${k}`;
    return {
        async get(k) { return redis ? redis.get(key(k)) : memory.get(k) ?? null; },
        async set(k, v) { if (redis) await redis.set(key(k), String(v)); else memory.set(k, String(v)); },
    };
}
