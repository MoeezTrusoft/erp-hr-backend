// tests/unit/jobs/outbox-wake.job.test.js
//
// PM availability relay (ported HR PR #22):
//   * hr.availability.changed.v1 is XADDed to pm:source-events, every other
//     HR event still goes to hr:events,
//   * the LISTEN hr_outbox wake triggers an immediate drain, coalesces wakes
//     during an in-flight batch, and is best effort (polling continues),
//   * startHrOutboxDispatcher wires the wake and stops it on shutdown.
import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

import {
    createStreamPublisher,
    streamForEvent,
    HR_EVENTS_STREAM,
} from '../../../src/jobs/outbox.dispatcher.js';
import { startOutboxDispatchLoop, startHrOutboxDispatcher } from '../../../src/jobs/outbox.loop.js';
import { startOutboxWake, HR_OUTBOX_CHANNEL } from '../../../src/jobs/outbox-wake.job.js';

const silentLogger = { info: () => {}, warn: jest.fn(), error: () => {}, debug: () => {}, child: () => silentLogger };

function makeFakeClock() {
    let seq = 1;
    const timers = new Map();
    return {
        setTimeout: jest.fn((fn, ms) => {
            const id = seq++;
            timers.set(id, { fn, ms });
            return id;
        }),
        clearTimeout: jest.fn((id) => { timers.delete(id); }),
        last() { return [...timers.values()].pop(); },
        get pending() { return timers.size; },
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

describe('stream routing', () => {
    it('routes hr.availability.changed.v1 to pm:source-events and keeps the rest on hr:events', async () => {
        expect(streamForEvent('hr.availability.changed.v1')).toBe('pm:source-events');
        expect(streamForEvent('hr.leave.approved.v1')).toBe(HR_EVENTS_STREAM);
        expect(streamForEvent('constructor')).toBe(HR_EVENTS_STREAM);

        const redis = { xadd: jest.fn(async () => '1-0') };
        const publish = createStreamPublisher({ redis });
        const envelope = { id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', name: 'hr.availability.changed.v1' };
        await publish({ eventName: 'hr.availability.changed.v1', payload: envelope, aggregateId: '7' });
        await publish({ eventName: 'hr.employee.lifecycle.v1', payload: { id: 'x' }, aggregateId: '8' });
        expect(redis.xadd.mock.calls[0]).toEqual([
            'pm:source-events', '*',
            'event', 'hr.availability.changed.v1',
            'envelope', JSON.stringify(envelope),
            'eid', envelope.id,
            'srcId', '7',
        ]);
        expect(redis.xadd.mock.calls[1][0]).toBe('hr:events');
    });
});

describe('startOutboxDispatchLoop wake()', () => {
    it('runs a batch immediately on wake instead of waiting for the interval', async () => {
        const clock = makeFakeClock();
        const run = jest.fn(async () => ({ published: 0 }));
        const loop = startOutboxDispatchLoop({
            run, intervalMs: 3000, logger: silentLogger,
            setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        });
        await loop.whenIdle();
        expect(run).toHaveBeenCalledTimes(1);
        expect(clock.last().ms).toBe(3000);

        loop.wake();
        await loop.whenIdle();
        expect(run).toHaveBeenCalledTimes(2);
        // The pending interval timer was replaced, not doubled.
        expect(clock.pending).toBe(1);
        await loop.stop();
    });

    it('coalesces wakes during an in-flight batch into one follow-up batch', async () => {
        const clock = makeFakeClock();
        const gate = deferred();
        const run = jest.fn()
            .mockImplementationOnce(() => gate.promise)
            .mockImplementation(async () => ({ published: 0 }));
        const loop = startOutboxDispatchLoop({
            run, intervalMs: 3000, logger: silentLogger,
            setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        });
        loop.wake();
        loop.wake();
        expect(run).toHaveBeenCalledTimes(1);
        gate.resolve({ published: 0 });
        await loop.whenIdle();
        // Follow-up is scheduled with zero delay, once.
        expect(clock.pending).toBe(1);
        expect(clock.last().ms).toBe(0);
        await loop.stop();
    });

    it('drains again at once after a batch that published rows, and backs off after a failure', async () => {
        const clock = makeFakeClock();
        const run = jest.fn()
            .mockResolvedValueOnce({ published: 2 })
            .mockRejectedValueOnce(new Error('redis down'));
        const loop = startOutboxDispatchLoop({
            run, intervalMs: 3000, errorBackoffMs: 1000, logger: silentLogger,
            setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        });
        await loop.whenIdle();
        expect(clock.last().ms).toBe(0);
        loop.wake();
        await loop.whenIdle();
        expect(clock.last().ms).toBe(1000);
        await loop.stop();
        loop.wake();
        expect(run).toHaveBeenCalledTimes(2);
    });
});

class FakeClient extends EventEmitter {
    constructor(config, { failConnect = false } = {}) {
        super();
        this.config = config;
        this.failConnect = failConnect;
        this.queries = [];
        this.ended = false;
    }
    async connect() { if (this.failConnect) throw new Error('ECONNREFUSED'); }
    async query(sql) { this.queries.push(sql); }
    async end() { this.ended = true; this.emit('end'); }
}

describe('startOutboxWake (LISTEN hr_outbox)', () => {
    const noTimer = { setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} };

    it('LISTENs on the direct URL, wakes after connect and on each notification', async () => {
        const clients = [];
        const wake = jest.fn();
        const stop = startOutboxWake(wake, {
            env: { DATABASE_URL: 'postgres://pooled', DIRECT_DATABASE_URL: 'postgres://direct' },
            logger: silentLogger,
            clientFactory: (config) => { const c = new FakeClient(config); clients.push(c); return c; },
            ...noTimer,
        });
        await new Promise((r) => setImmediate(r));
        expect(clients).toHaveLength(1);
        expect(clients[0].config.connectionString).toBe('postgres://direct');
        expect(clients[0].queries).toEqual([`LISTEN ${HR_OUTBOX_CHANNEL}`]);
        expect(wake).toHaveBeenCalledTimes(1);

        clients[0].emit('notification', { channel: HR_OUTBOX_CHANNEL, payload: 'changed' });
        clients[0].emit('notification', { channel: 'other', payload: 'x' });
        expect(wake).toHaveBeenCalledTimes(2);

        await stop();
        expect(clients[0].ended).toBe(true);
    });

    it('is best effort: a failed connect warns once and never throws', async () => {
        silentLogger.warn.mockClear();
        let reconnect;
        const wake = jest.fn();
        const stop = startOutboxWake(wake, {
            env: { DATABASE_URL: 'postgres://pooled' },
            logger: silentLogger,
            clientFactory: (config) => new FakeClient(config, { failConnect: true }),
            setIntervalFn: (fn) => { reconnect = fn; return { unref() {} }; },
            clearIntervalFn: () => {},
        });
        await new Promise((r) => setImmediate(r));
        await reconnect();
        expect(wake).not.toHaveBeenCalled();
        expect(silentLogger.warn).toHaveBeenCalledTimes(1);
        await stop();
    });

    it('is a no-op without a database URL', async () => {
        const stop = startOutboxWake(() => {}, { env: {}, logger: silentLogger, ...noTimer });
        await expect(stop()).resolves.toBeUndefined();
    });
});

describe('startHrOutboxDispatcher wake wiring', () => {
    const redisFactory = () => ({ xadd: async () => '1-0', on() {}, quit: async () => {} });

    it('starts the LISTEN wake with the loop and stops it on shutdown', async () => {
        const stopWake = jest.fn(async () => {});
        const wakeFactory = jest.fn(() => stopWake);
        const handle = startHrOutboxDispatcher({
            env: { NODE_ENV: 'production', REDIS_URL: 'redis://x', HR_OUTBOX_DISPATCH_INTERVAL_MS: '60000' },
            logger: silentLogger,
            prisma: {},
            redisFactory,
            wakeFactory,
        });
        expect(handle.enabled).toBe(true);
        expect(wakeFactory).toHaveBeenCalledTimes(1);
        expect(typeof wakeFactory.mock.calls[0][0]).toBe('function');
        await handle.stop();
        expect(stopWake).toHaveBeenCalledTimes(1);
    });

    it('HR_OUTBOX_LISTEN_ENABLED=false keeps polling only', async () => {
        const wakeFactory = jest.fn();
        const handle = startHrOutboxDispatcher({
            env: { NODE_ENV: 'production', REDIS_URL: 'redis://x', HR_OUTBOX_LISTEN_ENABLED: 'false' },
            logger: silentLogger,
            prisma: {},
            redisFactory,
            wakeFactory,
        });
        expect(wakeFactory).not.toHaveBeenCalled();
        await handle.stop();
    });
});
