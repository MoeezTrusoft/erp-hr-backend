// tests/unit/mcp/hr-directory.tools.test.js
//
// hr_identity_resolve + hr_skill_holders_list (contracts 0.15.0 mcp/hr):
//   * registered with the contracts names/descriptions, read-only annotations,
//   * gated on hr.employee.read (dotted scope) / hr:employee VIEW (legacy blob),
//     which is the permission contracts HR_PERMISSION_MAP declares,
//   * strict input: exactly one identity key, integers must be integers (no
//     Number() casting of UUIDs or numeric strings), limit <= 100,
//   * every query is tenant scoped; a manager in another tenant is not leaked,
//   * skill lookups use the (tenantId, skillId) index columns + level filters.
// DB-free: a fake prisma records the queries. The PostgreSQL behaviour is
// covered by tests/availability/availability.postgres.test.mjs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { HR_PERMISSION_MAP, HR_TOOLS } from '@trusoft/contracts/mcp/hr';

import { registerHrDirectoryTools } from '../../../src/mcp/tools/hrDirectoryTools.js';
import { resolveEmployeeIdentity, listSkillHolders } from '../../../src/services/hr-directory.service.js';
import { mcpCtx } from '../../../src/mcp/context.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function makePrisma({ employees = [], aliases = [], skills = [], employeeSkills = [] } = {}) {
    const calls = { employee: [], skill: [], employeeSkill: [], gucs: [] };
    const matches = (row, where) => Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && 'equals' in v) return String(row[k]).toLowerCase() === String(v.equals).toLowerCase();
        return row[k] === v;
    });
    const tx = {
        $executeRaw: (strings, ...values) => { calls.gucs.push(values); return Promise.resolve(1); },
        employee: {
            findFirst: jest.fn(async ({ where }) => { calls.employee.push(where); return employees.find((e) => matches(e, where)) ?? null; }),
            findMany: jest.fn(async ({ where, take }) => { calls.employee.push(where); return employees.filter((e) => matches(e, where)).slice(0, take); }),
        },
        employeeCodeAlias: {
            findFirst: jest.fn(async ({ where }) => aliases.find((a) => matches(a, where)) ?? null),
        },
        skill: {
            findFirst: jest.fn(async ({ where }) => { calls.skill.push(where); return skills.find((s) => matches(s, where)) ?? null; }),
            findMany: jest.fn(async ({ where, take }) => { calls.skill.push(where); return skills.filter((s) => matches(s, where)).slice(0, take); }),
        },
        employeeSkill: {
            findMany: jest.fn(async (args) => { calls.employeeSkill.push(args); return employeeSkills; }),
        },
    };
    return { calls, tx, $transaction: async (fn) => fn(tx) };
}

const EMP = {
    id: 7, tenant_id: TENANT, employee_code: 'EMP-0007', userId: 42, managerId: 3,
    status: 'Active', employement_status: 'Active', separatedAt: null,
};
const MANAGER = { ...EMP, id: 3, employee_code: 'EMP-0003', userId: 9, managerId: null };

