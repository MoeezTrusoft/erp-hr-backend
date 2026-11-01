import { legacyWithdraw, legacyDecision, legacySubmit } from "./approval/legacy.js";
// src/services/claims.service.js — Claims & Reimbursements domain service.
//
// A NEW service (distinct from the legacy src/services/reimbursement.service.js
// which the compliance MCP tools still use). This one owns the richer claims
// surface: line items, a multi-step approval chain, request-info Q&A, KPIs, a
// filtered/paginated list, a detail "drawer", and CSV export.
//
// TENANCY: every read folds the verified tenant via scopedWhere(tenantId, …);
// Employee reads use scopedEmployeeWhere (snake_case tenant_id column). Every
// multi-write runs inside tenantTransaction(prisma, fn) so RLS tables get the
// per-tx GUC. Employee columns are snake_case (first_name / last_name /
// employee_name / photo_url / job_title / businessUnitId).
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { toCSV } from "../lib/export.util.js";
import logger from "../lib/logger.js";
import { displayName } from "../lib/personIdentity.js";
import { getCtx } from "../mcp/context.js";

// ── helpers ────────────────────────────────────────────────────────────────

const num = (v) => (v == null ? null : Number(v));

// Employee display name from the snake_case columns.
// People are shown by full name; the code is only the last fallback.
const employeeName = (e) => displayName(e) || 'Unknown employee';

// Shape an included Employee into the list/drawer employee sub-object.
const shapeEmployee = (e) =>
  e
    ? {
        id: e.id,
        employeeId: e.id,
        name: employeeName(e),
        employeeCode: e.employee_code || null,
        role: e.Position?.title || e.job_title || null,
        position: e.Position?.title || e.job_title || null,
        avatar: e.photo_url || null,
        department: e.businessUnit?.name || null,
      }
    : null;

const EMPLOYEE_SELECT = {
  id: true,
  employee_code: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  preferred_name: true,
  Position: { select: { title: true } },
  photo_url: true,
  job_title: true,
  businessUnitId: true,
  businessUnit: { select: { id: true, name: true } },
};

// Build a submittedAt/created_at date-window predicate. Applies to submittedAt
// when the claim has one, else created_at. We OR the two so a DRAFT (no
// submittedAt) is still caught by created_at.
const dateWindow = (from, to) => {
  if (!from && !to) return null;
  const range = {};
  if (from) range.gte = new Date(from);
  if (to) range.lte = new Date(to);
  return { OR: [{ submittedAt: range }, { AND: [{ submittedAt: null }, { created_at: range }] }] };
};

const CLAIM_STATUSES = ["DRAFT", "SUBMITTED", "NEEDS_INFO", "APPROVED", "REJECTED", "WITHDRAWN", "PAID"];

// ── KPIs ─────────────────────────────────────────────────────────────────────

export async function getClaimKpis({ tenantId, from, to }) {
  const win = dateWindow(from, to);
  const base = (extra) => scopedWhere(tenantId, { ...(win || {}), ...extra });

  const [pendingReview, approved, rejected, paidAgg] = await Promise.all([
    prisma.reimbursementClaim.count({ where: base({ status: { in: ["SUBMITTED", "NEEDS_INFO"] } }) }),
    prisma.reimbursementClaim.count({ where: base({ status: "APPROVED" }) }),
    prisma.reimbursementClaim.count({ where: base({ status: "REJECTED" }) }),
    prisma.reimbursementClaim.aggregate({ where: base({ status: "PAID" }), _sum: { amount: true } }),
  ]);

  return {
    pendingReview,
    approved,
    rejected,
    reimbursedAmount: paidAgg._sum.amount || 0,
  };
}

// ── list ─────────────────────────────────────────────────────────────────────

const SORT_FIELDS = { submittedAt: "submittedAt", amount: "amount", status: "status" };

