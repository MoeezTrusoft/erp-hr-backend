// ZKTeco SDK protocol: byte-exact vectors computed with an independent Python transcription
// of the reference implementation (pyzk), plus record decoding for each firmware layout.
import { describe, it, expect } from '@jest/globals';
import {
    CMD, buildPacket, checksum, commKey, decodeTime, encodeTime, frameTcp, splitTcpFrames,
    parsePacket, parseAttendance, parseUserPins, parseSizes, parseOption, toCaptureRow, USHRT_MAX,
} from '../../../../src/lib/deviceGateway/zkProtocol.js';

describe('packets', () => {
    it('builds the CONNECT packet byte for byte', () => {
        const { packet, replyId } = buildPacket(CMD.CONNECT, 0, USHRT_MAX - 1);
        expect(packet.toString('hex')).toBe('e80317fc00000000');
        expect(replyId).toBe(0);
    });
    it('builds an AUTH packet with the comm-key proof', () => {
        const { packet } = buildPacket(CMD.AUTH, 0x1a2b, 0, commKey(4242, 0x1a2b));
        expect(packet.toString('hex')).toBe('4e04ea492b1a010069343263');
    });
    it('checksum of an odd-length buffer adds the last byte', () => {
        expect(checksum(Buffer.from([0x01]))).toBe(USHRT_MAX - 2); // ~1 = -2, wrapped by +65535
    });
    it('frames and splits TCP packets, keeping partial data', () => {
        const a = buildPacket(CMD.ACK_OK, 7, 1, Buffer.from('hi')).packet;
        const b = buildPacket(CMD.ACK_OK, 7, 2).packet;
        const stream = Buffer.concat([frameTcp(a), frameTcp(b)]);
        const { packets, rest } = splitTcpFrames(stream.subarray(0, stream.length - 3));
        expect(packets).toHaveLength(1);
        expect(parsePacket(packets[0])).toMatchObject({ command: CMD.ACK_OK, sessionId: 7 });
        expect(parsePacket(packets[0]).data.toString()).toBe('hi');
        expect(rest.length).toBe(frameTcp(b).length - 3);
    });
    it('rejects data that is not a ZKTeco frame', () => {
        expect(() => splitTcpFrames(Buffer.from('GET / HTTP/1.1\r\n'))).toThrow('HR-7101');
    });
});

describe('comm key', () => {
    it('matches the reference for a sample key and for no key', () => {
        expect(commKey(4242, 0x1a2b).toString('hex')).toBe('69343263');
        expect(commKey(0, 7).toString('hex')).toBe('617d3279');
    });
});

describe('device time', () => {
    it('round-trips a wall time', () => {
        expect(encodeTime('2026-11-16 15:26:51')).toBe(863796411);
        expect(decodeTime(863796411)).toBe('2026-11-16 15:26:51');
        expect(decodeTime(0)).toBe('2000-01-01 00:00:00');
    });
    it('refuses malformed times', () => {
        expect(() => encodeTime('16/11/2026')).toThrow('HR-7104');
    });
});

const t = encodeTime('2026-11-20 09:05:07');

describe('attendance records', () => {
    it('decodes 16-byte records', () => {
        const rec = Buffer.alloc(16);
        rec.writeUInt32LE(1043, 0); rec.writeUInt32LE(t, 4); rec[8] = 1; rec[9] = 15; rec.writeUInt32LE(0, 12);
        const buf = Buffer.concat([Buffer.from([16, 0, 0, 0]), rec]);
        expect(parseAttendance(buf, 1)).toEqual([{ deviceUserId: '1043', time: '2026-11-20 09:05:07', status: 1, verifyMode: 15, workCode: 0 }]);
    });
    it('decodes 40-byte records', () => {
        const rec = Buffer.alloc(40);
        rec.writeUInt16LE(3, 0); rec.write('2001', 2, 'latin1'); rec[26] = 0; rec.writeUInt32LE(t, 27); rec[31] = 1;
        const buf = Buffer.concat([Buffer.from([40, 0, 0, 0]), rec]);
        expect(parseAttendance(buf, 1)[0]).toMatchObject({ deviceUserId: '2001', status: 0, verifyMode: 1, time: '2026-11-20 09:05:07' });
    });
    it('decodes 8-byte records through the user table (index -> PIN)', () => {
        const rec = Buffer.alloc(8);
        rec.writeUInt16LE(5, 0); rec[2] = 0; rec.writeUInt32LE(t, 3); rec[7] = 1;
        const users = Buffer.alloc(4 + 28);
        users.writeUInt32LE(28, 0); users.writeUInt16LE(5, 4); users.writeUInt32LE(4321, 4 + 24);
        const pins = parseUserPins(users, 1);
        expect(pins.get(5)).toBe('4321');
        expect(parseAttendance(Buffer.concat([Buffer.from([8, 0, 0, 0]), rec]), 1, pins)[0].deviceUserId).toBe('4321');
    });
    it('rejects an unknown record size', () => {
        expect(() => parseAttendance(Buffer.from([12, 0, 0, 0, ...Buffer.alloc(12)]), 1)).toThrow('HR-7107');
    });
    it('formats the intake row', () => {
        expect(toCaptureRow({ deviceUserId: '7', time: '2026-11-20 09:05:07', status: 0, verifyMode: 1, workCode: 0 }))
            .toBe('7\t2026-11-20 09:05:07\t0\t1\t0');
    });
});

describe('replies', () => {
    it('parses sizes and options', () => {
        const d = Buffer.alloc(80);
        d.writeInt32LE(12, 16); d.writeInt32LE(30, 24); d.writeInt32LE(1695, 32); d.writeInt32LE(100000, 64);
        expect(parseSizes(d)).toMatchObject({ users: 12, fingers: 30, records: 1695, recordsCapacity: 100000 });
        expect(parseOption(Buffer.from('~DeviceName=CL1\0', 'latin1'))).toBe('CL1');
        expect(parseOption(Buffer.from('~OS=\0', 'latin1'))).toBeNull();
    });
});
