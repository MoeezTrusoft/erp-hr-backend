import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into compliance reads and stamped on creates, fail-closed so
// tenant B never reads/mutates tenant A's compliance checklists/items/evidence.

export const createChecklist = async ({ name, description, applicableTo, departmentId, positionId, createdById, tenantId }) => {
  return prisma.complianceChecklist.create({
    data: scopedData(tenantId, {
      name,
      description,
      applicableTo: applicableTo || "ALL",
      departmentId: departmentId ? Number(departmentId) : null,
      positionId: positionId ? Number(positionId) : null,
      createdById: createdById ? Number(createdById) : null,
    }),
  });
};

export const listChecklists = async (tenantId) => {
  return prisma.complianceChecklist.findMany({ where: scopedWhere(tenantId, {}), orderBy: { created_at: "desc" }, include: { items: true } });
};

export const addChecklistItem = async ({ checklistId, employeeId, title, description, dueDate, tenantId }) => {
  return prisma.complianceItem.create({
    data: scopedData(tenantId, {
      checklistId: Number(checklistId),
      employeeId: employeeId ? Number(employeeId) : null,
      title,
      description,
      dueDate: dueDate ? new Date(dueDate) : null,
    }),
  });
};

export const listChecklistItems = async (checklistId, tenantId) => {
  return prisma.complianceItem.findMany({ where: scopedWhere(tenantId, { checklistId: Number(checklistId) }), orderBy: { created_at: "desc" } });
};

export const updateItem = async (id, data, tenantId) => {
  const existing = await prisma.complianceItem.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Compliance item not found");
  const payload = { ...data };
  if (data.status === "COMPLETED") payload.completedAt = new Date();
  return prisma.complianceItem.update({ where: { id: Number(id) }, data: payload });
};

export const uploadEvidence = async (id, file, tenantId) => {
  const existing = await prisma.complianceItem.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Compliance item not found");
  const uploaded = await uploadFileToDAM(file, "document");
  if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
  return prisma.complianceItem.update({
    where: { id: Number(id) },
    data: { evidenceMediaId: uploaded[0].id },
  });
};
