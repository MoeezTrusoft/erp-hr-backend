// ZkClient against a fake device on a local TCP port: comm-key auth, clock read, chunked log read.
import net from 'node:net';
import { describe, it, expect, afterEach } from '@jest/globals';
import { ZkClient } from '../../../../src/lib/deviceGateway/zkClient.js';
import { CMD, buildPacket, frameTcp, splitTcpFrames, parsePacket, commKey, encodeTime } from '../../../../src/lib/deviceGateway/zkProtocol.js';

const SESSION = 0x2a31;

function attendanceLog(n) {
    const body = Buffer.alloc(16 * n);
    for (let i = 0; i < n; i += 1) {
        body.writeUInt32LE(1000 + i, i * 16);
        body.writeUInt32LE(encodeTime(`2026-11-20 08:${String(i % 60).padStart(2, '0')}:00`), i * 16 + 4);
        body[i * 16 + 9] = 1;
    }
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
}

function fakeDevice({ key, records }) {
    const log = attendanceLog(records);
    const seen = [];
    let authed = key === 0;
    const server = net.createServer((sock) => {
        let buf = Buffer.alloc(0);
        let rid = 0;
        const reply = (command, data = Buffer.alloc(0)) => {
            const { packet, replyId } = buildPacket(command, SESSION, rid, data);
            rid = replyId;
            sock.write(frameTcp(packet));
        };
        sock.on('data', (chunk) => {
            const { packets, rest } = splitTcpFrames(Buffer.concat([buf, chunk]));
            buf = rest;
            for (const raw of packets) {
                const p = parsePacket(raw);
                seen.push(p.command);
                if (p.command === CMD.CONNECT) reply(authed ? CMD.ACK_OK : CMD.ACK_UNAUTH);
                else if (p.command === CMD.AUTH) {
                    authed = p.data.equals(commKey(key, SESSION));
                    reply(authed ? CMD.ACK_OK : CMD.ACK_UNAUTH);
                } else if (!authed) reply(CMD.ACK_UNAUTH);
                else if (p.command === CMD.GET_TIME) {
                    const d = Buffer.alloc(4); d.writeUInt32LE(encodeTime('2026-11-20 09:00:00'), 0); reply(CMD.ACK_OK, d);
                } else if (p.command === CMD.GET_FREE_SIZES) {
                    const d = Buffer.alloc(80); d.writeInt32LE(1, 16); d.writeInt32LE(records, 32); reply(CMD.ACK_OK, d);
                } else if (p.command === CMD.PREPARE_BUFFER) {
                    const d = Buffer.alloc(5); d.writeUInt32LE(log.length, 1); reply(CMD.ACK_OK, d);
                } else if (p.command === CMD.READ_BUFFER) {
                    const start = p.data.readInt32LE(0); const size = p.data.readInt32LE(4);
                    const part = log.subarray(start, start + size);
                    const head = Buffer.alloc(4); head.writeUInt32LE(part.length, 0);
                    reply(CMD.PREPARE_DATA, head);
                    for (let o = 0; o < part.length; o += 1024) reply(CMD.DATA, part.subarray(o, o + 1024));
                    reply(CMD.ACK_OK);
                } else reply(CMD.ACK_OK);
            }
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

let dev;
afterEach(async () => { await new Promise((r) => dev?.server.close(r)); dev = null; });

describe('ZkClient', () => {
    it('authenticates with the comm key, reads the clock and the whole log', async () => {
        dev = await fakeDevice({ key: 4242, records: 300 });
        const zk = await new ZkClient({ host: '127.0.0.1', port: dev.port, commKey: 4242, timeoutMs: 2000 }).connect();
        expect(await zk.deviceTime()).toBe('2026-11-20 09:00:00');
        const rows = await zk.attendance();
        await zk.close();
        expect(rows).toHaveLength(300);
        expect(rows[0]).toMatchObject({ deviceUserId: '1000', time: '2026-11-20 08:00:00', verifyMode: 1 });
        expect(rows[299].deviceUserId).toBe('1299');
        expect(dev.seen).toEqual(expect.arrayContaining([CMD.AUTH, CMD.PREPARE_BUFFER, CMD.READ_BUFFER, CMD.FREE_DATA, CMD.EXIT]));
    });

    it('fails clearly when the comm key is wrong', async () => {
        dev = await fakeDevice({ key: 4242, records: 1 });
        await expect(new ZkClient({ host: '127.0.0.1', port: dev.port, commKey: 1234, timeoutMs: 2000 }).connect())
            .rejects.toThrow('HR-7110');
    });

    it('times out instead of hanging when the device is silent', async () => {
        // Reads (so it notices the client hanging up) but never answers.
        const silent = net.createServer((s) => s.resume());
        await new Promise((r) => silent.listen(0, '127.0.0.1', r));
        dev = { server: silent };
        await expect(new ZkClient({ host: '127.0.0.1', port: silent.address().port, timeoutMs: 300 }).connect())
            .rejects.toThrow('HR-7119');
    });
});
