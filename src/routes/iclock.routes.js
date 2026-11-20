// ADMS push connector: the /iclock/* endpoints ZKTeco devices call when their Cloud Server points
// here. Only the device gateway process mounts this router, and the edge admits only the site IPs.
// A device is accepted only when its serial is registered and active in HR. Punches are acknowledged
// ("OK: n") only after the intake has stored them; on any failure the device keeps them and retries.
import express from 'express';
import logger from '../lib/logger.js';
import { serialOf, stampOf, handshakeBody, attlogRows } from '../lib/deviceGateway/admsProtocol.js';
import * as gateway from '../services/deviceGateway.service.js';

const log = logger.child({ component: 'device-gateway-adms' });
const HEARTBEAT_EVERY_MS = 60 * 1000;

export function createIclockRouter({ store, deps = gateway } = {}) {
    const router = express.Router();
    const lastBeat = new Map();
    router.use(express.text({ type: () => true, limit: '2mb' }));
    router.use((_req, res, next) => { res.type('text/plain'); next(); });

    const deviceFor = async (req, res, kind) => {
        const sn = serialOf(req.query);
        const device = sn ? await deps.findActiveDevice(sn) : null;
        if (!device) {
            gateway.metrics.requests.inc({ connector: 'adms', kind, result: 'unknown_device' });
            log.warn({ sn: sn ?? 'invalid', kind }, 'request from an unregistered or inactive device');
            res.status(403).send('UNKNOWN DEVICE');
            return null;
        }
        return device;
    };

    const beat = async (device) => {
        const now = Date.now();
        if (now - (lastBeat.get(device.sn) ?? 0) < HEARTBEAT_EVERY_MS) return;
        lastBeat.set(device.sn, now);
        await deps.heartbeat({ device, connector: 'adms' });
    };

    const wrap = (kind, fn) => async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            gateway.metrics.requests.inc({ connector: 'adms', kind, result: 'error' });
            log.warn({ kind, status: err.status, err: err.message }, 'device request failed');
            if (!res.headersSent) res.status(err.status && err.status < 500 ? err.status : 503).send('ERROR');
        }
    };

    router.get('/cdata', wrap('handshake', async (req, res) => {
        const device = await deviceFor(req, res, 'handshake');
        if (!device) return;
        await beat(device);
        const attStamp = (await store.get(`adms-stamp:${device.sn}`)) ?? '0';
        gateway.metrics.requests.inc({ connector: 'adms', kind: 'handshake', result: 'ok' });
        res.send(handshakeBody({ sn: device.sn, attStamp, timeZone: device.timeZone }));
    }));

    router.post('/cdata', wrap('upload', async (req, res) => {
        const device = await deviceFor(req, res, 'upload');
        if (!device) return;
        const rows = attlogRows(req.body);
        const table = String(req.query.table ?? '').toUpperCase();
        if (table === 'ATTLOG' && rows.length) {
            await deps.forwardRows({ sn: device.sn, rows, connector: 'adms', source: 'DEVICE_PUSH' });
            const stamp = stampOf(req.query);
            if (stamp) await store.set(`adms-stamp:${device.sn}`, stamp);
        }
        // Other tables (operation log, user info, templates, photos) are acknowledged and discarded:
        // the gateway stores punches only.
        await beat(device);
        gateway.metrics.requests.inc({ connector: 'adms', kind: `upload_${table.toLowerCase() || 'unknown'}`, result: 'ok' });
        res.send(`OK: ${rows.length}`);
    }));

    router.get('/getrequest', wrap('poll', async (req, res) => {
        const device = await deviceFor(req, res, 'poll');
        if (!device) return;
        await beat(device);
        res.send('OK');
    }));

    router.post('/devicecmd', wrap('command_result', async (req, res) => {
        const device = await deviceFor(req, res, 'command_result');
        if (!device) return;
        res.send('OK');
    }));

    return router;
}
