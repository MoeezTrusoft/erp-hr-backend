// ADMS protocol helpers and the pull connector's planning helpers.
import { describe, it, expect } from '@jest/globals';
import { serialOf, stampOf, handshakeBody, attlogRows, utcOffsetHours, batches } from '../../../../src/lib/deviceGateway/admsProtocol.js';
import { parseTargets, cursorFloor, newRecords } from '../../../../src/lib/deviceGateway/pullPlan.js';

describe('ADMS', () => {
    it('accepts only plain serials', () => {
        expect(serialOf({ SN: 'TTQ5261300360' })).toBe('TTQ5261300360');
        expect(serialOf({ SN: '../etc' })).toBeNull();
        expect(serialOf({})).toBeNull();
    });
    it('answers the handshake with the stored stamp and the zone offset', () => {
        const body = handshakeBody({ sn: 'TTQ5261300360', attStamp: '9182', timeZone: 'Asia/Karachi' });
        expect(body).toContain('GET OPTION FROM: TTQ5261300360');
        expect(body).toContain('ATTLOGStamp=9182');
        expect(body).toContain('TimeZone=5');
        expect(body).toContain('OPERLOGStamp=9999');
    });
    it('offsets follow the zone', () => {
        expect(utcOffsetHours('Asia/Karachi')).toBe(5);
        expect(utcOffsetHours('UTC')).toBe(0);
    });
    it('splits an ATTLOG body into rows, keeping the device fields', () => {
        const body = '1043\t2026-11-16 15:26:51\t0\t15\t0\t0\t0\t0\t0\t0\t\r\n\r\n7\t2026-11-16 15:27:02\t1\t1\t0\n';
        expect(attlogRows(body)).toEqual(['1043\t2026-11-16 15:26:51\t0\t15\t0\t0\t0\t0\t0\t0\t', '7\t2026-11-16 15:27:02\t1\t1\t0']);
        expect(attlogRows(undefined)).toEqual([]);
    });
    it('only numeric stamps are kept', () => {
        expect(stampOf({ Stamp: '9182' })).toBe('9182');
        expect(stampOf({ Stamp: 'None' })).toBeNull();
    });
    it('batches rows', () => {
        expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });
});

describe('pull plan', () => {
    it('reads targets and comm keys from the environment', () => {
        const env = {
            DEVICE_PULL_TARGETS: JSON.stringify([{ sn: 'A8LN181960262', host: '192.0.2.10' }, { sn: 'EUF7243800353', host: '192.0.2.20', transport: 'udp' }]),
            DEVICE_COMM_KEYS: JSON.stringify({ A8LN181960262: '1111' }),
        };
        expect(parseTargets(env)).toEqual([
            { sn: 'A8LN181960262', host: '192.0.2.10', port: 4370, transport: 'tcp', commKey: '1111' },
            { sn: 'EUF7243800353', host: '192.0.2.20', port: 4370, transport: 'udp', commKey: 0 },
        ]);
        expect(parseTargets({})).toEqual([]);
        expect(() => parseTargets({ DEVICE_PULL_TARGETS: '[{"sn":"x"}]' })).toThrow('HR-7121');
    });
    it('re-sends a 10-minute overlap after the cursor, oldest first', () => {
        expect(cursorFloor('2026-11-16 10:26:51')).toBe('2026-11-16 10:16:51');
        expect(cursorFloor(null)).toBeNull();
        const recs = [
            { time: '2026-11-20 09:00:00' }, { time: '2026-11-16 10:00:00' }, { time: '2026-11-16 10:20:00' }, { time: '2026-11-18 08:00:00' },
        ];
        expect(newRecords(recs, '2026-11-16 10:26:51').map((r) => r.time)).toEqual(['2026-11-16 10:20:00', '2026-11-18 08:00:00', '2026-11-20 09:00:00']);
        expect(newRecords(recs, null)).toHaveLength(4);
    });
});
