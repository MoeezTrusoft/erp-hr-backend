// ZKTeco ADMS ("iclock" push) protocol helpers. Pure functions; the HTTP routes live in
// src/routes/iclock.routes.js. Devices configured with a Cloud Server address call:
//   GET  /iclock/cdata?SN=..&options=all     handshake -> server options
//   POST /iclock/cdata?SN=..&table=ATTLOG    punches, one tab-separated line each -> "OK: n"
//   GET  /iclock/getrequest?SN=..            command poll (doubles as heartbeat) -> "OK"
//   POST /iclock/devicecmd?SN=..             command results -> "OK"
// The HTTP Date header of every reply lets the device keep its clock in step.

export const SERIAL_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Validated serial from the query string, or null. */
export function serialOf(query) {
    const sn = String(query?.SN ?? query?.sn ?? '').trim();
    return SERIAL_RE.test(sn) ? sn : null;
}

/** Whole-hour offset of an IANA zone at `at` (devices take an integer TimeZone option). */
export function utcOffsetHours(timeZone, at = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    // The parts carry no milliseconds; compare whole seconds so UTC gives 0, not -0.
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 3600000);
}

/**
 * Handshake reply. ATTLOGStamp is the last stamp the device reported back to us; with none
 * stored ("0") the device uploads its whole log once, which the intake de-duplicates.
 * OPERLOG / photo uploads are switched off: HR stores punches only, never templates or photos.
 */
export function handshakeBody({ sn, attStamp = '0', timeZone = 'UTC', now = new Date() }) {
    return [
        `GET OPTION FROM: ${sn}`,
        `ATTLOGStamp=${attStamp}`,
        'OPERLOGStamp=9999',
        'ATTPHOTOStamp=9999',
        'ErrorDelay=30',
        'Delay=10',
        'TransTimes=00:00;14:05',
        'TransInterval=1',
        'TransFlag=1000000000',
        `TimeZone=${utcOffsetHours(timeZone, now)}`,
        'Realtime=1',
        'Encrypt=0',
        '',
    ].join('\n');
}

/** ATTLOG body -> intake rows (non-empty lines, CR stripped). Extra trailing fields are kept as evidence. */
export function attlogRows(body) {
    return String(body ?? '')
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.trim() !== '');
}

/** Stamp the device sends on a POST (it must be echoed in the next handshake), or null. */
export function stampOf(query) {
    const v = String(query?.Stamp ?? query?.stamp ?? '');
    return /^\d{1,20}$/.test(v) ? v : null;
}

/** Splits rows into intake-sized batches. */
export function batches(rows, size) {
    const out = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
}
