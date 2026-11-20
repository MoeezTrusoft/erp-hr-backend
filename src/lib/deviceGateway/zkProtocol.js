// ZKTeco "standalone SDK" protocol (TCP/UDP port 4370): packet framing, checksum, comm-key
// authentication, the device's packed time format and attendance/user record decoding.
// Pure functions only (no sockets) so every byte layout is unit-tested. Byte layouts follow
// the long-standing open implementation of the protocol (pyzk, GPL; reimplemented here, not copied).

export const CMD = Object.freeze({
    CONNECT: 1000,
    EXIT: 1001,
    AUTH: 1102,
    GET_VERSION: 1100,
    OPTIONS_RRQ: 11,
    GET_FREE_SIZES: 50,
    GET_TIME: 201,
    SET_TIME: 202,
    ATTLOG_RRQ: 13,
    USERTEMP_RRQ: 9,
    PREPARE_BUFFER: 1503,
    READ_BUFFER: 1504,
    FREE_DATA: 1502,
    PREPARE_DATA: 1500,
    DATA: 1501,
    ACK_OK: 2000,
    ACK_ERROR: 2001,
    ACK_UNAUTH: 2005,
});
export const FCT_USER = 5;
export const USHRT_MAX = 65535;
export const TCP_MAGIC_1 = 0x5050;
export const TCP_MAGIC_2 = 0x7d82;

/** 16-bit ones'-complement style checksum over the 8-byte header (checksum field zero) plus data. */
export function checksum(buf) {
    let sum = 0;
    let i = 0;
    for (; i + 1 < buf.length; i += 2) {
        sum += buf.readUInt16LE(i);
        if (sum > USHRT_MAX) sum -= USHRT_MAX;
    }
    if (i < buf.length) sum += buf[i];
    while (sum > USHRT_MAX) sum -= USHRT_MAX;
    sum = ~sum;
    while (sum < 0) sum += USHRT_MAX;
    return sum;
}

/** One command packet. `replyId` is the counter value BEFORE increment; the packet carries replyId+1. */
export function buildPacket(command, sessionId, replyId, data = Buffer.alloc(0)) {
    const draft = Buffer.alloc(8 + data.length);
    draft.writeUInt16LE(command, 0);
    draft.writeUInt16LE(0, 2);
    draft.writeUInt16LE(sessionId, 4);
    draft.writeUInt16LE(replyId, 6);
    data.copy(draft, 8);
    const sum = checksum(draft);
    const next = (replyId + 1) % USHRT_MAX;
    draft.writeUInt16LE(sum, 2);
    draft.writeUInt16LE(next, 6);
    return { packet: draft, replyId: next };
}

/** TCP adds an 8-byte prefix: two magic words and the packet length. */
export function frameTcp(packet) {
    const head = Buffer.alloc(8);
    head.writeUInt16LE(TCP_MAGIC_1, 0);
    head.writeUInt16LE(TCP_MAGIC_2, 2);
    head.writeUInt32LE(packet.length, 4);
    return Buffer.concat([head, packet]);
}

/** Splits complete TCP frames off the front of `buffer`. Returns { packets, rest }. */
export function splitTcpFrames(buffer) {
    const packets = [];
    let rest = buffer;
    while (rest.length >= 8) {
        if (rest.readUInt16LE(0) !== TCP_MAGIC_1 || rest.readUInt16LE(2) !== TCP_MAGIC_2)
            throw new Error('HR-7101: not a ZKTeco TCP frame');
        const len = rest.readUInt32LE(4);
        if (len < 8 || len > 1 << 20) throw new Error('HR-7102: invalid ZKTeco frame length');
        if (rest.length < 8 + len) break;
        packets.push(rest.subarray(8, 8 + len));
        rest = rest.subarray(8 + len);
    }
    return { packets, rest };
}

export function parsePacket(packet) {
    if (packet.length < 8) throw new Error('HR-7103: short ZKTeco packet');
    return {
        command: packet.readUInt16LE(0),
        sessionId: packet.readUInt16LE(4),
        replyId: packet.readUInt16LE(6),
        data: packet.subarray(8),
    };
}

/** Comm-key ("password") proof for CMD_AUTH, derived from the key, the session id and a tick byte. */
export function commKey(key, sessionId, ticks = 50) {
    const k32 = Number(key) >>> 0;
    let k = 0n;
    for (let i = 0; i < 32; i += 1) k = (k << 1n) | ((k32 >>> i) & 1 ? 1n : 0n);
    const v = Number((k + BigInt(sessionId)) & 0xffffffffn);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    const x = Buffer.from([b[0] ^ 0x5a, b[1] ^ 0x4b, b[2] ^ 0x53, b[3] ^ 0x4f]); // "ZKSO"
    const swapped = Buffer.alloc(4);
    swapped.writeUInt16LE(x.readUInt16LE(2), 0);
    swapped.writeUInt16LE(x.readUInt16LE(0), 2);
    const t = ticks & 0xff;
    return Buffer.from([swapped[0] ^ t, swapped[1] ^ t, t, swapped[3] ^ t]);
}

