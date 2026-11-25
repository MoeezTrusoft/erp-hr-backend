// Pull connector cycle with a fake device client and the database layer mocked: first run starts
// from the latest stored punch, later runs from the saved cursor; failures back off; clock commands
// are applied only when enabled.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const forwarded = [];
const acks = [];
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../../src/services/attendanceDeviceCommand.service.js', () => ({
    ackCommand: async (a) => { acks.push(a); return { ok: true }; },
}));
jest.unstable_mockModule('../../../src/services/deviceGateway.service.js', () => ({
    metrics: { requests: { inc() {} }, rows: { inc() {} }, lastContact: { set() {} }, clockOffset: { set() {} } },
    findActiveDevice: async (sn) => (sn.startsWith('OFF') ? null : { id: `id-${sn}`, sn, timeZone: 'Asia/Karachi' }),
    forwardRows: async (a) => { forwarded.push(a); return { stored: a.rows.length, duplicates: 0 }; },
    heartbeat: async ({ withCommands }) => ({ commands: withCommands ? [{ id: 'c1', type: 'SET_TIME', localTime: '2026-11-20 14:00:00' }] : [] }),
}));
const { createPuller } = await import('../../../src/services/deviceGatewayPull.service.js');

const log = [
    { deviceUserId: '1', time: '2026-11-08 17:00:00', status: 0, verifyMode: 1, workCode: 0 },
    { deviceUserId: '2', time: '2026-11-18 09:00:00', status: 0, verifyMode: 1, workCode: 0 },
    { deviceUserId: '1', time: '2026-11-20 09:01:00', status: 1, verifyMode: 1, workCode: 0 },
];
function fakeClient({ fail = false } = {}) {
    const calls = [];
    const make = () => ({
        connect: async () => { calls.push('connect'); if (fail) throw new Error('HR-7118: connect timeout'); },
        deviceTime: async () => '2026-11-20 13:58:00',
        setTime: async (w) => { calls.push(`setTime ${w}`); },
        attendance: async () => log,
        close: async () => { calls.push('close'); },
    });
    return { make, calls };
}
function memoryStore() {
    const m = new Map();
    return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => m.set(k, v) };
}

beforeEach(() => { forwarded.length = 0; acks.length = 0; });

describe('pull connector', () => {
    it('first run forwards from the latest stored punch (minus overlap) and saves the cursor', async () => {
        const store = memoryStore();
        const { make, calls } = fakeClient();
        const p = createPuller({ targets: [{ sn: 'A8LN181960262', host: 'x' }], store, deps: { makeClient: make, storedCursor: async () => '2026-11-08 17:05:00' } });
        await p.cycle();
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]).toMatchObject({ sn: 'A8LN181960262', connector: 'zk-sdk', source: 'DEVICE_LISTENER' });
        expect(forwarded[0].rows).toEqual(['1\t2026-11-08 17:00:00\t0\t1\t0', '2\t2026-11-18 09:00:00\t0\t1\t0', '1\t2026-11-20 09:01:00\t1\t1\t0']);
        expect(store.m.get('cursor:A8LN181960262')).toBe('2026-11-20 09:01:00');
        expect(calls).toEqual(['connect', 'close']);
        await p.cycle();
        expect(forwarded[1].rows).toEqual(['1\t2026-11-20 09:01:00\t1\t1\t0']); // only the overlap window again
    });

    it('never writes to the device unless commands are enabled', async () => {
        const { make, calls } = fakeClient();
        await createPuller({ targets: [{ sn: 'S1', host: 'x' }], store: memoryStore(), deps: { makeClient: make, storedCursor: async () => null } }).cycle();
        expect(calls.some((c) => c.startsWith('setTime'))).toBe(false);
        const on = fakeClient();
        await createPuller({ targets: [{ sn: 'S1', host: 'x' }], store: memoryStore(), commandsEnabled: true, deps: { makeClient: on.make, storedCursor: async () => null } }).cycle();
        expect(on.calls).toContain('setTime 2026-11-20 14:00:00');
        expect(acks).toEqual([expect.objectContaining({ id: 'c1', ok: true })]);
    });

    it('skips unregistered devices and backs off after a failure', async () => {
        const off = fakeClient();
        await createPuller({ targets: [{ sn: 'OFF1', host: 'x' }], store: memoryStore(), deps: { makeClient: off.make } }).cycle();
        expect(off.calls).toEqual([]);
        const bad = fakeClient({ fail: true });
        const p = createPuller({ targets: [{ sn: 'S2', host: 'x' }], store: memoryStore(), deps: { makeClient: bad.make } });
        await p.cycle();
        await p.cycle(); // inside the back-off window: no second connection attempt
        expect(bad.calls.filter((c) => c === 'connect')).toHaveLength(1);
        expect(forwarded).toHaveLength(0);
    });
});
