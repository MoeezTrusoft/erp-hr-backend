// Pure planning helpers for the pull connector (config parsing and which records to forward).
export const OVERLAP_MS = 10 * 60 * 1000;

/** DEVICE_PULL_TARGETS='[{"sn":"..","host":"..","port":4370,"transport":"tcp"}]', DEVICE_COMM_KEYS='{"<sn>":"<key>"}'. */
export function parseTargets(env = process.env) {
    const list = JSON.parse(env.DEVICE_PULL_TARGETS || '[]');
    const keys = JSON.parse(env.DEVICE_COMM_KEYS || '{}');
    if (!Array.isArray(list)) throw new Error('HR-7120: DEVICE_PULL_TARGETS must be a JSON array');
    return list.map((t) => {
        if (!t?.sn || !t?.host) throw new Error('HR-7121: each pull target needs sn and host');
        const transport = t.transport === 'udp' ? 'udp' : 'tcp';
        return { sn: String(t.sn), host: String(t.host), port: Number(t.port) || 4370, transport, commKey: keys[t.sn] ?? 0 };
    });
}

/** Wall time minus the overlap, compared as text ("YYYY-MM-DD HH:MM:SS" sorts chronologically). */
export function cursorFloor(cursor) {
    if (!cursor) return null;
    const at = new Date(`${cursor.replace(' ', 'T')}Z`).getTime() - OVERLAP_MS;
    return new Date(at).toISOString().slice(0, 19).replace('T', ' ');
}

/** Records to forward: at/after the floor, oldest first. */
export function newRecords(records, cursor) {
    const floor = cursorFloor(cursor);
    return records.filter((r) => !floor || r.time >= floor).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
