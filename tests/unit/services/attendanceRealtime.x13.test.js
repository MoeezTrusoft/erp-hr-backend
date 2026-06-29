// tests/unit/services/attendanceRealtime.x13.test.js
//
// X-13 (BE-audit §7.2 / ARCH-01 §7.7,§13) — the self-hosted socket.io transport
// is RETIRED. This guard test fails if socket.io creeps back into the realtime
// service or the server entrypoint, and proves the realtime service now wires
// its broadcasts through the Redis-stream publisher seam (no socketServer).
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../../../src');

function read(rel) {
    return readFileSync(path.join(SRC, rel), 'utf8');
}

describe('X-13 socket.io retirement', () => {
    it('the realtime service no longer references a socket.io server (code, not comments)', () => {
        const src = read('services/attendance.realtime.service.js');
        // no socket-server state variable and no exported binder
        expect(src).not.toMatch(/socketServer/);
        expect(src).not.toMatch(/export function bindRealtimeSocketServer/);
        expect(src).not.toMatch(/\.emit\(["']attendance:/); // no socket.emit calls
        // it publishes through the Redis-stream seam instead
        expect(src).toContain('attendanceRealtime.publisher.js');
        expect(src).toContain('publishAttendanceEvent');
    });

    it('the server entrypoint imports no socket.io and binds the Redis transport', () => {
        const src = read('server.js');
        expect(src).not.toMatch(/from ["']socket\.io["']/);
        expect(src).not.toMatch(/SocketIOServer/);
        expect(src).not.toMatch(/new SocketIOServer/);
        expect(src).toContain('bindAttendanceRealtimeTransport');
        expect(src).toContain('hr:attendance');
    });

    it('exposes the realtime listener state + ingest seam the device listener depends on', async () => {
        const mod = await import('../../../src/services/attendance.realtime.service.js');
        expect(typeof mod.ingestRealtimeDeviceEvent).toBe('function');
        expect(typeof mod.updateListenerState).toBe('function');
        expect(typeof mod.getRealtimeListenerState).toBe('function');
        expect(typeof mod.startRealtimeHealthBroadcast).toBe('function');
        // the retired binder is gone
        expect(mod.bindRealtimeSocketServer).toBeUndefined();
    });
});
