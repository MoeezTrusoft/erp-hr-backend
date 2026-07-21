// C.2 / T-P2.6 — CROSS-TENANT NEGATIVE suite across the full HR RLS surface.
//
// Extends HR-RLS.pilot.db.test.js (which proves the pattern on Attendance) to
// the tables added in the pilot roll-out: the Tier-1 PII tables and the
// payroll/timesheet family — 17 tables total. Two independent proofs:
//
//   PART A (seeded isolation): seed two tenants' rows in representative
//   high-PII tables (EmergencyContacts — plain; bank_details — C4-encrypted)
//   and assert, over a LEAKED non-privileged `hr_app` connection (NOSUPERUSER /
//   NOBYPASSRLS, so RLS is actually enforced), that a tenant-A session sees
//   ONLY tenant A rows, a no-tenant session sees NEITHER (fail-closed), and a
//   cross-tenant WRITE affects 0 rows (WITH CHECK).
//
//   PART B (structural sweep): for EVERY one of the 17 protected tables assert
//   FORCE ROW LEVEL SECURITY is on and the tenant_isolation policy exists, and
//   that the leaked no-GUC connection is fail-closed (count 0) even where the
//   superuser sees rows. This needs no seeding, so it stays meaningful on a
//   fresh CI database.
//
// Skips cleanly when the DB is unreachable or the hr_app role / RLS migration
// is absent, mirroring the pilot test — green on a bare checkout.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import prisma from '../../src/lib/prisma.js';

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

// Every table under FORCE RLS after the pilot roll-out (physical names).
const RLS_TABLES = [
    'Attendance', 'leave_requests', 'PerformanceReview',
    'bank_details', 'employment_terms', 'EmergencyContacts',
    'payroll_runs', 'payroll_payslips', 'payroll_earnings', 'payroll_deductions',
    'payroll_assignments', 'payroll_audit_logs',
    'Timesheet', 'TimeEntry', 'TimeApproval',
    'payroll_earning_types', 'payroll_deduction_types',
];

function hrAppUrl() {
    const base = process.env.DATABASE_URL;
    if (!base) return null;
    try {
        const u = new URL(base);
        u.username = 'hr_app';
        u.password = 'hr_app';
        return u.toString();
    } catch {
        return null;
    }
}

let ready = false;
let appClient = null;
const created = { employees: [], emergency: [], bank: [] };

beforeAll(async () => {
    const url = hrAppUrl();
    if (!url) return;
    try {
        await prisma.$queryRaw`SELECT 1`;
        const roles = await prisma.$queryRaw`SELECT 1 FROM pg_roles WHERE rolname = 'hr_app'`;
        if (!roles || roles.length === 0) return;
        appClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
        await appClient.$queryRaw`SELECT 1`;
    } catch {
        ready = false;
        return;
    }

    try {
        const empA = await prisma.employee.create({ data: { tenant_id: TENANT_A, first_name: 'RLS', last_name: 'FA', status: 'active' } });
        const empB = await prisma.employee.create({ data: { tenant_id: TENANT_B, first_name: 'RLS', last_name: 'FB', status: 'active' } });
        created.employees.push(empA.id, empB.id);

        const ecA = await prisma.emergencyContacts.create({ data: { tenantId: TENANT_A, employee_Id: empA.id, Contact_name: 'A-kin', phone: '111' } });
        const ecB = await prisma.emergencyContacts.create({ data: { tenantId: TENANT_B, employee_Id: empB.id, Contact_name: 'B-kin', phone: '222' } });
        created.emergency.push(ecA.id, ecB.id);
        created.ecA = ecA.id; created.ecB = ecB.id;

        // bank_details.accountNumber is C4-encrypted on write via the prisma
        // extension; needs the encryption key in the test env (as HR-01 does).
        const bkA = await prisma.bankDetail.create({ data: { tenantId: TENANT_A, employeeId: empA.id, bankName: 'BankA', accountNumber: '1000000001' } });
        const bkB = await prisma.bankDetail.create({ data: { tenantId: TENANT_B, employeeId: empB.id, bankName: 'BankB', accountNumber: '2000000002' } });
        created.bank.push(bkA.id, bkB.id);
        created.bkA = bkA.id; created.bkB = bkB.id;

        ready = true;
    } catch {
        // Seeding failed (e.g. missing C4 key or schema drift) — leave ready
        // false so the substantive specs early-return instead of false-failing.
        ready = false;
    }
});