describe('resolveEmployeeIdentity', () => {
    it('resolves by employeeId within the tenant, including the manager', async () => {
        const prisma = makePrisma({ employees: [EMP, MANAGER] });
        const out = await resolveEmployeeIdentity({ employeeId: 7 }, { tenantId: TENANT, prisma });
        expect(out).toEqual({ employeeId: 7, employeeCode: 'EMP-0007', userId: 42, managerEmployeeId: 3 });
        expect(prisma.calls.employee.every((w) => w.tenant_id === TENANT)).toBe(true);
        expect(prisma.calls.gucs[0]).toEqual([TENANT]);
    });

    it('resolves by RBAC userId and follows employee-code aliases', async () => {
        const prisma = makePrisma({
            employees: [EMP, MANAGER],
            aliases: [{ tenantId: TENANT, employeeCode: 'OLD-7', newCode: 'EMP-0007' }],
        });
        await expect(resolveEmployeeIdentity({ userId: 42 }, { tenantId: TENANT, prisma }))
            .resolves.toMatchObject({ employeeId: 7 });
        await expect(resolveEmployeeIdentity({ employeeCode: 'OLD-7' }, { tenantId: TENANT, prisma }))
            .resolves.toMatchObject({ employeeId: 7, employeeCode: 'EMP-0007' });
    });

    it('never leaks a manager from another tenant and maps userId 0/null to null', async () => {
        const prisma = makePrisma({
            employees: [{ ...EMP, userId: 0, managerId: 3 }, { ...MANAGER, tenant_id: OTHER }],
        });
        const out = await resolveEmployeeIdentity({ employeeId: 7 }, { tenantId: TENANT, prisma });
        expect(out).toEqual({ employeeId: 7, employeeCode: 'EMP-0007', userId: null, managerEmployeeId: null });
    });

    it('returns 404 for an employee of another tenant (cross-tenant probe)', async () => {
        const prisma = makePrisma({ employees: [{ ...EMP, tenant_id: OTHER }] });
        await expect(resolveEmployeeIdentity({ employeeId: 7 }, { tenantId: TENANT, prisma }))
            .rejects.toMatchObject({ httpStatus: 404, code: 'HR-4040' });
    });

    it('prefers the single active employee when a user is linked twice, else 409', async () => {
        const separated = { ...EMP, id: 8, employee_code: 'EMP-0008', employement_status: 'Separated' };
        let prisma = makePrisma({ employees: [separated, EMP] });
        await expect(resolveEmployeeIdentity({ userId: 42 }, { tenantId: TENANT, prisma }))
            .resolves.toMatchObject({ employeeId: 7 });
        prisma = makePrisma({ employees: [{ ...EMP, id: 8, employee_code: 'EMP-0008' }, EMP] });
        await expect(resolveEmployeeIdentity({ userId: 42 }, { tenantId: TENANT, prisma }))
            .rejects.toMatchObject({ httpStatus: 409, code: 'HR-4090' });
    });

    it.each([
        ['no key', {}],
        ['two keys', { employeeId: 7, userId: 42 }],
        ['numeric string employeeId (no Number() casting)', { employeeId: '7' }],
        ['uuid employeeId', { employeeId: '6f9619ff-8b86-4011-b42d-00c04fc964ff' }],
        ['non-integer userId', { userId: 4.5 }],
        ['uuid userId', { userId: '6f9619ff-8b86-4011-b42d-00c04fc964ff' }],
        ['negative userId', { userId: -1 }],
        ['unknown key', { employeeId: 7, email: 'a@b.c' }],
        ['empty employeeCode', { employeeCode: '   ' }],
    ])('rejects %s with HR-1000 before any query', async (_label, input) => {
        const prisma = makePrisma({ employees: [EMP] });
        await expect(resolveEmployeeIdentity(input, { tenantId: TENANT, prisma }))
            .rejects.toMatchObject({ httpStatus: 400, code: 'HR-1000' });
        expect(prisma.calls.employee).toHaveLength(0);
    });
});

