// HR-PAYROLL-ADVANCE-01 — salary advances as a discriminated Loan.
//
// A salary advance is a loan with tenureMonths=1 and interestRatePct=0, so it
// rides the EXISTING machinery (payroll bridge + 40% garnishment cap +
// LoanRepayment ledger) rather than a parallel module. The only new thing is a
// discriminator, and these tests pin the three ways that discriminator can be
// wrong:
//   1. it is absent / not defaulted, so old rows change meaning;
//   2. it is not validated, so a typo'd kind reaches the column;
//   3. it is ignored by the aggregates, so an advance is silently counted as a
//      loan on the loans KPI tile.
// The MCP block also re-pins the standing trap: assertPermission takes an HTTP
// METHOD, not an action name — "CREATE" silently bypasses the check.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const schema = readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');

// ── 1. schema ───────────────────────────────────────────────────────────────
describe('HR-PAYROLL-ADVANCE-01 schema', () => {
    it('declares a LoanKind enum with exactly LOAN and ADVANCE', () => {
        const block = schema.match(/enum\s+LoanKind\s*\{([\s\S]*?)\n\}/);
        expect(block).not.toBeNull();
        const values = block[1].split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
        expect(values).toEqual(['LOAN', 'ADVANCE']);
    });

    it('puts the discriminator on Loan defaulting to LOAN so existing rows keep their meaning', () => {
        const loan = schema.match(/model\s+Loan\s*\{([\s\S]*?)\n\}/)[1];
        expect(loan).toMatch(/\bkind\s+LoanKind\s+@default\(LOAN\)/);
    });

    it('does not create a parallel advance model', () => {
        expect(schema).not.toMatch(/model\s+SalaryAdvance\s*\{/);
    });
});

// ── 2. migration ────────────────────────────────────────────────────────────
describe('HR-PAYROLL-ADVANCE-01 migration', () => {
    const dir = readdirSync(path.join(root, 'prisma/migrations'))
        .filter((d) => /^\d{14}_.*loan_kind$/.test(d));

    it('ships one timestamped migration directory', () => {
        expect(dir).toHaveLength(1);
    });

    it('is additive only — creates the type and adds the column, drops nothing', () => {
        const sql = readFileSync(path.join(root, 'prisma/migrations', dir[0], 'migration.sql'), 'utf8');
        expect(sql).toMatch(/CREATE TYPE "LoanKind"/);
        expect(sql).toMatch(/ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "kind"/);
        expect(sql).toMatch(/DEFAULT 'LOAN'/);
        expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    });
});

// ── 3. service ──────────────────────────────────────────────────────────────
const created = [];
const findManyCalls = [];
const countCalls = [];
const aggregateCalls = [];

const prismaMock = {
    loan: {
        create: jest.fn(async ({ data }) => { created.push(data); return { id: created.length, ...data }; }),
        findMany: jest.fn(async ({ where }) => { findManyCalls.push(where); return []; }),
        findFirst: jest.fn(async ({ where }) => ({ id: 7, kind: 'ADVANCE', ...where })),
        count: jest.fn(async ({ where }) => { countCalls.push(where); return 0; }),
        aggregate: jest.fn(async ({ where }) => { aggregateCalls.push(where); return { _sum: {} }; }),
    },
    loanRepayment: { create: jest.fn() },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
};

jest.unstable_mockModule('../../src/config/prisma.js', () => ({ default: prismaMock }));

const loanService = await import('../../src/services/loan.service.js');

const TENANT = 'a3f1c2d4-0000-4000-8000-000000000001';
const base = { employeeId: 5, principalMinor: 500000, tenureMonths: 1, tenantId: TENANT };

beforeEach(() => {
    jest.clearAllMocks();
    created.length = 0; findManyCalls.length = 0; countCalls.length = 0; aggregateCalls.length = 0;
});

describe('HR-PAYROLL-ADVANCE-01 loan.service', () => {
    it('defaults kind to LOAN when the caller says nothing', async () => {
        await loanService.createLoan({ ...base, tenureMonths: 12 });
        expect(created[0].kind).toBe('LOAN');
    });

    it('stores an explicit ADVANCE', async () => {
        await loanService.createLoan({ ...base, kind: 'ADVANCE' });
        expect(created[0].kind).toBe('ADVANCE');
    });

    it('rejects an unknown kind instead of writing it to the column', async () => {
        await expect(loanService.createLoan({ ...base, kind: 'SALARY_ADVANCE' }))
            .rejects.toThrow(/kind/i);
    });

    it('refuses to charge interest on an advance', async () => {
        await expect(loanService.createLoan({ ...base, kind: 'ADVANCE', interestRatePct: 5 }))
            .rejects.toThrow(/interest/i);
    });

    it('lists advances separately via a kind filter', async () => {
        await loanService.listLoans({ kind: 'ADVANCE', tenantId: TENANT });
        expect(findManyCalls[0]).toMatchObject({ kind: 'ADVANCE', tenantId: TENANT });
    });

    it('does not constrain kind when no filter is given', async () => {
        await loanService.listLoans({ tenantId: TENANT });
        expect(findManyCalls[0].kind).toBeUndefined();
    });

    it('does not count an advance as a loan on the KPI tile', async () => {
        const kpis = await loanService.getLoanKpis(TENANT);
        // every loan-side aggregate is narrowed to kind LOAN…
        expect(countCalls.filter((w) => w.kind === 'LOAN').length).toBeGreaterThan(0);
        expect(aggregateCalls.every((w) => w.kind === 'LOAN' || w.kind === 'ADVANCE')).toBe(true);
        // …and advances get their own counters rather than vanishing.
        expect(kpis).toHaveProperty('activeAdvances');
        expect(kpis).toHaveProperty('advancesOutstanding');
        expect(countCalls.some((w) => w.kind === 'ADVANCE')).toBe(true);
    });
});

// ── 4. MCP tools ────────────────────────────────────────────────────────────
const ctx = { user: { tenantId: TENANT, isAdmin: false, employeeId: 9 }, permissions: [] };
const assertPermissionMock = jest.fn();

jest.unstable_mockModule('../../src/mcp/context.js', () => ({ mcpCtx: { getStore: () => ctx } }));
jest.unstable_mockModule('../../src/mcp/utils/assertPermission.js', () => ({ assertPermission: assertPermissionMock }));
jest.unstable_mockModule('../../src/mcp/utils/toolError.js', () => ({ withToolError: (fn) => fn }));

const { registerLoanTools } = await import('../../src/mcp/tools/loanTools.js');

function makeServer() {
    const tools = new Map();
    return { tools, tool: (name, description, schema_, handler) => tools.set(name, { description, schema: schema_, handler }) };
}

describe('HR-PAYROLL-ADVANCE-01 MCP facade', () => {
    let server;
    beforeEach(() => { server = makeServer(); registerLoanTools(server); });

    it('threads kind through hr_loan_create', async () => {
        const tool = server.tools.get('hr_loan_create');
        expect(tool.schema.kind).toBeDefined();
        expect(tool.schema.kind.safeParse('ADVANCE').success).toBe(true);
        expect(tool.schema.kind.safeParse('NOPE').success).toBe(false);
        expect(tool.schema.kind.safeParse(undefined).success).toBe(true); // optional

        await tool.handler({ employeeId: '5', principalMinor: 500000, tenureMonths: 1, kind: 'ADVANCE' });
        expect(created[0].kind).toBe('ADVANCE');
    });

    it('lets hr_loan_list filter to advances only', async () => {
        const tool = server.tools.get('hr_loan_list');
        expect(tool.schema.kind).toBeDefined();
        expect(tool.schema.kind.safeParse('LOAN').success).toBe(true);

        await tool.handler({ kind: 'ADVANCE' });
        expect(findManyCalls[0]).toMatchObject({ kind: 'ADVANCE' });
    });

    it('gates every tool on HTTP methods, never action names', async () => {
        await server.tools.get('hr_loan_list').handler({});
        await server.tools.get('hr_loan_create').handler({ employeeId: '5', principalMinor: 100, tenureMonths: 1 });
        for (const [, method] of assertPermissionMock.mock.calls.map((c) => [c[0], c[1]])) {
            expect(['GET', 'POST', 'PUT', 'DELETE']).toContain(method);
        }
        expect(assertPermissionMock).toHaveBeenCalledWith(expect.anything(), 'POST', 'hr:loans', false);
    });
});
