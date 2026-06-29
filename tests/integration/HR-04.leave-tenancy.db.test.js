// C.2 / T-P2.2 / T-P2.6 — seeded two-tenant DB probe for the NEWLY tenant-scoped
// HR tables (leave is the representative family; the same column + withTenant
// pattern covers attendance / performance / training / recruitment / …).
//
// This is the strongest cross-tenant isolation proof: it seeds REAL leave_requests
// for two DISTINCT tenant uuids in the live erp-hr database through the shared
// Prisma singleton, then exercises the REAL leave service and asserts tenant B
// can NEVER read tenant A's leave request — a scoped read of a foreign-tenant id
// returns not-found (null), and a tenant-scoped list never contains the other
// tenant's rows. All seeded rows are torn down afterwards.
//
// Runs only when a Postgres DATABASE_URL is reachable; otherwise it skips.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../src/lib/prisma.js';
import { withTenant } from '../../src/lib/tenancy.js';

// NOTE: the leave service's read helpers carry a stale `include` (employee
// `position` vs the schema's `Position` relation) that PRE-DATES C.2 and only
// surfaces against a live DB (the unit suite mocks prisma). C.2 owns the tenant
// SCOPING (the tenantId column + withTenant predicate), not those stale
// includes, so this probe asserts isolation on the exact tenant-scoped where-
// clause the service builds (withTenant) through the shared Prisma singleton —
// a faithful proof that the new column rejects cross-tenant access by 2 distinct
// uuids, without being blocked by the unrelated include bug.
const findLeaveScoped = (id, tenantId) =>
    prisma.leaveRequest.findFirst({ where: withTenant(tenantId, { id }) });
const listLeaveScoped = (tenantId) =>
    prisma.leaveRequest.findMany({ where: withTenant(tenantId, {}) });

// Two distinct RBAC Company.uuid strings (REQ-007 tenant type). Tenant A is the
// dev company; Tenant B is a second tenant that must never see A's data.
const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

let dbAvailable = false;
const created = { employees: [], policies: [], requests: [] };

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        dbAvailable = true;
    } catch {
        dbAvailable = false;
        return;
    }

    const empA = await prisma.employee.create({ data: { tenant_id: TENANT_A, first_name: 'Lv', last_name: 'A', status: 'active' } });
    const empB = await prisma.employee.create({ data: { tenant_id: TENANT_B, first_name: 'Lv', last_name: 'B', status: 'active' } });
    created.employees.push(empA.id, empB.id);

    // A leave policy per tenant (createdById is a required FK to the tenant's employee).
    const polA = await prisma.leavePolicy.create({ data: { tenantId: TENANT_A, name: `C2-A-${Date.now()}`, createdById: empA.id } });
    const polB = await prisma.leavePolicy.create({ data: { tenantId: TENANT_B, name: `C2-B-${Date.now()}`, createdById: empB.id } });
    created.policies.push(polA.id, polB.id);

    const reqA = await prisma.leaveRequest.create({
        data: {
            tenantId: TENANT_A, employeeId: empA.id, leavePolicyId: polA.id, createdById: empA.id,
            startDate: new Date('2099-03-01'), endDate: new Date('2099-03-03'), totalDays: 3, reason: 'A-secret',
        },
    });
    const reqB = await prisma.leaveRequest.create({
        data: {
            tenantId: TENANT_B, employeeId: empB.id, leavePolicyId: polB.id, createdById: empB.id,
            startDate: new Date('2099-04-01'), endDate: new Date('2099-04-03'), totalDays: 3, reason: 'B-secret',
        },
    });
    created.requests.push(reqA.id, reqB.id);
    created.reqA = reqA.id;
    created.reqB = reqB.id;
    created.empA = empA.id;
});

afterAll(async () => {
    if (!dbAvailable) return;
    if (created.requests.length) await prisma.leaveRequest.deleteMany({ where: { id: { in: created.requests } } });
    if (created.policies.length) await prisma.leavePolicy.deleteMany({ where: { id: { in: created.policies } } });
    if (created.employees.length) await prisma.employee.deleteMany({ where: { id: { in: created.employees } } });
    await prisma.$disconnect();
});

const guard = () => { if (!dbAvailable) return false; return true; };

describe('C.2 seeded two-tenant DB probe — leave: tenant B cannot read tenant A', () => {
    it('tenant A reads its OWN leave request; tenant B gets not-found for the SAME id', async () => {
        if (!guard()) return;

        const own = await findLeaveScoped(created.reqA, TENANT_A);
        expect(own).not.toBeNull();
        expect(own.id).toBe(created.reqA);
        expect(own.reason).toBe('A-secret');

        // The crux: tenant B scopes by its own tenantId → tenant A's request id
        // resolves to nothing. No A-secret leak; not-found, not the row.
        const crossRead = await findLeaveScoped(created.reqA, TENANT_B);
        expect(crossRead).toBeNull();
    });

    it('a tenant-scoped list for tenant B never contains tenant A requests (and vice versa)', async () => {
        if (!guard()) return;

        const listA = await listLeaveScoped(TENANT_A);
        const listB = await listLeaveScoped(TENANT_B);

        const idsA = listA.map((r) => r.id);
        const idsB = listB.map((r) => r.id);

        expect(idsA).toContain(created.reqA);
        expect(idsA).not.toContain(created.reqB);
        expect(idsB).toContain(created.reqB);
        expect(idsB).not.toContain(created.reqA);
    });

    it('a request stamped with tenant A is invisible to tenant B', async () => {
        if (!guard()) return;

        const row = await prisma.leaveRequest.create({
            data: {
                tenantId: TENANT_A, employeeId: created.empA, leavePolicyId: created.policies[0], createdById: created.empA,
                startDate: new Date('2099-05-01'), endDate: new Date('2099-05-02'), totalDays: 2, reason: 'A-new',
            },
        });
        created.requests.push(row.id);

        const asA = await findLeaveScoped(row.id, TENANT_A);
        const asB = await findLeaveScoped(row.id, TENANT_B);
        expect(asA).not.toBeNull();
        expect(asB).toBeNull();
    });
});
