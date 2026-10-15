// src/services/hr-directory.service.js: cross-module HR directory lookups
// (contracts 0.15.0 @trusoft/contracts/mcp/hr).
//
//   hr_identity_resolve    exactly one of {employeeId, employeeCode, userId}
//                          -> {employeeId, employeeCode, userId|null,
//                              managerEmployeeId|null}
//   hr_skill_holders_list  {skill, minLevel?, verifiedOnly?, limit<=100}
//                          -> {items:[{employeeId, employeeCode, userId|null,
//                              skillId, score|null, level|null, verified, ...}]}
//
// IDENTITY: HR employee ids and RBAC user ids are different integer domains.
// These lookups map between them through Employee.userId; nothing is cast.
// Input is parsed with the contracts schemas as-is: integers must already be
// integers (no Number() coercion, so a UUID or "12abc" is rejected, never
// truncated into some other employee's id).
//
// Tenancy: every query runs inside tenantTransaction (FORCE RLS GUC) AND
// filters on the verified caller tenant explicitly.
import {
    HrIdentityResolveInput,
    HrIdentityResolveOutput,
    HrSkillHoldersListInput,
    HrSkillHoldersListOutput,
    HR_SKILL_LEVELS,
} from '@trusoft/contracts/mcp/hr';

import defaultPrisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { HR_ERRORS } from '../constants/errorCodes.js';
import { AppError } from '../utils/AppError.js';

export const SKILL_HOLDERS_DEFAULT_LIMIT = 50;
const MAX_ALIAS_HOPS = 20;
// Same score bands the resume parser uses to derive a level label
// (resumeParsing.service.js normLevel): rows with a score but no label are
// compared on these thresholds.
const LEVEL_MIN_SCORE = Object.freeze({ Beginner: 0, Intermediate: 40, Advanced: 65, Expert: 85 });
const INACTIVE_RE = /inactive|terminated|exited|offboard|separated|suspended/i;

function invalid(error) {
    return AppError.from(HR_ERRORS.VALIDATION, {
        details: error.issues.map((i) => ({
            path: Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''),
            code: i.code,
            message: i.message,
        })),
    });
}

function parseInput(schema, raw) {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw invalid(parsed.error);
    return parsed.data;
}

const positiveOrNull = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);

export function isActiveEmployee(e, now = new Date()) {
    if (INACTIVE_RE.test(`${e?.status ?? ''} ${e?.employement_status ?? ''}`)) return false;
    return !(e?.separatedAt && new Date(e.separatedAt) <= now);
}

function displayName(e) {
    const name = e?.employee_name || [e?.first_name, e?.last_name].filter(Boolean).join(' ').trim();
    return name ? name.slice(0, 200) : null;
}

const EMPLOYEE_SELECT = {
    id: true,
    tenant_id: true,
    employee_code: true,
    userId: true,
    managerId: true,
    status: true,
    employement_status: true,
    separatedAt: true,
};

// Follow employee-code aliases (re-coded employees) to the current code.
async function currentEmployeeCode(tx, tenantId, code) {
    const seen = new Set();
    let current = code;
    while (!seen.has(current) && seen.size < MAX_ALIAS_HOPS) {
        seen.add(current);
        const alias = await tx.employeeCodeAlias.findFirst({
            where: { tenantId, employeeCode: current },
            select: { newCode: true },
        });
        if (!alias?.newCode) return current;
        current = alias.newCode;
    }
    throw AppError.conflict('Employee code alias chain requires HR review');
}

async function managerInTenant(tx, tenantId, managerId) {
    const id = positiveOrNull(managerId);
    if (!id) return null;
    const manager = await tx.employee.findFirst({
        where: { id, tenant_id: tenantId },
        select: { id: true },
    });
    return manager ? manager.id : null;
}

/**
 * hr_identity_resolve. Throws AppError HR-1000 (bad input), HR-4040 (no such
 * employee in this tenant) or HR-4090 (userId linked to several active
 * employees).
 */