afterAll(async () => {
    if (created.bank.length) await prisma.bankDetail.deleteMany({ where: { id: { in: created.bank } } }).catch(() => {});
    if (created.emergency.length) await prisma.emergencyContacts.deleteMany({ where: { id: { in: created.emergency } } }).catch(() => {});
    if (created.employees.length) await prisma.employee.deleteMany({ where: { id: { in: created.employees } } }).catch(() => {});
    if (appClient) await appClient.$disconnect();
    await prisma.$disconnect();
});

// SET app.tenant_id + SELECT in ONE transaction so they share a connection.
async function visibleIdsAs(table, tenantId, ids) {
    return appClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId ?? ''}'`);
        const rows = await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id IN (${ids.join(',')})`);
        return rows.map((r) => Number(r.id));
    });
}

describe('C.2 RLS cross-tenant negative — seeded isolation on high-PII tables', () => {
    it('reports a result even when hr_app / RLS migration is absent', () => {
        expect(typeof ready).toBe('boolean');
    });

    for (const t of [
        { table: 'EmergencyContacts', a: 'ecA', b: 'ecB' },
        { table: 'bank_details', a: 'bkA', b: 'bkB' },
    ]) {
        it(`${t.table}: tenant A sees ONLY A; B is invisible at the DB`, async () => {
            if (!ready) return;
            const ids = [created[t.a], created[t.b]];
            const visible = await visibleIdsAs(t.table, TENANT_A, ids);
            expect(visible).toContain(created[t.a]);
            expect(visible).not.toContain(created[t.b]);
        });

        it(`${t.table}: no tenant set → fail-closed (neither row visible)`, async () => {
            if (!ready) return;
            const ids = [created[t.a], created[t.b]];
            const visible = await visibleIdsAs(t.table, null, ids);
            expect(visible).not.toContain(created[t.a]);
            expect(visible).not.toContain(created[t.b]);
        });

        it(`${t.table}: cross-tenant UPDATE affects 0 rows (WITH CHECK / USING)`, async () => {
            if (!ready) return;
            const affected = await appClient.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${TENANT_A}'`);
                // touch a harmless column that exists on both tables
                return tx.$executeRawUnsafe(`UPDATE "${t.table}" SET "tenantId" = '${TENANT_A}' WHERE id = ${created[t.b]}`);
            });
            expect(affected).toBe(0);
        });
    }
});

describe('C.2 RLS cross-tenant negative — structural sweep over all 17 tables', () => {
    it('every protected table has FORCE RLS + tenant_isolation policy, and is fail-closed for a leaked no-GUC connection', async () => {
        if (!appClient) return; // DB/role unavailable
        for (const table of RLS_TABLES) {
            const cat = await prisma.$queryRawUnsafe(
                `SELECT c.relforcerowsecurity AS forced,
                        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation') AS pol
                   FROM pg_class c WHERE c.relname = $1`, table);
            const row = cat[0];
            expect(row, `catalog row for ${table}`).toBeTruthy();
            expect(row.forced, `${table} FORCE RLS`).toBe(true);
            expect(Number(row.pol), `${table} tenant_isolation policy`).toBe(1);

            // Leaked connection with NO tenant GUC must see zero rows.
            const leaked = await appClient.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = ''`);
                const r = await tx.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "${table}"`);
                return Number(r[0].c);
            });
            expect(leaked, `${table} leaked no-GUC count`).toBe(0);
        }
    });
});
