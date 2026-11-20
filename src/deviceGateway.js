// HR device gateway process (same image as the HR API, separate Deployment):
//   node src/deviceGateway.js
// Serves only /iclock/* (ADMS push), /healthz, /readyz and /metrics, and optionally runs the SDK
// pull connector. Configuration:
//   DEVICE_GATEWAY_PORT (3011)            DEVICE_GATEWAY_PUSH_ENABLED (true)
//   DEVICE_GATEWAY_PULL_ENABLED (false)   DEVICE_PULL_INTERVAL_SECONDS (60)
//   DEVICE_PULL_TARGETS / DEVICE_COMM_KEYS (JSON, comm keys from a sealed secret)
//   DEVICE_GATEWAY_COMMANDS_ENABLED (false: never writes to devices)   REDIS_URL (lease + state)
import express from 'express';
import Redis from 'ioredis';
import client from 'prom-client';
import prisma from './lib/prisma.js';
import logger from './lib/logger.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createIclockRouter } from './routes/iclock.routes.js';
import { createStateStore } from './services/deviceGateway.service.js';
import { createPuller, parseTargets } from './services/deviceGatewayPull.service.js';

const log = logger.child({ component: 'device-gateway' });
const flag = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

const port = Number(process.env.DEVICE_GATEWAY_PORT) || 3011;
const pushEnabled = flag(process.env.DEVICE_GATEWAY_PUSH_ENABLED, true);
const pullEnabled = flag(process.env.DEVICE_GATEWAY_PULL_ENABLED, false);
const commandsEnabled = flag(process.env.DEVICE_GATEWAY_COMMANDS_ENABLED, false);

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 }) : null;
redis?.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
if (!redis) log.warn('REDIS_URL not set: state is per-process and the pull lease is disabled (run one replica)');
const store = createStateStore(redis);
client.collectDefaultMetrics();

const app = express();
app.disable('x-powered-by');
app.use(createHealthRouter({ prisma }));
app.get('/metrics', async (_req, res) => {
    res.type(client.register.contentType).send(await client.register.metrics());
});
if (pushEnabled) app.use('/iclock', createIclockRouter({ store }));
app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

let puller = null;
if (pullEnabled) {
    puller = createPuller({
        targets: parseTargets(),
        store,
        redis,
        intervalSeconds: Number(process.env.DEVICE_PULL_INTERVAL_SECONDS) || 60,
        commandsEnabled,
    });
    puller.start();
}

const server = app.listen(port, () => log.info({ port, pushEnabled, pullEnabled, commandsEnabled }, 'device gateway listening'));
server.headersTimeout = 30000;
server.requestTimeout = 60000;

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'device gateway stopping');
    await puller?.stop().catch(() => undefined);
    await new Promise((r) => server.close(r));
    await redis?.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
