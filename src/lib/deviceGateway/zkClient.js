// Minimal ZKTeco SDK client for the pull connector. Read-mostly: connect + comm-key auth, version,
// options, sizes, clock read, attendance log read; the only write is CMD_SET_TIME (HR clock-fix commands).
// Every await is bounded by `timeoutMs`; one client = one device session (devices allow one).
import net from 'node:net';
import dgram from 'node:dgram';
import {
    CMD, FCT_USER, buildPacket, frameTcp, splitTcpFrames, parsePacket, commKey,
    decodeTime, encodeTime, parseSizes, parseOption, parseUserPins, parseAttendance, USHRT_MAX,
} from './zkProtocol.js';

const TCP_CHUNK = 0xffc0;
const UDP_CHUNK = 16 * 1024;

export class ZkClient {
    constructor({ host, port = 4370, transport = 'tcp', commKey: key = 0, timeoutMs = 10000 }) {
        Object.assign(this, { host, port, transport, key: Number(key) || 0, timeoutMs });
        this.sessionId = 0;
        this.replyId = USHRT_MAX - 1;
        this.queue = [];
        this.waiters = [];
        this.buffer = Buffer.alloc(0);
        this.closed = false;
    }

    async connect() {
        try {
            await (this.transport === 'udp' ? this.#openUdp() : this.#openTcp());
            const hello = await this.command(CMD.CONNECT);
            this.sessionId = hello.sessionId;
            if (hello.command === CMD.ACK_UNAUTH) {
                const auth = await this.command(CMD.AUTH, commKey(this.key, this.sessionId));
                if (auth.command !== CMD.ACK_OK) throw new Error('HR-7110: device rejected the comm key');
            } else if (hello.command !== CMD.ACK_OK) {
                throw new Error(`HR-7111: device refused the session (reply ${hello.command})`);
            }
            return this;
        } catch (err) {
            this.sessionId = 0; // no EXIT for a session that never opened
            await this.close();
            throw err;
        }
    }

    async close() {
        if (this.closed) return;
        try { if (this.sessionId) await this.command(CMD.EXIT); } catch { /* best effort */ }
        this.closed = true;
        this.socket?.destroy?.();
        this.socket?.close?.();
        this.#fail(new Error('HR-7112: connection closed'));
    }

    async version() {
        const r = await this.command(CMD.GET_VERSION);
        return r.data.toString('latin1').split('\0')[0];
    }

    async option(name) {
        const r = await this.command(CMD.OPTIONS_RRQ, Buffer.from(`${name}\0`, 'latin1'));
        return r.command === CMD.ACK_OK ? parseOption(r.data) : null;
    }

    async sizes() {
        const r = await this.command(CMD.GET_FREE_SIZES);
        return parseSizes(r.data);
    }

    async deviceTime() {
        const r = await this.command(CMD.GET_TIME);
        if (r.command !== CMD.ACK_OK || r.data.length < 4) throw new Error('HR-7113: device did not report its time');
        return decodeTime(r.data.readUInt32LE(0));
    }

    /** Sets the device clock to a wall time "YYYY-MM-DD HH:MM:SS" (device local time). */
    async setTime(wall) {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(encodeTime(wall), 0);
        const r = await this.command(CMD.SET_TIME, b);
        if (r.command !== CMD.ACK_OK) throw new Error('HR-7114: device did not accept the time');
    }

    /** Whole attendance log as [{deviceUserId, time, status, verifyMode, workCode}]. */
    async attendance() {
        const { users, records } = await this.sizes();
        if (!records) return [];
        const log = await this.#readBuffer(CMD.ATTLOG_RRQ);
        const size = log.length >= 4 ? Math.floor(log.readUInt32LE(0) / records) : 0;
        // Oldest firmware stores the internal user index; map it to the enrolment number (PIN).
        const pins = size === 8 && users ? parseUserPins(await this.#readBuffer(CMD.USERTEMP_RRQ, FCT_USER), users) : new Map();
        return parseAttendance(log, records, pins);
    }

    async command(command, data = Buffer.alloc(0)) {
        const { packet, replyId } = buildPacket(command, this.sessionId, this.replyId, data);
        this.replyId = replyId;
        this.#send(packet);
        return this.#next();
    }

    async #readBuffer(command, fct = 0) {
        const req = Buffer.alloc(11);
        req.writeInt8(1, 0);
        req.writeInt16LE(command, 1);
        req.writeInt32LE(fct, 3);
        req.writeInt32LE(0, 7);
        const first = await this.command(CMD.PREPARE_BUFFER, req);
        if (first.command === CMD.DATA) return first.data;
        if (first.command !== CMD.ACK_OK || first.data.length < 5) throw new Error('HR-7115: device refused the data read');
        const total = first.data.readUInt32LE(1);
        const max = this.transport === 'udp' ? UDP_CHUNK : TCP_CHUNK;
        const parts = [];
        for (let start = 0; start < total; start += max) parts.push(await this.#readChunk(start, Math.min(max, total - start)));
        await this.command(CMD.FREE_DATA).catch(() => undefined);
        return Buffer.concat(parts);
    }

    async #readChunk(start, size) {
        const req = Buffer.alloc(8);
        req.writeInt32LE(start, 0);
        req.writeInt32LE(size, 4);
        const r = await this.command(CMD.READ_BUFFER, req);
        if (r.command === CMD.DATA) return r.data;
        if (r.command !== CMD.PREPARE_DATA) throw new Error(`HR-7116: unexpected reply ${r.command} to a chunk read`);
        const parts = [];
        let got = 0;
        while (got < size) {
            const p = await this.#next();
            if (p.command === CMD.DATA) { parts.push(p.data); got += p.data.length; }
            else if (p.command === CMD.ACK_OK) break;
            else throw new Error(`HR-7117: unexpected reply ${p.command} during a chunk`);
        }
        // Devices close a chunk with ACK_OK; consume it when it was not already seen.
        if (got >= size) await this.#next().catch(() => undefined);
        return Buffer.concat(parts);
    }

    #openTcp() {
        return new Promise((resolve, reject) => {
            const s = net.createConnection({ host: this.host, port: this.port });
            const t = setTimeout(() => { s.destroy(); reject(new Error('HR-7118: connect timeout')); }, this.timeoutMs);
            s.once('connect', () => { clearTimeout(t); resolve(); });
            s.once('error', (e) => { clearTimeout(t); reject(e); this.#fail(e); });
            s.on('data', (chunk) => {
                try {
                    const { packets, rest } = splitTcpFrames(Buffer.concat([this.buffer, chunk]));
                    this.buffer = rest;
                    packets.forEach((p) => this.#push(parsePacket(p)));
                } catch (e) { this.#fail(e); s.destroy(); }
            });
            s.on('close', () => this.#fail(new Error('HR-7112: connection closed')));
            this.socket = s;
        });
    }

    #openUdp() {
        const s = dgram.createSocket('udp4');
        s.on('message', (msg) => { try { this.#push(parsePacket(msg)); } catch (e) { this.#fail(e); } });
        s.on('error', (e) => this.#fail(e));
        this.socket = s;
        return Promise.resolve();
    }

    #send(packet) {
        if (this.closed) throw new Error('HR-7112: connection closed');
        if (this.transport === 'udp') this.socket.send(packet, this.port, this.host);
        else this.socket.write(frameTcp(packet));
    }

    #push(p) {
        const w = this.waiters.shift();
        if (w) { clearTimeout(w.timer); w.resolve(p); } else this.queue.push(p);
    }

    #fail(err) {
        while (this.waiters.length) { const w = this.waiters.shift(); clearTimeout(w.timer); w.reject(err); }
    }

    #next() {
        if (this.queue.length) return Promise.resolve(this.queue.shift());
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w.timer !== timer);
                reject(new Error('HR-7119: device did not answer in time'));
            }, this.timeoutMs);
            this.waiters.push({ resolve, reject, timer });
        });
    }
}
