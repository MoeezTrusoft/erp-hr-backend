// Recruitment Phase 7 exit gate, against a real PostgreSQL.
//
// "A requisition submit writes the status flip, its transition row and
// hr.recruitment.requisition_submitted.v1 in one transaction":
//   1. the Approval Centre's onSubmit, run in one tenant transaction, leaves the
//      requisition PENDING_APPROVAL, one DRAFT -> PENDING_APPROVAL transition
//      row with the caller and source, and one outbox row for the event,
//      routed to the requester's line manager;
//   2. the same submit rolled back (a later step of the centre fails) leaves
//      none of the three.
//
// Runs only when the database is reachable (a bare checkout stays green). Every
// row lives under a throwaway tenant and is deleted afterwards.
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';

const TENANT = randomUUID();

const { default: prisma } = await import('../../src/lib/prisma.js');
const { mcpCtx } = await import('../../src/mcp/context.js');
const { tenantTransaction } = await import('../../src/lib/rlsTenant.js');
const { onSubmit } = await import('../../src/services/approval/adapters.js');

const asSystem = (fn) => mcpCtx.run({ system: true }, async () => await fn());
const code = () => `T-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

let ready = false;
const W = {};

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1 FROM requisition_transitions LIMIT 1`;
        ready = true;
    } catch {
        ready = false;
        return;
    }
    await asSystem(async () => {
        const employee = (data) =>
            prisma.employee.create({
                data: { tenant_id: TENANT, status: 'active', employeeCategory: 'EMPLOYEE', employee_code: code(), ...data },
            });
        W.manager = await employee({ first_name: 'Line', last_name: 'Manager' });
        W.requester = await employee({ first_name: 'Req', last_name: 'Uester', managerId: W.manager.id });
        const requisition = (title) =>
            prisma.jobRequisition.create({ data: { tenantId: TENANT, title, requestedById: W.requester.id, status: 'DRAFT' } });
        W.committed = await requisition('P7 committed submit');
        W.rolledBack = await requisition('P7 rolled-back submit');
    });
}, 60_000);

afterAll(async () => {
    if (!ready) {
        await prisma.$disconnect();
        return;
    }
    const tables = await prisma.$queryRaw`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tenantId', 'tenant_id')`;
    for (let pass = 0; pass < 6; pass++) {
        let refused = 0;
        for (const { table_name: table, column_name: column } of tables) {
            try {
                await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}"::text = $1`, TENANT);
            } catch {
                refused += 1;
            }
        }
        if (!refused) break;
    }
    await prisma.$disconnect();
}, 120_000);

const submitIn = (tx, row) =>
    onSubmit(
        tx,
        { tenantId: TENANT, who: { id: W.requester.id }, now: new Date() },
        'REQUISITION',
        { row, definition: { model: 'jobRequisition' }, snapshot: {} },
        { reason: 'Need a hire', transitionSource: 'requisition.submit' },
    );

const stateOf = (requisitionId) =>
    asSystem(async () => ({
        requisition: await prisma.jobRequisition.findFirst({ where: { id: requisitionId } }),
        transitions: await prisma.requisitionTransition.findMany({ where: { requisitionId } }),
        events: (
            await prisma.outboxEvent.findMany({
                where: { tenantId: TENANT, eventName: 'hr.recruitment.requisition_submitted.v1', aggregateId: String(requisitionId) },
            })
        ),
    }));

describe('Phase 7 exit gate: a requisition submit is one transaction', () => {
    it('writes the flip, the transition row and the routed event together', async () => {
        if (!ready) return;
        await mcpCtx.run({ user: { tenantId: TENANT, employeeId: W.requester.id } }, async () =>
            await tenantTransaction(prisma, async (tx) => await submitIn(tx, W.committed), { tenantId: TENANT }),
        );
        const { requisition, transitions, events } = await stateOf(W.committed.id);
        expect(requisition.status).toBe('PENDING_APPROVAL');
        expect(transitions).toHaveLength(1);
        expect(transitions[0]).toMatchObject({
            fromStatus: 'DRAFT', toStatus: 'PENDING_APPROVAL', reason: 'Need a hire', actorId: W.requester.id, source: 'requisition.submit',
        });
        expect(events).toHaveLength(1);
        expect(events[0].payload.payload).toMatchObject({
            requisitionId: String(W.committed.id),
            pendingApproverId: String(W.manager.id),
            pendingStepOrder: 1,
        });
    }, 60_000);

    it('a rolled-back submit leaves no flip, no transition and no event', async () => {
        if (!ready) return;
        await expect(
            mcpCtx.run({ user: { tenantId: TENANT, employeeId: W.requester.id } }, async () =>
                await tenantTransaction(
                    prisma,
                    async (tx) => {
                        await submitIn(tx, W.rolledBack);
                        throw new Error('a later step of the centre failed');
                    },
                    { tenantId: TENANT },
                ),
            ),
        ).rejects.toThrow('a later step of the centre failed');
        const { requisition, transitions, events } = await stateOf(W.rolledBack.id);
        expect(requisition.status).toBe('DRAFT');
        expect(transitions).toHaveLength(0);
        expect(events).toHaveLength(0);
    }, 60_000);
});
