import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";

export const createEmergencyContact = async (data, createdBy) => {


    const existing_employee = await prisma.employee.findUnique({ where: { id:  Number(data.employee_Id) } });
    if (!existing_employee) throw new Error(`Employee not Found "${ Number(data.employee_Id)}"`);

    const create = await prisma.emergencyContacts.create({
        data: {
            ...data,
            employee_Id: Number(data.employee_Id),
        },
    });
    await logAction({
        employeeId: createdBy, // 👈 correct field name that matches the Log model
        type: "CREATE",
        module: "Position",
        result: "SUCCESS",
        notes: `Emergency Contact "${create.id}" with  employee of "${ Number(data.employee_Id)}"created successfully`,
    });

    return create;
};

export const getAllEmergencyContacts = async () => {
    return prisma.emergencyContacts.findMany({
        include: {
            employee: true,
        },
    });
};

export const getEmergencyContactById = async (id) => {
    return prisma.emergencyContacts.findUnique({
        where: { id: Number(id) },
        include: {
            employee: true,
        },
    });
};

export const updateEmergencyContact = async (id, data, updatedBy) => {
    const existing = await prisma.emergencyContacts.findUnique({ where: { id: id } });
    if (!existing) throw new Error(`Emergency Contact not Found "${id}"`);
    const update = prisma.emergencyContacts.update({
        where: { id: Number(id) },
        data,
    });
    await logAction({
        employeeId: updatedBy, // 👈 correct field name that matches the Log model
        type: "CREATE",
        module: "Position",
        result: "SUCCESS",
        notes: `Position "${title}" created successfully`,
    });
    return update;
};

export const deleteEmergencyContact = async (id, deletedBy) => {
    const existing = await prisma.emergencyContacts.findUnique({ where: { id: id } });
    if (!existing) throw new Error(`Emergency Contact not Found "${id}"`);
    const deleted = prisma.emergencyContacts.delete({
        where: { id: Number(id) },
    });


    await logAction({
        employeeId: deletedBy, // 👈 correct field name that matches the Log model
        type: "CREATE",
        module: "Position",
        result: "SUCCESS",
        notes: `Position "${title}" created successfully`,
    });
    return deleted;
};
