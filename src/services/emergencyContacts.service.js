import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId` (in the
// create payload, or a trailing read/update/delete param); folded into emergency
// contact reads + stamped on creates, fail-closed so tenant B never reads or
// mutates tenant A's emergency contacts. The parent Employee is re-checked in
// the tenant via its snake_case `tenant_id` column (REQ-007).

export const createEmergencyContact = async (data, createdBy) => {

    const { tenantId } = data;
    const existing_employee = await prisma.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { id: Number(data.employee_Id) }) });
    if (!existing_employee) throw new Error(`Employee not Found "${ Number(data.employee_Id)}"`);

    const { tenantId: _t, ...rest } = data;
    const create = await prisma.emergencyContacts.create({
        data: scopedData(tenantId, {
            ...rest,
            employee_Id: Number(data.employee_Id),
        }),
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

export const getAllEmergencyContacts = async (tenantId) => {
    return prisma.emergencyContacts.findMany({
        where: scopedWhere(tenantId, {}),
        include: {
            employee: true,
        },
    });
};

export const getEmergencyContactById = async (id, tenantId) => {
    return prisma.emergencyContacts.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: {
            employee: true,
        },
    });
};

export const updateEmergencyContact = async (id, data, updatedBy, tenantId) => {
    const existing = await prisma.emergencyContacts.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
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
        notes: `Position "${id}" created successfully`,
    });
    return update;
};

export const deleteEmergencyContact = async (id, deletedBy, tenantId) => {
    const existing = await prisma.emergencyContacts.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error(`Emergency Contact not Found "${id}"`);
    const deleted = prisma.emergencyContacts.delete({
        where: { id: Number(id) },
    });


    await logAction({
        employeeId: deletedBy, // 👈 correct field name that matches the Log model
        type: "CREATE",
        module: "Position",
        result: "SUCCESS",
        notes: `Position "${id}" created successfully`,
    });
    return deleted;
};
