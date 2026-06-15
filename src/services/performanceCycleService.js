import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";


export const createPerformanceCycle = async (data, createdBy) => {
  const { name, start_date, end_date , status,templateId } = data;
  console.log(data);
  
  if (!name || !start_date || !end_date || !templateId ) throw new Error("Missing required fields");

  const template = await prisma.performanceTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new Error(`Template with id ${templateId} does not exist`);
  }

  const create = await prisma.performanceCycle.create({
    data: {
         name, 
         start_date: new Date(start_date),
          end_date : new Date(end_date ), 
          status,
          createdById: Number(createdBy),
          template: {
        connect: { id: templateId }, 
      },
        },
         createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
  });
    await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance Cycle "${create.id}" Created successfully`,
  });

  return create;
};

export const getAllPerformanceCycles = async () => {
  return prisma.performanceCycle.findMany({
    include: { template: true, reviews: true },
    orderBy: { id: "desc" },
  });
};

export const getPerformanceCycleById = async (id) => {
  const cycle = await prisma.performanceCycle.findUnique({
    where: { id: Number(id) },
    include: { template: true, reviews: true },
  });
  if (!cycle) throw new Error("Performance Cycle not found");
  return cycle;
};

export const updatePerformanceCycle = async (id, data,updatedBy) => {
    const existing  = await prisma.performanceCycle.findUnique({where: {id: Number(id)}})
    if (!existing) throw new Error("Performnce cycle not found");
  const update= await prisma.performanceCycle.update({
    where: { id: Number(id) },
    data,
    updatedById: Number(updatedBy),
     updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
  });
    await logAction({
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance Cycle "${id}" Updated successfully`,
  });

  return update;
};

export const deletePerformanceCycle = async (id, deletedBy) => {
    const existing  = await prisma.performanceCycle.findUnique({where: {id: Number(id)}})
    if (!existing) throw new Error("Performnce cycle not found");
    
  const deleted = await prisma.performanceCycle.delete({
    where: { id: Number(id) },
  });

 await logAction({
    employeeId: Number(deletedBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Performance Cycle",
    result: "SUCCESS",
    notes: `Performance Cycle "${id}" Deleted successfully`,
  });

  return deleted;

};