export async function resolveEmployeeIdentity(raw, { tenantId, prisma = defaultPrisma } = {}) {
    const input = parseInput(HrIdentityResolveInput, raw);
    if (!tenantId) throw AppError.from(HR_ERRORS.UNAUTHORIZED);

    return tenantTransaction(prisma, async (tx) => {
        let employee = null;
        if (input.employeeId !== undefined) {
            employee = await tx.employee.findFirst({
                where: { id: input.employeeId, tenant_id: tenantId },
                select: EMPLOYEE_SELECT,
            });
        } else if (input.employeeCode !== undefined) {
            const code = await currentEmployeeCode(tx, tenantId, input.employeeCode);
            employee = await tx.employee.findFirst({
                where: { tenant_id: tenantId, employee_code: code },
                select: EMPLOYEE_SELECT,
            });
        } else {
            const linked = await tx.employee.findMany({
                where: { tenant_id: tenantId, userId: input.userId },
                select: EMPLOYEE_SELECT,
                orderBy: { id: 'asc' },
                take: 10,
            });
            const candidates = linked.length > 1 ? linked.filter((e) => isActiveEmployee(e)) : linked;
            if (candidates.length > 1) {
                throw AppError.conflict('User account is linked to more than one active employee');
            }
            employee = candidates[0] ?? null;
        }
        if (!employee || !employee.employee_code) throw AppError.notFound('Employee not found');

        return HrIdentityResolveOutput.parse({
            employeeId: employee.id,
            employeeCode: employee.employee_code,
            userId: positiveOrNull(employee.userId),
            managerEmployeeId: await managerInTenant(tx, tenantId, employee.managerId),
        });
    }, { tenantId });
}

async function findSkill(tx, tenantId, skill) {
    if (typeof skill === 'number') {
        return tx.skill.findFirst({ where: { id: skill, tenantId }, select: { id: true, name: true } });
    }
    const exact = await tx.skill.findFirst({ where: { tenantId, name: skill }, select: { id: true, name: true } });
    if (exact) return exact;
    const loose = await tx.skill.findMany({
        where: { tenantId, name: { equals: skill, mode: 'insensitive' } },
        select: { id: true, name: true },
        take: 2,
    });
    if (loose.length > 1) throw AppError.conflict('Skill name is ambiguous; pass the skill id');
    return loose[0] ?? null;
}

function levelFilter(minLevel) {
    if (minLevel === undefined) return null;
    if (typeof minLevel === 'number') return { score: { gte: minLevel } };
    const rank = HR_SKILL_LEVELS.indexOf(minLevel);
    const labels = HR_SKILL_LEVELS.slice(rank);
    const labelMatch = (field) => labels.map((label) => ({ [field]: { equals: label, mode: 'insensitive' } }));
    return {
        OR: [
            ...labelMatch('level'),
            { level: null, score: { gte: LEVEL_MIN_SCORE[minLevel] } },
            { level: null, score: null, OR: labelMatch('proficiency') },
        ],
    };
}

/**
 * hr_skill_holders_list. Verified holders first, then by score (highest
 * first, unscored last), then employee id. Throws HR-1000 / HR-4040 / HR-4090.
 */
export async function listSkillHolders(raw, { tenantId, prisma = defaultPrisma } = {}) {
    const input = parseInput(HrSkillHoldersListInput, raw);
    if (!tenantId) throw AppError.from(HR_ERRORS.UNAUTHORIZED);
    const take = input.limit ?? SKILL_HOLDERS_DEFAULT_LIMIT;

    return tenantTransaction(prisma, async (tx) => {
        const skill = await findSkill(tx, tenantId, input.skill);
        if (!skill) throw AppError.notFound('Skill not found');

        const filters = [
            { tenantId, skillId: skill.id, employee: { tenant_id: tenantId } },
        ];
        if (input.verifiedOnly) filters.push({ verified: true });
        const level = levelFilter(input.minLevel);
        if (level) filters.push(level);

        const rows = await tx.employeeSkill.findMany({
            where: { AND: filters },
            select: {
                skillId: true,
                score: true,
                level: true,
                proficiency: true,
                verified: true,
                employee: {
                    select: {
                        ...EMPLOYEE_SELECT,
                        employee_name: true,
                        first_name: true,
                        last_name: true,
                    },
                },
            },
            orderBy: [
                { verified: 'desc' },
                { score: { sort: 'desc', nulls: 'last' } },
                { employeeId: 'asc' },
            ],
            take,
        });

        const now = new Date();
        return HrSkillHoldersListOutput.parse({
            skill: { id: skill.id, name: skill.name },
            items: rows
                .filter((r) => r.employee?.employee_code)
                .map((r) => ({
                    employeeId: r.employee.id,
                    employeeCode: r.employee.employee_code,
                    userId: positiveOrNull(r.employee.userId),
                    name: displayName(r.employee),
                    active: isActiveEmployee(r.employee, now),
                    skillId: r.skillId,
                    score: Number.isInteger(r.score) && r.score >= 0 && r.score <= 100 ? r.score : null,
                    level: (r.level ?? r.proficiency ?? null)?.slice(0, 40) ?? null,
                    verified: r.verified === true,
                })),
        });
    }, { tenantId });
}
