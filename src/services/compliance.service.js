import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";

export const createChecklist = async ({ name, description, applicableTo, departmentId, positionId, createdById }) => {
  return prisma.complianceChecklist.create({
    data: {
      name,
      description,
      applicableTo: applicableTo || "ALL",
      departmentId: departmentId ? Number(departmentId) : null,
      positionId: positionId ? Number(positionId) : null,
      createdById: createdById ? Number(createdById) : null,
    },
  });
};

export const listChecklists = async () => {
  return prisma.complianceChecklist.findMany({ orderBy: { created_at: "desc" }, include: { items: true } });
};

export const addChecklistItem = async ({ checklistId, employeeId, title, description, dueDate }) => {
  return prisma.complianceItem.create({
    data: {
      checklistId: Number(checklistId),
      employeeId: employeeId ? Number(employeeId) : null,
      title,
      description,
      dueDate: dueDate ? new Date(dueDate) : null,
    },
  });
};

export const listChecklistItems = async (checklistId) => {
  return prisma.complianceItem.findMany({ where: { checklistId: Number(checklistId) }, orderBy: { created_at: "desc" } });
};

export const updateItem = async (id, data) => {
  const payload = { ...data };
  if (data.status === "COMPLETED") payload.completedAt = new Date();
  return prisma.complianceItem.update({ where: { id: Number(id) }, data: payload });
};

export const uploadEvidence = async (id, file) => {
  const uploaded = await uploadFileToDAM(file, "document");
  if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
  return prisma.complianceItem.update({
    where: { id: Number(id) },
    data: { evidenceMediaId: uploaded[0].id },
  });
};
