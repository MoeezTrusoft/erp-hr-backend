// tests/unit/services/attendanceRealtime.publisher.test.js
//
// X-13 (BE-audit §7.2 / ARCH-01 §7.7,§13) — retire the self-hosted socket.io
// transport; publish attendance realtime to the Redis Streams fabric instead.
// This is the publisher seam: an injectable Redis client + XADD onto the
// `hr:attendance` stream, fail-soft (a Redis hiccup never breaks the ingest
// path), and a no-op when no transport is bound (tests / REDIS_URL unset).
import { describe, it, expect, jest } from '@jest/globals';

import {
    createAttendanceStreamPublisher,
    HR_ATTENDANCE_STREAM,
    bindAttendanceRealtimeTransport,
    publishAttendanceEvent,
    publishAttendanceStatus,
    __resetAttendanceTransportForTests,
} from '../../../src/services/attendanceRealtime.publisher.js';

describe('createAttendanceStreamPublisher', () => {
    it('XADDs the event onto the hr:attendance stream with a kind tag', async () => {
        const xadd = jest.fn(async () => '1-0');
        const redis = { xadd };
        const publisher = createAttendanceStreamPublisher({ redis });

        await publisher({ kind: 'event', payload: { employeeId: 3, action: 'checkin' } });

        expect(xadd).toHaveBeenCalledTimes(1);
        const args = xadd.mock.calls[0];
        expect(args[0]).toBe(HR_ATTENDANCE_STREAM);
        expect(args[1]).toBe('*');
        // field/value pairs include kind + json payload
        expect(args).toContain('kind');
        expect(args).toContain('event');
        expect(args).toContain('payload');
    });

    it('throws at construction when redis has no xadd', () => {
        expect(() => createAttendanceStreamPublisher({ redis: {} })).toThrow();
    });
});

describe('bound transport seam (fail-soft, no socket.io)', () => {
    beforeEach(() => __resetAttendanceTransportForTests());
    afterEach(() => __resetAttendanceTransportForTests());

    it('is a no-op when no transport is bound', async () => {
        // Must not throw even though nothing is bound.
        await expect(publishAttendanceEvent({ employeeId: 1 })).resolves.toBeUndefined();
        await expect(publishAttendanceStatus({ running: true })).resolves.toBeUndefined();
    });

    it('routes events to the bound publisher tagged by kind', async () => {
        const calls = [];
        bindAttendanceRealtimeTransport(async (msg) => { calls.push(msg); });

        await publishAttendanceEvent({ employeeId: 7, action: 'checkout' });
        await publishAttendanceStatus({ running: false });

        expect(calls).toHaveLength(2);
        expect(calls[0].kind).toBe('event');
        expect(calls[0].payload.employeeId).toBe(7);
        expect(calls[1].kind).toBe('status');
    });

    it('swallows a publisher rejection (fail-soft — never breaks ingest)', async () => {
        bindAttendanceRealtimeTransport(async () => { throw new Error('redis down'); });
        await expect(publishAttendanceEvent({ employeeId: 9 })).resolves.toBeUndefined();
    });
});
