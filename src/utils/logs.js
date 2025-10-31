import { PrismaClient } from "@prisma/client";
import os from "os";

const prisma = new PrismaClient();

export const logAction = async ({
   employeeId,
    type,
    module,
    result,
    notes = "",
    ip = "unknown"
}) => {
    try {
        const os_name = os.platform();

        await prisma.log.create({
            data: {
                employeeId,
                actionById: employeeId,
                type,
                action_type: type,
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
