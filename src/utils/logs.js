import prisma from "../lib/prisma.js";
import os from "os";
import logger from "../lib/logger.js";
import { currentCorrelationId } from "../lib/requestContext.js";


const toIntOrNull = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : null;
};

export const logAction = async ({
    employeeId,
    actionById,
    type,
    actionType,
    module,
    result,
    notes = "",
    ip = "unknown",
    tenantId = null,
    // NFR-03 — callers may pass the id explicitly (background jobs); every HTTP
    // request supplies it automatically through the AsyncLocalStorage binding
    // the correlationId middleware sets up.
    correlationId = null,
}) => {
    const effectiveCorrelationId = correlationId ?? currentCorrelationId() ?? null;
    try {
        const os_name = os.platform();
        // F-07: both columns reference Employee.id. RBAC User.id is a distinct
        // namespace and must never be substituted into either foreign key.
        const requestedEmployeeId = toIntOrNull(employeeId);
        const requestedActionById = toIntOrNull(actionById ?? employeeId);

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
                tenantId: tenantId ?? null,
                correlationId: effectiveCorrelationId,
            },
        });
    } catch (err) {
        logger.error({ err }, "Audit logAction failed");
    }
};
