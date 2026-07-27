import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing `tenantId`;
// audit-log reads are tenant-scoped fail-closed so one tenant never reads
// another tenant's audit trail.

export const getAllLogs = async (employeeId, ip, tenantId) => {
  const logs = await prisma.log.findMany({
    where: scopedWhere(tenantId, {}),
    include: {
      user: true,
      action_by: true,
    },
    orderBy: { created_at: "desc" },
  });

  await logAction({
    employeeId,
    type: "READ_ALL",
    module: "Log",
    result: "Success",
    notes: "Fetched all logs",
    ip,
  });

  return logs;

};

export const getLogById = async (id, employeeId, ip, tenantId) => {
  const log = await prisma.log.findFirst({
    where: scopedWhere(tenantId, { id: parseInt(id) }),
    include: {
      user: true,
      action_by: true,
    },
  });

  if (!log) {

    await logAction({
      employeeId,
      type: "READ_ONE",
      module: "Log",
      result: "Fail",
      notes: `Log ID ${id} not found`,
      ip
    });
    throw new Error("Log not found");
  }

  await logAction({
    employeeId,
    type: "READ_ONE",
    module: "Log",
    result: "Success",
    notes: `Fetched log ID ${id}`,
    ip,
  });

  return log;
};