describe('listSkillHolders', () => {
    const row = (over = {}) => ({
        skillId: 5, score: 90, level: 'Expert', proficiency: null, verified: true,
        employee: { ...EMP, employee_name: 'Ayesha Khan', first_name: null, last_name: null },
        ...over,
    });

    it('queries the tenant/skill index columns, verified first then score, default limit 50', async () => {
        const prisma = makePrisma({ skills: [{ id: 5, name: 'React', tenantId: TENANT }], employeeSkills: [row()] });
        const out = await listSkillHolders({ skill: 'react' }, { tenantId: TENANT, prisma });
        const args = prisma.calls.employeeSkill[0];
        expect(args.where.AND[0]).toEqual({ tenantId: TENANT, skillId: 5, employee: { tenant_id: TENANT } });
        expect(args.orderBy).toEqual([
            { verified: 'desc' }, { score: { sort: 'desc', nulls: 'last' } }, { employeeId: 'asc' },
        ]);
        expect(args.take).toBe(50);
        expect(out.skill).toEqual({ id: 5, name: 'React' });
        expect(out.items).toEqual([{
            employeeId: 7, employeeCode: 'EMP-0007', userId: 42, name: 'Ayesha Khan', active: true,
            skillId: 5, score: 90, level: 'Expert', verified: true,
        }]);
    });

    it('applies verifiedOnly, numeric minLevel and label minLevel (with score bands)', async () => {
        const prisma = makePrisma({ skills: [{ id: 5, name: 'React', tenantId: TENANT }] });
        await listSkillHolders({ skill: 5, verifiedOnly: true, minLevel: 70, limit: 100 }, { tenantId: TENANT, prisma });
        let where = prisma.calls.employeeSkill[0].where.AND;
        expect(where).toContainEqual({ verified: true });
        expect(where).toContainEqual({ score: { gte: 70 } });
        expect(prisma.calls.skill[0]).toEqual({ id: 5, tenantId: TENANT });

        await listSkillHolders({ skill: 5, minLevel: 'Advanced' }, { tenantId: TENANT, prisma });
        where = prisma.calls.employeeSkill[1].where.AND;
        const levels = where[1].OR;
        expect(levels).toContainEqual({ level: { equals: 'Advanced', mode: 'insensitive' } });
        expect(levels).toContainEqual({ level: { equals: 'Expert', mode: 'insensitive' } });
        expect(levels).not.toContainEqual({ level: { equals: 'Intermediate', mode: 'insensitive' } });
        expect(levels).toContainEqual({ level: null, score: { gte: 65 } });
    });

    it('404s a skill outside the tenant and rejects bad input', async () => {
        const prisma = makePrisma({ skills: [{ id: 5, name: 'React', tenantId: OTHER }] });
        await expect(listSkillHolders({ skill: 5 }, { tenantId: TENANT, prisma }))
            .rejects.toMatchObject({ httpStatus: 404 });
        for (const input of [{ skill: 5, limit: 101 }, { skill: '5', limit: 0 }, { skill: 5, minLevel: 'Guru' }, {}, { skill: 5.5 }]) {
            await expect(listSkillHolders(input, { tenantId: TENANT, prisma }))
                .rejects.toMatchObject({ code: 'HR-1000' });
        }
    });

    it('reports inactive holders and falls back to the legacy proficiency label', async () => {
        const prisma = makePrisma({
            skills: [{ id: 5, name: 'React', tenantId: TENANT }],
            employeeSkills: [row({ level: null, proficiency: 'Intermediate', score: null, verified: false,
                employee: { ...EMP, employement_status: 'Separated', employee_name: null, first_name: 'Ali', last_name: 'Raza' } })],
        });
        const out = await listSkillHolders({ skill: 5 }, { tenantId: TENANT, prisma });
        expect(out.items[0]).toMatchObject({ active: false, level: 'Intermediate', score: null, verified: false, name: 'Ali Raza' });
    });
});

describe('MCP registration and permission gate', () => {
    const tools = new Map();
    registerHrDirectoryTools({ registerTool: (name, config, cb) => tools.set(name, { config, cb }) });

    const call = (name, args, permissions, tenantId = TENANT) =>
        mcpCtx.run({ user: { tenantId, isAdmin: true }, permissions }, () => tools.get(name).cb(args));
    const body = (res) => JSON.parse(res.content[0].text);

    beforeEach(() => jest.clearAllMocks());

    it('registers exactly the contracts HR tools as read-only, gated on hr.employee.read', () => {
        expect([...tools.keys()].sort()).toEqual(HR_TOOLS.map((t) => t.name).sort());
        for (const tool of HR_TOOLS) {
            expect(HR_PERMISSION_MAP[tool.name]).toBe('hr.employee.read');
            const { config } = tools.get(tool.name);
            expect(config.description).toBe(tool.description);
            expect(config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
            expect(Object.keys(config.inputSchema).sort()).toEqual(Object.keys(tool.inputSchema.properties).sort());
        }
    });

    it.each(['hr_identity_resolve', 'hr_skill_holders_list'])('%s: deny by default, forged isAdmin grants nothing', async (name) => {
        for (const permissions of [[], {}, ['hr.employee.update'], { 'hr:employee': ['EDIT'] }]) {
            const res = await call(name, name === 'hr_identity_resolve' ? { employeeId: 7 } : { skill: 5 }, permissions);
            expect(res.isError).toBe(true);
            expect(body(res).status).toBe(403);
        }
    });

    it('validation errors surface as HR-1000 through the tool envelope', async () => {
        const res = await call('hr_identity_resolve', { employeeId: '7' }, ['hr.employee.read']);
        expect(res.isError).toBe(true);
        expect(body(res).code).toBe('HR-1000');
    });
});
