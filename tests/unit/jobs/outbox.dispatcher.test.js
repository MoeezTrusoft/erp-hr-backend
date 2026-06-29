// tests/unit/jobs/outbox.dispatcher.test.js
//
// A.4 — claim/lease outbox dispatcher for HR. Drains unpublished OutboxEvent
// rows and XADDs the persisted EventEnvelope to a Redis stream. Proves:
//   * a free row is claimed, published (XADD), and marked publishedAt,
//   * a publish failure releases the claim + records lastError (retryable),
//   * the model-unavailable path is a safe no-op,
//   * the stream publisher XADDs the envelope verbatim (idempotency: eid = envelope.id),
//   * the heartbeat helper reports liveness for /compliance (A.6).
import { describe, it, expect, jest } from '@jest/globals';

import {
    runOutboxDispatch,
    createStreamPublisher,
    sanitiseWorkerId,
    generateWorkerId,
    readDispatcherHeartbeat,
    recordDispatcherHeartbeat,
    HR_EVENTS_STREAM,
} from '../../../src/jobs/outbox.dispatcher.js';

function envelopeRow(id, overrides = {}) {
    return {
        id,
        tenantId: '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007',
        eventName: 'hr.employee.lifecycle.v1',
        aggregateType: 'Employee',
        aggregateId: '42',
        payload: { id: 'env-' + id, name: 'hr.employee.lifecycle.v1', correlationId: 'c1' },
        attempts: 0,
        ...overrides,
    };
}

// A minimal prisma.outboxEvent stub with claimable rows.
function makePrisma(rows) {
    const state = rows.map((r) => ({ publishedAt: null, claimedAt: null, claimedBy: null, claimExpiresAt: null, ...r }));
    return {
        _state: state,
        outboxEvent: {
            findMany: jest.fn(async () => state.filter((r) => r.publishedAt == null)),
            updateMany: jest.fn(async ({ where, data }) => {
                let count = 0;
                for (const r of state) {
                    if (r.id !== where.id) continue;
                    if (where.publishedAt === null && r.publishedAt != null) continue;
                    if (where.claimedBy && r.claimedBy !== where.claimedBy) continue;
                    Object.assign(r, data, typeof data.attempts === 'object' ? { attempts: r.attempts + 1 } : {});
                    count += 1;
                }
                return { count };
            }),
            update: jest.fn(),
        },
    };
}

describe('sanitiseWorkerId / generateWorkerId', () => {
    it('strips disallowed chars and caps length', () => {
        expect(sanitiseWorkerId('pod/a b!c')).toBe('podabc');
        expect(sanitiseWorkerId('')).toBeNull();
    });
    it('generates a non-empty worker id', () => {
        expect(generateWorkerId().length).toBeGreaterThan(0);
    });
});

describe('createStreamPublisher (XADD)', () => {
    it('XADDs the envelope verbatim with eid = envelope.id (idempotency key)', async () => {
        const xadd = jest.fn(async () => '1700000000000-0');
        const publisher = createStreamPublisher({ redis: { xadd } });

        const entryId = await publisher({
            eventName: 'hr.employee.lifecycle.v1',
            payload: { id: 'env-7', name: 'hr.employee.lifecycle.v1' },
            aggregateId: '42',
        });

        expect(entryId).toBe('1700000000000-0');
        expect(xadd).toHaveBeenCalledTimes(1);
        const args = xadd.mock.calls[0];
        expect(args[0]).toBe(HR_EVENTS_STREAM);
        expect(args[1]).toBe('*');
        // eid mirrors the envelope id for consumer-side dedupe
        expect(args).toContain('eid');
        const eidIdx = args.indexOf('eid');
        expect(args[eidIdx + 1]).toBe('env-7');
    });

    it('throws when redis.xadd is missing', () => {
        expect(() => createStreamPublisher({ redis: {} })).toThrow();
    });
});

describe('runOutboxDispatch (claim/lease)', () => {
    it('claims, publishes, and marks a free row', async () => {
        const prisma = makePrisma([envelopeRow('row-1')]);
        const publisher = jest.fn(async () => 'entry-1');

        const counts = await runOutboxDispatch({
            publisher,
            workerId: 'worker-a',
            prisma,
            logger: { info: jest.fn(), warn: jest.fn() },
        });

        expect(counts.published).toBe(1);
        expect(counts.failed).toBe(0);
        expect(publisher).toHaveBeenCalledTimes(1);
        expect(prisma._state[0].publishedAt).not.toBeNull();
    });

    it('records lastError + releases claim on publish failure (retryable)', async () => {
        const prisma = makePrisma([envelopeRow('row-2')]);
        const publisher = jest.fn(async () => {
            throw new Error('redis unreachable');
        });

        const counts = await runOutboxDispatch({
            publisher,
            workerId: 'worker-b',
            prisma,
            logger: { info: jest.fn(), warn: jest.fn() },
        });

        expect(counts.failed).toBe(1);
        expect(counts.published).toBe(0);
        expect(prisma._state[0].publishedAt).toBeNull(); // still unpublished → retry
        expect(prisma._state[0].lastError).toMatch(/redis/i);
        expect(prisma._state[0].claimedBy).toBeNull(); // claim released
    });

    it('is a no-op when the OutboxEvent model is unavailable', async () => {
        const counts = await runOutboxDispatch({
            publisher: jest.fn(),
            workerId: 'worker-c',
            prisma: {},
            logger: { info: jest.fn(), warn: jest.fn() },
        });
        expect(counts.published).toBe(0);
        expect(counts.scanned).toBe(0);
    });

    it('rejects an empty worker id', async () => {
        await expect(
            runOutboxDispatch({ publisher: jest.fn(), workerId: '!!!', prisma: makePrisma([]) })
        ).rejects.toThrow();
    });
});

describe('dispatcher heartbeat (A.6 input)', () => {
    it('records and reads back a heartbeat as fresh', () => {
        const store = {};
        recordDispatcherHeartbeat({ store, now: () => 1000 });
        const hb = readDispatcherHeartbeat({ store, now: () => 1500, maxStaleMs: 60_000 });
        expect(hb.ok).toBe(true);
        expect(hb.staleMs).toBe(500);
    });

    it('reports not-ok when the last beat is older than maxStaleMs', () => {
        const store = {};
        recordDispatcherHeartbeat({ store, now: () => 1000 });
        const hb = readDispatcherHeartbeat({ store, now: () => 1000 + 120_000, maxStaleMs: 60_000 });
        expect(hb.ok).toBe(false);
    });

    it('reports not-ok when no beat has ever been recorded', () => {
        const hb = readDispatcherHeartbeat({ store: {}, now: () => 1000, maxStaleMs: 60_000 });
        expect(hb.ok).toBe(false);
        expect(hb.lastBeatMs).toBeNull();
    });
});
