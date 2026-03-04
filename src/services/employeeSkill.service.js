import prisma from "../config/prisma.js";

// Skill catalog
export const listSkills = async () => prisma.skill.findMany({ orderBy: { name: "asc" } });

export const createSkill = async ({ name, category }) => {
    return prisma.skill.create({ data: { name, category } });
};

// Employee skills
export const getEmployeeSkills = async (employeeId) => {
    return prisma.employeeSkill.findMany({
        where: { employeeId: Number(employeeId) },
        include: { skill: true },
    });
};

export const addEmployeeSkill = async ({ employeeId, skillId, proficiency, verified }) => {
    return prisma.employeeSkill.upsert({
        where: { employeeId_skillId: { employeeId: Number(employeeId), skillId: Number(skillId) } },
        update: { proficiency, verified: verified ?? false },
        create: { employeeId: Number(employeeId), skillId: Number(skillId), proficiency, verified: verified ?? false },
        include: { skill: true },
    });
};

export const removeEmployeeSkill = async (id) => {
    return prisma.employeeSkill.delete({ where: { id: Number(id) } });
};
