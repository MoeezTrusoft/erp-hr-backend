// tests/unit/jobs/outbox.loop.test.js
//
// WBS worker-wiring / T-P3.x (A.4 boot loop). Proves the HR OutboxEvent
// dispatcher is WIRED to run as an auto-starting background drain loop and
// stops cleanly on shutdown. The dispatch step itself (claim/lease/XADD) is
// already covered by outbox.dispatcher.test.js — here we only assert the
// LOOP wiring around it:
//   * startOutboxDispatchLoop drains once immediately, then on the interval,
//     using an injected runner (no real prisma/redis/timers),
//   * a runner throw is best-effort (the loop keeps beating, does not crash),
//   * stop() halts further drains and is idempotent,
//   * the loop is guarded for tests (NODE_ENV=test => disabled no-op handle),
//   * the production server-boot wiring (startHrOutboxDispatcher) returns a
//     handle with a stop() that never throws even with no Redis configured.
import { describe, it, expect, jest } from '@jest/globals';

import {
    startOutboxDispatchLoop,
    startHrOutboxDispatcher,
    DEFAULT_DISPATCH_INTERVAL_MS,
} from '../../../src/jobs/outbox.loop.js';

// A fake clock: setTimeout/clearTimeout the loop can be injected with, so we
// drive ticks deterministically without spawning real timers.
function makeFakeClock() {
    let seq = 1;
    const timers = new Map();
    return {
        setTimeout: jest.fn((fn, _ms) => {
            const id = seq++;
            timers.set(id, fn);
            return id;
        }),
        clearTimeout: jest.fn((id) => { timers.delete(id); }),
        // Fire the most-recently-scheduled timer (the loop only ever has one).
        async tick() {
            const [id, fn] = [...timers.entries()].pop() ?? [];
            if (id == null) return false;
            timers.delete(id);
            await fn();
            return true;
        },
        get pending() { return timers.size; },
    };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => silentLogger };

describe('startOutboxDispatchLoop (A.4 boot loop wiring)', () => {
    it('drains once immediately on start, then again on each interval tick', async () => {
        const clock = makeFakeClock();
        const run = jest.fn(async () => ({ scanned: 0, published: 0 }));

        const handle = startOutboxDispatchLoop({
            run,
            intervalMs: 2000,
            logger: silentLogger,
            setTimeoutFn: clock.setTimeout,
            clearTimeoutFn: clock.clearTimeout,
        });

        // immediate kick
        await handle.whenIdle();
        expect(run).toHaveBeenCalledTimes(1);
        expect(clock.pending).toBe(1); // next tick scheduled

        await clock.tick();
        await handle.whenIdle();
        expect(run).toHaveBeenCalledTimes(2);

        await handle.stop();
    });

    it('is best-effort: a runner throw does not crash the loop, it keeps beating', async () => {
        const clock = makeFakeClock();
        const run = jest.fn()
            .mockRejectedValueOnce(new Error('redis down'))
            .mockResolvedValue({ scanned: 0, published: 0 });

        const handle = startOutboxDispatchLoop({
            run,
            intervalMs: 1000,
            logger: silentLogger,
            setTimeoutFn: clock.setTimeout,
            clearTimeoutFn: clock.clearTimeout,
        });

        await handle.whenIdle();
        expect(run).toHaveBeenCalledTimes(1); // threw, but did not propagate
        expect(clock.pending).toBe(1);        // still rescheduled

        await clock.tick();
        await handle.whenIdle();
        expect(run).toHaveBeenCalledTimes(2);

        await handle.stop();
    });

    it('stop() halts further drains, clears the pending timer, and is idempotent', async () => {
        const clock = makeFakeClock();
        const run = jest.fn(async () => ({ scanned: 0, published: 0 }));

        const handle = startOutboxDispatchLoop({
            run,
            intervalMs: 1000,
            logger: silentLogger,
            setTimeoutFn: clock.setTimeout,
            clearTimeoutFn: clock.clearTimeout,
        });

        await handle.whenIdle();
        await handle.stop();
        expect(clock.clearTimeout).toHaveBeenCalled();
        expect(clock.pending).toBe(0);

        const callsAfterStop = run.mock.calls.length;
        // A late tick (if any fired) must not run another drain.
        await clock.tick();
        expect(run).toHaveBeenCalledTimes(callsAfterStop);

        // idempotent
        await expect(handle.stop()).resolves.toBeUndefined();
    });

    it('exposes a sane default interval', () => {
        expect(DEFAULT_DISPATCH_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
        expect(DEFAULT_DISPATCH_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    });
});

describe('startHrOutboxDispatcher (server-boot entrypoint)', () => {
    it('returns a disabled no-op handle under NODE_ENV=test (no real timers)', async () => {
        const handle = startHrOutboxDispatcher({ logger: silentLogger, env: { NODE_ENV: 'test' } });
        expect(handle).toBeTruthy();
        expect(handle.enabled).toBe(false);
        // stop() must be safe to call on the disabled handle.
        await expect(handle.stop()).resolves.toBeUndefined();
    });

    it('is best-effort when REDIS_URL is absent: disabled handle, never throws', async () => {
        const handle = startHrOutboxDispatcher({
            logger: silentLogger,
            env: { NODE_ENV: 'development' }, // no REDIS_URL
        });
        expect(handle.enabled).toBe(false);
        await expect(handle.stop()).resolves.toBeUndefined();
    });

    it('can be explicitly disabled via HR_OUTBOX_DISPATCH_ENABLED=false even with Redis', async () => {
        const handle = startHrOutboxDispatcher({
            logger: silentLogger,
            env: {
                NODE_ENV: 'development',
                REDIS_URL: 'redis://127.0.0.1:6379',
                HR_OUTBOX_DISPATCH_ENABLED: 'false',
            },
        });
        expect(handle.enabled).toBe(false);
        await expect(handle.stop()).resolves.toBeUndefined();
    });
});
