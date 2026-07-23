// src/services/offerMgmt.service.js — Offer Management (enhanced) service layer.
//
// Sits alongside the base offer.service.js but drives the richer
// "Offer Management" screens: structured compensation/terms/approvals JSON,
// preview letter generation, full-create, and pre-boarding transitions.
//
// C4 note: Offer.salary is C4-encrypted at rest (schema String, `offer.salary`
// registered as a decrypt-to-number field in c4Encryption.js). The singleton
// prisma client ($extends c4EncryptionExtension) transparently encrypts on
// write and decrypts to a Number on read — so this service writes
// salary=String(baseSalary) and reads salary back as a number without any
// manual crypto. Sensitive-value MASKING (salary + compensation.baseSalary) is
// a presentation concern handled here via the `showSensitive` flag the tool
// layer computes from hr:payroll VIEW; encryption ≠ authorization.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

const MASK = "••••••";

const OFFER_INCLUDE = {
  candidate: true,
  jobRequisition: { include: { position: true } },
  application: true,
};

// ── helpers ────────────────────────────────────────────────────────────────

const candidateName = (candidate) => {
  if (!candidate) return null;
  return [candidate.firstName, candidate.lastName].filter(Boolean).join(" ").trim() || null;
};

const num = (value) => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Derive an approvedBy / rejectedBy / reason summary from the approvals JSON.
// approvals = { hiringManager:{by,decision,at,reason}, hrHead:{...}, finance:{...} }
const summarizeApprovals = (approvals) => {
  if (!approvals || typeof approvals !== "object") {
    return { approvedBy: [], rejectedBy: [], reason: null, stages: {} };
  }
  const approvedBy = [];
  const rejectedBy = [];
  let reason = null;
  for (const [stage, entry] of Object.entries(approvals)) {
    if (!entry || typeof entry !== "object") continue;
    const decision = String(entry.decision || "").toUpperCase();
    if (decision === "APPROVED" || decision === "APPROVE") {
      if (entry.by) approvedBy.push({ stage, by: entry.by, at: entry.at ?? null });
    } else if (decision === "REJECTED" || decision === "REJECT" || decision === "DECLINED") {
      if (entry.by) rejectedBy.push({ stage, by: entry.by, at: entry.at ?? null });
      if (entry.reason && !reason) reason = entry.reason;
    }
  }
  return { approvedBy, rejectedBy, reason, stages: approvals };
};

// Mask the sensitive base of a compensation JSON blob unless showSensitive.
const compensationView = (compensation, showSensitive) => {
  if (!compensation || typeof compensation !== "object") return compensation ?? null;
  if (showSensitive) return compensation;
  return { ...compensation, baseSalary: MASK };
};

const salaryView = (salary, showSensitive) => (showSensitive ? num(salary) : MASK);

// Build a formatted multi-line offer-letter preview string.
const buildPreview = (offer, showSensitive) => {
  const name = candidateName(offer.candidate) || "Candidate";
  const role = offer.jobRequisition?.title || "the position";
  const salaryLine = showSensitive
    ? `${offer.currency || "PKR"} ${num(offer.salary) ?? "—"}`
    : MASK;
  const start = offer.startDate ? new Date(offer.startDate).toISOString().slice(0, 10) : "TBD";
  const terms = offer.terms && typeof offer.terms === "object" ? offer.terms : {};
  const probation = terms.probationMonths != null ? `${terms.probationMonths} month(s)` : "N/A";
  const notice = terms.noticePeriodDays != null ? `${terms.noticePeriodDays} day(s)` : "N/A";
  const specialClauses = Array.isArray(terms.specialClauses)
    ? terms.specialClauses
    : terms.specialClauses
      ? [terms.specialClauses]
      : [];

  const lines = [
    `Dear ${name},`,
    ``,
    `We are pleased to offer you the position of ${role}` +
      (offer.employmentType ? ` (${offer.employmentType})` : "") + `.`,
    ``,
    `Compensation: ${salaryLine}`,
    `Start Date: ${start}`,
    `Probation Period: ${probation}`,
    `Notice Period: ${notice}`,
  ];
  if (offer.offerType) lines.push(`Offer Type: ${offer.offerType}`);
  if (specialClauses.length) {
    lines.push(``, `Special Clauses:`);
    for (const clause of specialClauses) lines.push(`  - ${clause}`);
  }
  lines.push(
    ``,
    `This offer is subject to the terms and conditions outlined in your`,
    `employment agreement. We look forward to welcoming you to the team.`,
    ``,
    `Sincerely,`,
    `Human Resources`
  );
  return lines.join("\n");
};

