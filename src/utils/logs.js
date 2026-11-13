import prisma from "../lib/prisma.js";
import os from "os";
import logger from "../lib/logger.js";
import { mcpCtx } from "../lib/requestContext.js";


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asTenant = (v) => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : null);

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
}) => {
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

        let actorTenant = null;
        if (requestedActionById) {
            const exists = await prisma.employee.findUnique({
                where: { id: requestedActionById },
                select: { id: true, tenant_id: true },
            });
            validActionById = exists?.id || null;
            actorTenant = exists?.tenant_id || null;
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
                // The log table rejects a null company. Callers that omit it (111 sites) get the verified company of the
                // current request or script context; only then the actor's own company. The caller's value always wins.
                tenantId: asTenant(tenantId) ?? asTenant(mcpCtx.getStore()?.user?.tenantId) ?? asTenant(actorTenant) ?? null,
            },
        });
    } catch (err) {
        logger.error({ err }, "Audit logAction failed");
    }
};
