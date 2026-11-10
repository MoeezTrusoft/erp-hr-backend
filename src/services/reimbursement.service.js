import { legacyDecision, legacySubmit } from "./approval/legacy.js";
import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { checkClaim, defaultClaimCurrency } from "./claims.service.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId` (in the
// create payload, or a trailing read/update param); folded into claim reads +
// stamped on creates, fail-closed so tenant B never reads or mutates tenant A's
// reimbursement claims. (Does not touch the payroll engine / C4 surface.)

export const createClaim = async ({ employeeId, title, description, amount, currency, category, notes, tenantId }) => {
  // The same checks and the same currency default as the claims screen: whole amounts, an active employee of this
  // company, and the currency the employee is paid in, never a hard-coded dollar.
  return tenantTransaction(prisma, async (tx) => {
    const claimCurrency = currency ? String(currency).toUpperCase() : await defaultClaimCurrency(tx, employeeId);
    await checkClaim(tx, { tenantId, employeeId, title: title || description, amount, currency: claimCurrency });
    return tx.reimbursementClaim.create({
      data: scopedData(tenantId, {
        employeeId: Number(employeeId),
        // The tool sends `description`; ReimbursementClaim.title is the NOT NULL column.
        title: String(title || description).trim(),
        amount: Number(amount),
        currency: claimCurrency,
        category,
        notes,
      }),
    });
  }, { tenantId });
};

export const listClaims = async ({ employeeId, status, tenantId } = {}) => {
  const where = scopedWhere(tenantId, {
    ...(employeeId ? { employeeId: Number(employeeId) } : {}),
    ...(status ? { status } : {}),
  });
  return prisma.reimbursementClaim.findMany({
    where,
    orderBy: { created_at: "desc" },
    include: { employee: { select: { id: true, employee_code: true } }, approvedBy: { select: { id: true, employee_code: true } } },
  });
};

export const uploadReceipt = async (id, file, tenantId) => {
  const existing = await prisma.reimbursementClaim.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Reimbursement claim not found");
  const uploaded = await uploadFileToDAM(file, "document");
  if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
  return prisma.reimbursementClaim.update({
    where: { id: Number(id) },
    data: { receiptMediaId: uploaded[0].id },
  });
};

export const submitClaim = async (id, tenantId) => {
  return legacySubmit('CLAIM',id);
};

export const approveClaim = async (id, approverId, tenantId) => {
  return legacyDecision('CLAIM',id);
};