// Shape a full offer row for the manage screens.
const toManageRow = (offer, showSensitive) => {
  const approvals = summarizeApprovals(offer.approvals);
  return {
    offerId: offer.id,
    candidate: candidateName(offer.candidate),
    candidateId: offer.candidateId,
    role: offer.jobRequisition?.title ?? null,
    jobRequisitionId: offer.jobRequisitionId,
    offerType: offer.offerType ?? null,
    salary: salaryView(offer.salary, showSensitive),
    currency: offer.currency ?? null,
    status: offer.status,
    sentOn: offer.sentAt ?? null,
    viewedAt: offer.viewedAt ?? null,
    acceptedAt: offer.status === "ACCEPTED" ? (offer.respondedAt ?? null) : null,
    respondedAt: offer.respondedAt ?? null,
    employmentType: offer.employmentType ?? null,
    startDate: offer.startDate ?? null,
    expiryDate: offer.expiryDate ?? null,
    terms: offer.terms ?? null,
    compensation: compensationView(offer.compensation, showSensitive),
    approvals: {
      approvedBy: approvals.approvedBy,
      rejectedBy: approvals.rejectedBy,
      reason: approvals.reason,
    },
    createdAt: offer.created_at ?? null,
    updatedAt: offer.updated_at ?? null,
  };
};

// Tenant-scoped pre-read guard reused by mutations (fail-closed).
const assertOfferInTenant = async (id, tenantId) => {
  const existing = await prisma.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!existing) throw Object.assign(new Error("Offer not found"), { status: 404 });
  return existing;
};

// ── list ─────────────────────────────────────────────────────────────────

export const listOffersManage = async ({
  q,
  status,
  offerType,
  sort,
  order = "desc",
  page = 1,
  pageSize = 20,
  tenantId,
  showSensitive = false,
}) => {
  const take = Math.max(1, Number(pageSize) || 20);
  const currentPage = Math.max(1, Number(page) || 1);
  const skip = (currentPage - 1) * take;

  const where = scopedWhere(tenantId, {});
  if (status) where.status = status;
  if (offerType) where.offerType = offerType;
  if (q && q.trim()) {
    const term = q.trim();
    where.candidate = {
      is: {
        OR: [
          { firstName: { contains: term, mode: "insensitive" } },
          { lastName: { contains: term, mode: "insensitive" } },
        ],
      },
    };
  }

  const sortField = sort === "startDate" ? "startDate" : "sentAt";
  const sortOrder = String(order).toLowerCase() === "asc" ? "asc" : "desc";

  const [offers, total] = await Promise.all([
    prisma.offer.findMany({
      where,
      skip,
      take,
      orderBy: { [sortField]: sortOrder },
      include: OFFER_INCLUDE,
    }),
    prisma.offer.count({ where }),
  ]);

  return {
    items: offers.map((offer) => toManageRow(offer, showSensitive)),
    total,
    page: currentPage,
    pageSize: take,
  };
};

// ── get (full detail + preview) ─────────────────────────────────────────────

export const getOfferManage = async (id, { tenantId, showSensitive = false }) => {
  const offer = await prisma.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: OFFER_INCLUDE,
  });
  if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });

  const detail = toManageRow(offer, showSensitive);
  detail.notes = offer.notes ?? null;
  detail.approvals = {
    ...detail.approvals,
    stages: offer.approvals ?? null,
  };
  return {
    ...detail,
    preview: buildPreview(offer, showSensitive),
  };
};

// ── preview only (no mutation) ───────────────────────────────────────────────

