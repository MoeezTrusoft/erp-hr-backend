// Pull connector for devices without ADMS push. Each cycle, per configured device: connect with its
// comm key, read the clock (heartbeat), optionally apply HR's clock-fix command, read the attendance
// log and forward records at or after the device's cursor minus an overlap (the intake drops repeats).
// Only one gateway replica pulls at a time (Redis lease); devices accept a single session.
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { mcpCtx } from '../mcp/context.js';
import { ZkClient } from '../lib/deviceGateway/zkClient.js';
import { toCaptureRow } from '../lib/deviceGateway/zkProtocol.js';
import { newRecords } from '../lib/deviceGateway/pullPlan.js';
export { parseTargets, newRecords, cursorFloor } from '../lib/deviceGateway/pullPlan.js';
import { ackCommand } from './attendanceDeviceCommand.service.js';
import { findActiveDevice, forwardRows, heartbeat, metrics } from './deviceGateway.service.js';

const log = logger.child({ component: 'device-gateway-pull' });
// Prisma queries are lazy: await INSIDE the context, or the query runs after it has ended (HR-4030).
const system = (fn) => mcpCtx.run({ system: true }, async () => await fn());
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Latest stored punch for a serial as device wall time (punchedAt keeps wall coordinates in UTC). */
async function storedCursor(sn, db = prisma) {
    const r = await system(() => db.attendanceDevicePunch.aggregate({ where: { sn }, _max: { punchedAt: true } }));
    const at = r?._max?.punchedAt;
    return at ? new Date(at).toISOString().slice(0, 19).replace('T', ' ') : null;
}

export function createPuller({ targets, store, redis, intervalSeconds = 60, commandsEnabled = false, timeoutMs = 10000, deps = {} }) {
    const owner = randomUUID();
    const leaseKey = 'hr:device-gateway:pull-leader';
    const leaseMs = Math.max(intervalSeconds * 3, 90) * 1000;
    const failures = new Map();
    let timer = null;
    let running = false;

    async function leader() {
        if (!redis) return true;
        if (await redis.set(leaseKey, owner, 'PX', leaseMs, 'NX')) return true;
        if ((await redis.get(leaseKey)) === owner) { await redis.pexpire(leaseKey, leaseMs); return true; }
        return false;
    }

    async function pullOne(t) {
        const f = failures.get(t.sn);
        if (f && Date.now() < f.next) return;
        const device = await (deps.findActiveDevice ?? findActiveDevice)(t.sn);
        if (!device) { metrics.requests.inc({ connector: 'zk-sdk', kind: 'cycle', result: 'unregistered' }); return; }
        const zk = (deps.makeClient ?? ((o) => new ZkClient(o)))({ ...t, timeoutMs });
        try {
            await zk.connect();
            const deviceTime = await zk.deviceTime();
            const beat = await heartbeat({ device, connector: 'zk-sdk', deviceTime, withCommands: commandsEnabled }, deps);
            for (const c of beat.commands ?? []) {
                if (c.type !== 'SET_TIME') continue;
                try { await zk.setTime(c.localTime); await (deps.ackCommand ?? ackCommand)({ device, id: c.id, ok: true }); }
                catch (e) { await (deps.ackCommand ?? ackCommand)({ device, id: c.id, ok: false, error: e.message }); }
            }
            const cursorKey = `cursor:${t.sn}`;
            const cursor = (await store.get(cursorKey)) ?? (await (deps.storedCursor ?? storedCursor)(t.sn));
            const fresh = newRecords(await zk.attendance(), cursor);
            if (fresh.length) {
                const summary = await forwardRows({ sn: t.sn, rows: fresh.map(toCaptureRow), connector: 'zk-sdk', source: 'DEVICE_LISTENER' }, deps);
                await store.set(cursorKey, fresh[fresh.length - 1].time);
                log.info({ sn: t.sn, sent: fresh.length, stored: summary.stored, duplicates: summary.duplicates }, 'device records forwarded');
            }
            failures.delete(t.sn);
            metrics.requests.inc({ connector: 'zk-sdk', kind: 'cycle', result: 'ok' });
        } catch (err) {
            const n = (f?.count ?? 0) + 1;
            const wait = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (n - 1)) * (0.8 + Math.random() * 0.4);
            failures.set(t.sn, { count: n, next: Date.now() + wait });
            metrics.requests.inc({ connector: 'zk-sdk', kind: 'cycle', result: 'error' });
            log.warn({ sn: t.sn, attempt: n, retryInMs: Math.round(wait), err: err.message }, 'device pull failed');
        } finally {
            await zk.close().catch(() => undefined);
        }
    }

    async function cycle() {
        if (running) return;
        running = true;
        try {
            if (!(await leader())) return;
            for (const t of targets) await pullOne(t);
        } catch (err) {
            log.error({ err: err.message }, 'device pull cycle failed');
        } finally {
            running = false;
        }
    }

    return {
        cycle,
        pullOne,
        start() { if (!timer && targets.length) { timer = setInterval(cycle, intervalSeconds * 1000); void cycle(); } },
        async stop() {
            clearInterval(timer); timer = null;
            if (redis && (await redis.get(leaseKey).catch(() => null)) === owner) await redis.del(leaseKey).catch(() => undefined);
        },
    };
}
