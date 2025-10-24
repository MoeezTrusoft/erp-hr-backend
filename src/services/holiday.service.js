import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export const createHoliday = async (data) => {
  const { name, date, description } = data;
  if (!name || !date) throw new Error("Name and date are required");

  return prisma.holiday.create({
    data: { name, date: new Date(date), description },
  });
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

  return prisma.holiday.update({
    where: { id: Number(id) },
    data: {
      name: data.name ?? existing.name,
      date: data.date ? new Date(data.date) : existing.date,
      description: data.description ?? existing.description,
    },
  });
};

export const deleteHoliday = async (id) => {
  const existing = await prisma.holiday.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error("Holiday not found");

  await prisma.holiday.delete({ where: { id: Number(id) } });
  return { message: "Holiday deleted successfully" };
};
