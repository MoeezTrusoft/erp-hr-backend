import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";

const prisma = new PrismaClient();

export const createHoliday = async (data) => {
  const { name, date, description } = data;
  if (!name || !date) throw new Error("Name and date are required");

  const holiday =  await prisma.holiday.create({
    data: { name, date: new Date(date), description },
  });

  // Log the update action  
  await logAction({
    employeeId: 1,
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Holiday",
    result: "SUCCESS",
    notes: `Holiday "${1}" Created successfully`,
  });

  return holiday;
};

export const getAllHolidays = async () => {
  return prisma.holiday.findMany({
    orderBy: { date: "asc" },
  });
};

export const getHolidayById = async (id) => {
  const holiday = await prisma.holiday.findUnique({ where: { id: Number(id) } });
  if (!holiday) throw new Error("Holiday not found");
  return holiday;
};

export const updateHoliday = async (id, data) => {
  const existing = await prisma.holiday.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Holiday not found");

  const updateHoliday= await prisma.holiday.update({
    where: { id: Number(id) },
    data: {
      name: data.name ?? existing.name,
      date: data.date ? new Date(data.date) : existing.date,
      description: data.description ?? existing.description,
    },
  });
    await logAction({
    employeeId: 1,
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Holidy",
    result: "SUCCESS",
    notes: `Holiday"${1}" Updated successfully`,
  });


  return updateHoliday
};

export const deleteHoliday = async (id) => {
  const existing = await prisma.holiday.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Holiday not found");

  const deleted = await prisma.holiday.delete({ where: { id: Number(id) } });
  
    await logAction({
    employeeId: 1,
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Holiday",
    result: "SUCCESS",
    notes: `Holiday"${id}" Deleted successfully`,
  });


  return deleted;
};