export const previewOfferManage = async (id, { tenantId, showSensitive = false }) => {
  const offer = await prisma.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: OFFER_INCLUDE,
  });
  if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });

  return {
    preview: buildPreview(offer, showSensitive),
    offer: {
      offerId: offer.id,
      candidate: candidateName(offer.candidate),
      role: offer.jobRequisition?.title ?? null,
      offerType: offer.offerType ?? null,
      employmentType: offer.employmentType ?? null,
      status: offer.status,
      currency: offer.currency ?? null,
      salary: salaryView(offer.salary, showSensitive),
      startDate: offer.startDate ?? null,
    },
  };
};

// ── full create ─────────────────────────────────────────────────────────────

export const createOfferFull = async (input, { tenantId, createdById, showSensitive = false }) => {
  const {
    applicationId,
    candidateId,
    jobRequisitionId,
    employmentType,
    startDate,
    probationMonths,
    noticePeriodDays,
    baseSalary,
    bonus,
    allowances,
    currency = "PKR",
    benefits = [],
    specialClauses,
    offerType = "Standard",
    department,
    hiringManager,
    workLocation,
    jobTitle,
    salaryFrequency,
  } = input;

  // Guard the three NOT-NULL FKs (Offer.applicationId @unique, candidateId,
  // jobRequisitionId) fail-closed: reject with a clean 400 rather than letting a
  // missing/invalid id become null and hit a raw Prisma NOT-NULL error.
  const applicationIdNum = num(applicationId);
  const candidateIdNum = num(candidateId);
  const jobRequisitionIdNum = num(jobRequisitionId);
  for (const [field, value] of [
    ["applicationId", applicationIdNum],
    ["candidateId", candidateIdNum],
    ["jobRequisitionId", jobRequisitionIdNum],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw Object.assign(new Error(`${field} is required`), { status: 400 });
    }
  }
  if (baseSalary == null || !Number.isFinite(Number(baseSalary))) {
    throw Object.assign(new Error("baseSalary is required"), { status: 400 });
  }

  const compensation = {
    baseSalary: num(baseSalary),
    currency,
    bonus: bonus ?? null,
    allowances: allowances ?? null,
    benefits: Array.isArray(benefits) ? benefits : [],
    ...(salaryFrequency ? { salaryFrequency } : {}),
  };

  const terms = {
    probationMonths: probationMonths ?? null,
    noticePeriodDays: noticePeriodDays ?? null,
    additionalTerms: specialClauses ?? null,
    specialClauses: specialClauses ?? null,
    ...(department ? { department } : {}),
    ...(hiringManager ? { hiringManager } : {}),
    ...(workLocation ? { workLocation } : {}),
    ...(jobTitle ? { jobTitle } : {}),
  };

  const created = await prisma.offer.create({
    data: scopedData(tenantId, {
      applicationId: applicationIdNum,
      candidateId: candidateIdNum,
      jobRequisitionId: jobRequisitionIdNum,
      // C4: written as a String; the extension encrypts on write, decrypts on read.
      salary: String(baseSalary),
      currency,
      startDate: startDate ? new Date(startDate) : null,
      status: "DRAFT",
      offerType,
      employmentType: employmentType ?? null,
      terms,
      compensation,
      createdById: createdById != null ? Number(createdById) : null,
    }),
    include: OFFER_INCLUDE,
  });

  return getOfferManage(created.id, { tenantId, showSensitive });
};

// ── pre-boarding transition ──────────────────────────────────────────────────

export const markOfferPreboarding = async (id, { tenantId, showSensitive = false, note }) => {
  const existing = await assertOfferInTenant(id, tenantId);

  const prevTerms =
    existing.terms && typeof existing.terms === "object" ? existing.terms : {};
  const terms = { ...prevTerms, preboarding: true, preboardingAt: new Date().toISOString() };

  const stamp = `[${new Date().toISOString()}] Preboarding initiated${note ? `: ${note}` : ""}`;
  const notes = existing.notes ? `${existing.notes}\n${stamp}` : stamp;

  await prisma.offer.update({
    where: { id: Number(id) },
    data: { terms, notes },
  });

  return getOfferManage(id, { tenantId, showSensitive });
};
