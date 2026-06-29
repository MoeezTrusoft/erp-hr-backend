import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId`; folded into
// skill-catalog + employee-skill reads and stamped on creates, fail-closed so
// tenant B never reads or mutates tenant A's skills.

// Skill catalog
export const listSkills = async (tenantId) => prisma.skill.findMany({ where: scopedWhere(tenantId, {}), orderBy: { name: "asc" } });

export const createSkill = async ({ name, category, tenantId }) => {
    return prisma.skill.create({ data: scopedData(tenantId, { name, category }) });
};

// Employee skills
export const getEmployeeSkills = async (employeeId, tenantId) => {
    return prisma.employeeSkill.findMany({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        include: { skill: true },
    });
};

export const addEmployeeSkill = async ({ employeeId, skillId, proficiency, verified, tenantId }) => {
    return prisma.employeeSkill.upsert({
        where: { employeeId_skillId: { employeeId: Number(employeeId), skillId: Number(skillId) } },
        update: { proficiency, verified: verified ?? false },
        create: scopedData(tenantId, { employeeId: Number(employeeId), skillId: Number(skillId), proficiency, verified: verified ?? false }),
        include: { skill: true },
    });
};

export const removeEmployeeSkill = async (id, tenantId) => {
    const existing = await prisma.employeeSkill.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Employee skill not found");
    return prisma.employeeSkill.delete({ where: { id: Number(id) } });
};