const pad = (n) => String(n).padStart(2, '0');

/** Device-packed time (UInt32 LE) -> device wall-clock text "YYYY-MM-DD HH:MM:SS". */
export function decodeTime(value) {
    let t = value >>> 0;
    const second = t % 60; t = Math.floor(t / 60);
    const minute = t % 60; t = Math.floor(t / 60);
    const hour = t % 24; t = Math.floor(t / 24);
    const day = (t % 31) + 1; t = Math.floor(t / 31);
    const month = (t % 12) + 1; t = Math.floor(t / 12);
    const year = t + 2000;
    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/** Wall-clock text "YYYY-MM-DD HH:MM:SS" -> device-packed time (for CMD_SET_TIME). */
export function encodeTime(wall) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(wall));
    if (!m) throw new Error('HR-7104: time must be YYYY-MM-DD HH:MM:SS');
    const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
    return (((year % 100) * 12 * 31 + (month - 1) * 31 + day - 1) * 86400
        + (hour * 60 + minute) * 60 + second) >>> 0;
}

/** CMD_GET_FREE_SIZES reply: users, fingerprints and attendance records stored (+ capacities). */
export function parseSizes(data) {
    if (data.length < 80) throw new Error('HR-7105: short free-sizes reply');
    const f = (i) => data.readInt32LE(i * 4);
    return {
        users: f(4), fingers: f(6), records: f(8),
        fingersCapacity: f(14), usersCapacity: f(15), recordsCapacity: f(16),
    };
}

/** CMD_OPTIONS_RRQ reply "~Name=value\0" -> value (or null). */
export function parseOption(data) {
    const text = data.toString('latin1').split('\0')[0];
    const i = text.indexOf('=');
    return i < 0 ? null : text.slice(i + 1) || null;
}

/**
 * User table (CMD_USERTEMP_RRQ, FCT_USER) -> Map(uid -> PIN). Only the internal index and the
 * enrolment number are kept: names, passwords and card numbers are never decoded.
 */
export function parseUserPins(buffer, userCount) {
    const pins = new Map();
    if (buffer.length < 4 || !userCount) return pins;
    const total = buffer.readUInt32LE(0);
    const size = total / userCount;
    const body = buffer.subarray(4);
    if (size === 28) {
        for (let o = 0; o + 28 <= body.length; o += 28)
            pins.set(body.readUInt16LE(o), String(body.readUInt32LE(o + 24)));
    } else if (size === 72) {
        for (let o = 0; o + 72 <= body.length; o += 72)
            pins.set(body.readUInt16LE(o), body.subarray(o + 48, o + 72).toString('latin1').split('\0')[0].trim());
    } else {
        throw new Error(`HR-7106: unsupported user record size ${size}`);
    }
    return pins;
}

/**
 * Attendance log (CMD_ATTLOG_RRQ) -> [{ deviceUserId, time, status, verifyMode, workCode }].
 * Record size is total / records: 8 (oldest firmware, uid index), 16 or 40 bytes.
 */
export function parseAttendance(buffer, recordCount, pins = new Map()) {
    if (buffer.length < 4 || !recordCount) return [];
    const total = buffer.readUInt32LE(0);
    const size = Math.floor(total / recordCount);
    const body = buffer.subarray(4);
    const out = [];
    if (size === 8) {
        for (let o = 0; o + 8 <= body.length; o += 8) {
            const uid = body.readUInt16LE(o);
            out.push({
                deviceUserId: pins.get(uid) ?? String(uid),
                status: body[o + 2],
                time: decodeTime(body.readUInt32LE(o + 3)),
                verifyMode: body[o + 7],
                workCode: 0,
            });
        }
    } else if (size === 16) {
        for (let o = 0; o + 16 <= body.length; o += 16) {
            out.push({
                deviceUserId: String(body.readUInt32LE(o)),
                time: decodeTime(body.readUInt32LE(o + 4)),
                status: body[o + 8],
                verifyMode: body[o + 9],
                workCode: body.readUInt32LE(o + 12),
            });
        }
    } else if (size === 40) {
        for (let o = 0; o + 40 <= body.length; o += 40) {
            out.push({
                deviceUserId: body.subarray(o + 2, o + 26).toString('latin1').split('\0')[0].trim(),
                status: body[o + 26],
                time: decodeTime(body.readUInt32LE(o + 27)),
                verifyMode: body[o + 31],
                workCode: 0,
            });
        }
    } else {
        throw new Error(`HR-7107: unsupported attendance record size ${size}`);
    }
    return out;
}

/** The row text HR's intake accepts: PIN, wall time, status, verify mode, work code (tab-separated). */
export function toCaptureRow(r) {
    return [r.deviceUserId, r.time, r.status, r.verifyMode, r.workCode].join('\t');
}