export async function listClaims({
  tenantId,
  q,
  status,
  category,
  employeeId,
  from,
  to,
  sortBy,
  sortDir,
  page,
  pageSize,
} = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(200, Math.max(1, Number(pageSize) || 20));
  const win = dateWindow(from, to);

  const and = [];
  if (win) and.push(win);
  if (q) {
    and.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { employee: { employee_code: { contains: q, mode: "insensitive" } } },
        { employee: { employee_name: { contains: q, mode: "insensitive" } } },
        { employee: { first_name: { contains: q, mode: "insensitive" } } },
        { employee: { last_name: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  const where = scopedWhere(tenantId, {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(employeeId ? { employeeId: Number(employeeId) } : {}),
    ...(and.length ? { AND: and } : {}),
  });

  const orderField = SORT_FIELDS[sortBy] || "submittedAt";
  const orderDir = String(sortDir).toLowerCase() === "asc" ? "asc" : "desc";

  const [rows, total] = await Promise.all([
    prisma.reimbursementClaim.findMany({
      where,
      orderBy: { [orderField]: orderDir },
      skip: (pageNum - 1) * size,
      take: size,
      include: { employee: { select: EMPLOYEE_SELECT } },
    }),
    prisma.reimbursementClaim.count({ where }),
  ]);

  const items = rows.map((r) => ({
    claimId: r.id,
    title: r.title,
    employee: shapeEmployee(r.employee),
    category: r.category || null,
    amount: r.amount,
    submittedAt: r.submittedAt,
    status: r.status,
  }));

  return { items, total, page: pageNum, pageSize: size };
}

// ── get (drawer) ─────────────────────────────────────────────────────────────

function shapeDrawer(claim) {
  return {
    id: claim.id,
    status: claim.status,
    amount: claim.amount,
    currency: claim.currency,
    category: claim.category || null,
    submittedAt: claim.submittedAt,
    title: claim.title,
    description: claim.description || null,
    employee: shapeEmployee(claim.employee),
    items: (claim.items || []).map((it) => ({
      id: it.id,
      name: it.name,
      description: it.description || null,
      amount: it.amount,
      attachment: it.mediaId || null,
    })),
    approvalChain: (claim.approvals || []).map((a) => ({
      id: a.id,
      level: a.level,
      approver: shapeApprover(a.approver),
      status: a.status,
      comments: a.comments || null,
      decidedAt: a.decidedAt,
    })),
    infoRequests: (claim.infoRequests || []).map((r) => ({
      id: r.id,
      question: r.question,
      response: r.response || null,
      status: r.status,
      requestedAt: r.requestedAt,
      respondedAt: r.respondedAt,
    })),
  };
}

const shapeApprover = (e) =>
  e
    ? { id: e.id, name: employeeName(e),
        employeeCode: e.employee_code || null, role: e.job_title || null, avatar: e.photo_url || null }
    : null;

const DRAWER_INCLUDE = {
  employee: { select: EMPLOYEE_SELECT },
  items: { orderBy: { createdAt: "asc" } },
  approvals: {
    orderBy: { level: "asc" },
    include: {
      approver: {
        select: {
          id: true,
          employee_code: true,
          employee_name: true,
          first_name: true,
          last_name: true,
          preferred_name: true,
          photo_url: true,
          job_title: true,
        },
      },
    },
  },
  infoRequests: { orderBy: { requestedAt: "asc" } },
};

export async function getClaim({ tenantId, id }) {
  const claim = await prisma.reimbursementClaim.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: DRAWER_INCLUDE,
  });
  if (!claim) throw Object.assign(new Error("Claim not found"), { status: 404 });
  return shapeDrawer(claim);
}

// Re-read the drawer via a tx client (used after multi-writes so we return the
// canonical shape from inside the same tenant-scoped transaction).
async function readDrawer(tx, tenantId, id) {
  const claim = await tx.reimbursementClaim.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: DRAWER_INCLUDE,
  });
  if (!claim) throw Object.assign(new Error("Claim not found"), { status: 404 });
  return shapeDrawer(claim);
}

// ── create ───────────────────────────────────────────────────────────────────

export async function createClaim({ tenantId, employeeId, title, description, category, amount, currency, items }) {
  const lineItems = Array.isArray(items) ? items : [];
  const itemsSum = lineItems.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);
  const finalAmount = amount != null ? Number(amount) : lineItems.length ? itemsSum : 0;

  const result = await tenantTransaction(prisma, async (tx) => {
    // Default to the currency the employee is paid in, then the latest payroll run's, never a hard-coded dollar.
    let claimCurrency = currency;
    if (!claimCurrency) {
      const terms = await tx.employmentTerms.findFirst({
        where: { employeeId: Number(employeeId) },
        orderBy: { effectiveFrom: "desc" },
        select: { currency: true },
      });
      const lastRun = terms?.currency
        ? null
        : await tx.payrollRun.findFirst({ orderBy: { id: "desc" }, select: { currencyCode: true } });
      claimCurrency = terms?.currency || lastRun?.currencyCode || "USD";
    }
    const claim = await tx.reimbursementClaim.create({
      data: {
        employeeId: Number(employeeId),
        title,
        description: description ?? null,
        category: category ?? null,
        amount: finalAmount,
        currency: claimCurrency,
        status: "DRAFT",
        tenantId: tenantId ?? null,
      },
    });

    for (const it of lineItems) {
      await tx.claimItem.create({
        data: {
          claimId: claim.id,
          name: it.name,
          description: it.description ?? null,
          amount: Number(it.amount) || 0,
          mediaId: it.mediaId != null ? Number(it.mediaId) : null,
          tenantId: tenantId ?? null,
        },
      });
    }

    return readDrawer(tx, tenantId, claim.id);
  });

  logger.info({ claimId: result.id, tenantId }, "claim created");
  return result;
}

