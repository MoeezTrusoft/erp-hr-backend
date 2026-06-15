import prisma from "../lib/prisma.js";
import os from "os";


const toIntOrNull = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : null;
};

export const logAction = async ({
    userId,
    employeeId,
    actionById,
    type,
    actionType,
    module,
    result,
    notes = "",
    ip = "unknown"
}) => {
    try {
        const os_name = os.platform();
        const requestedEmployeeId = toIntOrNull(employeeId ?? userId);
        const requestedActionById = toIntOrNull(actionById ?? employeeId ?? userId);

        let validEmployeeId = null;
        let validActionById = null;

        if (requestedEmployeeId) {
            const exists = await prisma.employee.findUnique({
                where: { id: requestedEmployeeId },
                select: { id: true },
            });
            validEmployeeId = exists?.id || null;
        }

        if (requestedActionById) {
            const exists = await prisma.employee.findUnique({
                where: { id: requestedActionById },
                select: { id: true },
            });
            validActionById = exists?.id || null;
        }

        await prisma.log.create({
            data: {
                ...(validEmployeeId ? { employeeId: validEmployeeId } : {}),
                ...(validActionById ? { actionById: validActionById } : {}),
                type,
                action_type: actionType || type,
                module,
                result,
                ip,
                os: os_name,
                notes,
            },
        });
    } catch (err) {
        console.error("Logging failed:", err.message);
    }
};
