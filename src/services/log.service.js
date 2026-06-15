import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";

export const getAllLogs = async (userId, ip) => {
  const logs = await prisma.log.findMany({
    include: {
      user: true,
      action_by: true,
    },
    orderBy: { created_at: "desc" },
  });

  await logAction({
    userId,
    type: "READ_ALL",
    module: "Log",
    result: "Success",
    notes: "Fetched all logs",
    ip,
  });

  return logs;

};

export const getLogById = async (id, userId, ip) => {
  const log = await prisma.log.findUnique({
    where: { id: parseInt(id) },
    include: {
      user: true,
      action_by: true,
    },
  });

  if (!log) {

    await logAction({
      userId,
      type: "READ_ONE",
      module: "Log",
      result: "Fail",
      notes: `Log ID ${id} not found`,
      ip
    });
    throw new Error("Log not found");
  }

  await logAction({
    userId,
    type: "READ_ONE",
    module: "Log",
    result: "Success",
    notes: `Fetched log ID ${id}`,
    ip,
  });

  return log;
};
