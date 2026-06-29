#!/usr/bin/env node
// erp-hr-backend/scripts/outbox-dispatch.js — A.4.
//
// One-shot CLI for the HR OutboxEvent dispatcher with claim-based leasing.
// Safe to run on multiple replicas concurrently — each invocation claims rows
// under its own --worker-id and releases them on success or failure. Drains the
// outbox to the `hr:events` Redis stream via XADD; each entry carries the
// conformant EventEnvelope verbatim with eid=envelope.id for consumer dedupe.
//
// Usage:
//   node scripts/outbox-dispatch.js
//   node scripts/outbox-dispatch.js --batch=100 --lease-ms=30000
//   node scripts/outbox-dispatch.js --worker-id=cron-pod-a
//
// Defaults: --batch 50 (cap 500), --lease-ms 60000, --worker-id auto.
//
// Exit codes: 0 batch completed; 1 runtime/config error (REDIS_URL missing);
//             2 invalid CLI argument.
//
// Output policy: bounded counts + worker id only. NEVER payload bodies,
// tenant ids, or stack traces.
import Redis from 'ioredis';

import prisma from '../src/lib/prisma.js';
import logger from '../src/lib/logger.js';
import {
    runOutboxDispatch,
    createStreamPublisher,
    sanitiseWorkerId,
    generateWorkerId,
} from '../src/jobs/outbox.dispatcher.js';

function parseArgs(argv) {
    const out = { batchSize: 50, leaseMs: 60_000, workerId: null };
    for (const arg of argv.slice(2)) {
        if (arg.startsWith('--batch=')) {
            const v = Number.parseInt(arg.slice('--batch='.length), 10);
            if (!Number.isFinite(v) || v <= 0) {
                process.stderr.write(`invalid --batch value: ${arg}\n`);
                process.exit(2);
            }
            out.batchSize = v;
        } else if (arg.startsWith('--lease-ms=')) {
            const v = Number.parseInt(arg.slice('--lease-ms='.length), 10);
            if (!Number.isFinite(v) || v <= 0) {
                process.stderr.write(`invalid --lease-ms value: ${arg}\n`);
                process.exit(2);
            }
            out.leaseMs = v;
        } else if (arg.startsWith('--worker-id=')) {
            const cleaned = sanitiseWorkerId(arg.slice('--worker-id='.length));
            if (!cleaned) {
                process.stderr.write('invalid --worker-id value\n');
                process.exit(2);
            }
            out.workerId = cleaned;
        } else if (arg === '--help' || arg === '-h') {
            process.stdout.write(
                'usage: outbox-dispatch [--batch=N] [--lease-ms=N] [--worker-id=ID]\n'
            );
            process.exit(0);
        } else {
            process.stderr.write(`unknown arg: ${arg}\n`);
            process.exit(2);
        }
    }
    if (!out.workerId) out.workerId = generateWorkerId();
    return out;
}

async function main() {
    const opts = parseArgs(process.argv);

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        process.stderr.write('REDIS_URL not configured — refusing to run dispatcher\n');
        return 1;
    }

    const redis = new Redis(redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    });
    redis.on('error', (err) => logger.warn({ err }, 'hr outbox dispatcher: redis error'));

    try {
        const publisher = createStreamPublisher({ redis });
        const counts = await runOutboxDispatch({
            publisher,
            workerId: opts.workerId,
            batchSize: opts.batchSize,
            leaseMs: opts.leaseMs,
            prisma,
            logger,
        });
        process.stdout.write(
            `hr outbox dispatcher: scanned=${counts.scanned}` +
            ` claimed=${counts.claimed} published=${counts.published}` +
            ` failed=${counts.failed} skipped=${counts.skipped}` +
            ` workerId=${opts.workerId}\n`
        );
        return 0;
    } finally {
        try { await redis.quit(); } catch { /* best effort */ }
    }
}

main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
        logger.error({ err }, 'hr outbox dispatcher: unhandled error');
        process.exit(1);
    });
