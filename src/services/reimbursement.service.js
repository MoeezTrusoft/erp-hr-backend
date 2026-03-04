import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";

export const createClaim = async ({ employeeId, title, amount, currency, category, notes }) => {
  return prisma.reimbursementClaim.create({
    data: {
      employeeId: Number(employeeId),
      title,
      amount: Number(amount),
      currency: currency || "USD",
      category,
      notes,
    },
  });
};

export const listClaims = async ({ employeeId, status }) => {
  const where = {
    ...(employeeId ? { employeeId: Number(employeeId) } : {}),
    ...(status ? { status } : {}),
  };
  return prisma.reimbursementClaim.findMany({
    where,
    orderBy: { created_at: "desc" },
    include: { employee: { select: { id: true, first_name: true, last_name: true } }, approvedBy: { select: { id: true, first_name: true, last_name: true } } },
  });
};

export const uploadReceipt = async (id, file) => {
  const uploaded = await uploadFileToDAM(file, "document");
  if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
  return prisma.reimbursementClaim.update({
    where: { id: Number(id) },
    data: { receiptMediaId: uploaded[0].id },
  });
};

export const submitClaim = async (id) => {
  return prisma.reimbursementClaim.update({
    where: { id: Number(id) },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
};

export const approveClaim = async (id, approverId) => {
  return prisma.reimbursementClaim.update({
    where: { id: Number(id) },
    data: { status: "APPROVED", approvedById: Number(approverId), approvedAt: new Date() },
  });
};