// ── update ───────────────────────────────────────────────────────────────────

const EDITABLE_FIELDS = ["title", "description", "category", "amount", "currency"];

export async function updateClaim({ tenantId, id, items, ...fields }) {
  return tenantTransaction(prisma, async (tx) => {
    const existing = await tx.reimbursementClaim.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw Object.assign(new Error("Claim not found"), { status: 404 });
    if (!["DRAFT", "NEEDS_INFO"].includes(existing.status)) {
      throw Object.assign(new Error(`Claim can only be edited while DRAFT or NEEDS_INFO (is ${existing.status})`), {
        status: 409,
      });
    }

    const data = {};
    for (const key of EDITABLE_FIELDS) {
      if (fields[key] !== undefined) data[key] = key === "amount" ? Number(fields[key]) : fields[key];
    }

    if (Array.isArray(items)) {
      await tx.claimItem.deleteMany({ where: scopedWhere(tenantId, { claimId: Number(id) }) });
      for (const it of items) {
        await tx.claimItem.create({
          data: {
            claimId: Number(id),
            name: it.name,
            description: it.description ?? null,
            amount: Number(it.amount) || 0,
            mediaId: it.mediaId != null ? Number(it.mediaId) : null,
            tenantId: tenantId ?? null,
          },
        });
      }
      // If the caller replaced items and didn't set an explicit amount, keep the
      // header amount in sync with the item sum.
      if (data.amount === undefined) {
        data.amount = items.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);
      }
    }

    if (Object.keys(data).length) {
      await tx.reimbursementClaim.update({ where: { id: Number(id) }, data });
    }

    return readDrawer(tx, tenantId, id);
  });
}

// ── submit (create the ordered approval chain) ───────────────────────────────

export async function submitClaim({ tenantId, id, approvalChain }) {
  // HR may submit a claim it raised for an employee; the approval engine then treats it as HR-filed.
  const claim = await prisma.reimbursementClaim.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    select: { employeeId: true },
  });
  if (!claim) throw Object.assign(new Error("Claim not found"), { status: 404 });
  const onBehalf = Number(getCtx().user?.employeeId) !== claim.employeeId;
  return legacySubmit(
    "CLAIM",
    id,
    onBehalf ? "HR submitted the claim for the employee" : undefined,
    { onBehalf },
  );
}

// ── approval-chain decision (advance / finalize) ─────────────────────────────

export async function decideClaimApproval({ tenantId, claimId, approvalId, decision, comments, approverId }) {
  return legacyDecision('CLAIM',claimId);
}

// ── terminal transitions ─────────────────────────────────────────────────────

export async function rejectClaim({ tenantId, id, reason, approverId }) {
  return legacyDecision('CLAIM',id);
}

export async function withdrawClaim({ tenantId, id }) {
  return legacyWithdraw('CLAIM',id);
}

export async function markPaid({ tenantId, id }) {
  return tenantTransaction(prisma, async (tx) => {
    const existing = await tx.reimbursementClaim.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw Object.assign(new Error("Claim not found"), { status: 404 });
    if (existing.status !== "APPROVED") {
      throw Object.assign(new Error(`Claim can only be marked PAID from APPROVED (is ${existing.status})`), {
        status: 409,
      });
    }
    await tx.reimbursementClaim.update({ where: { id: Number(id) }, data: { status: "PAID", paidAt: new Date() } });
    return readDrawer(tx, tenantId, id);
  });
}

// ── request-info Q&A ─────────────────────────────────────────────────────────

export async function requestClaimInfo({ tenantId, claimId, question, requestedById }) {
  return legacyDecision('CLAIM',claimId);
}

export async function respondClaimInfo({ tenantId, infoId, response }) {
  const info=await prisma.claimInformation.findFirst({where:scopedWhere(tenantId,{id:Number(infoId)})}); if(!info)throw Object.assign(new Error('Request not found'),{status:404}); return legacyDecision('CLAIM',info.claimId);
}

// ── CSV export ───────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  { key: "claimId", header: "Claim ID" },
  { key: "title", header: "Title" },
  { key: "employee", header: "Employee code", value: (r) => r.employee?.name || "" },
  { key: "category", header: "Category" },
  { key: "amount", header: "Amount" },
  { key: "submittedAt", header: "Submitted", value: (r) => (r.submittedAt ? new Date(r.submittedAt).toISOString() : "") },
  { key: "status", header: "Status" },
];

export async function exportClaimsCsv({ tenantId, ...filters }) {
  // Reuse the list query, un-paginated, to source the export rows.
  const { items } = await listClaims({ tenantId, ...filters, page: 1, pageSize: 200 });
  const content = toCSV(CSV_COLUMNS, items);
  const filename = `claims-${new Date().toISOString().slice(0, 10)}.csv`;
  return { format: "csv", filename, content };
}

export { CLAIM_STATUSES };
