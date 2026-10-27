// src/services/offer-mgmt.service.js — Offer Management (enhanced) service layer.
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
//
// Phase 3a — GRADE BAND WARNING. A draft's base salary is compared with the
// band of the requisition's grade (JobRequisition.gradeLevelId, else the
// position's band label matched to a GradeLevel name). Outside the band is a
// WARNING in the response, never a block: the band is guidance and the
// approval chain is where an exception is judged. The band figures are payroll
// data, so they are returned only to callers who may see compensation.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData, withTenant } from "../lib/tenancy.js";
import { employeeNamesById, nameOf } from "../lib/employee-names.util.js";
import { transitionApplicationStageInTransaction } from "./application-workflow.service.js";

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

// Recruitment Phase 7: the approval chips showed bare employee ids. Resolve
// every `by` of the page's rows in one query under the tenant and add `byName`
// next to it (null when the id does not resolve, e.g. a legacy text value).
const withApproverNames = async (rows, tenantId) => {
  const entries = rows.flatMap((row) => [...(row.approvals?.approvedBy ?? []), ...(row.approvals?.rejectedBy ?? [])]);
  if (!entries.length) return rows;
  let names = new Map();
  try {
    names = await employeeNamesById(prisma, tenantId, entries.map((entry) => entry.by));
  } catch (err) {
    logger.warn({ err: err?.message, tenantId }, "offer manage: approver names unavailable");
  }
  for (const entry of entries) entry.byName = nameOf(names, entry.by);
  return rows;
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
    items: await withApproverNames(
      offers.map((offer) => toManageRow(offer, showSensitive)),
      tenantId
    ),
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

  const [detail] = await withApproverNames([toManageRow(offer, showSensitive)], tenantId);
  detail.notes = offer.notes ?? null;
  // Phase 3a — the detail panel extends with If-Match (version) and sends for
  // signature with the category chosen at acceptance (employeeCategory).
  detail.version = offer.version ?? 0;
  detail.employeeCategory = offer.employeeCategory ?? null;
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

  const created = await prisma.$transaction(async (tx) => {
    const created = await tx.offer.create({
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

    await transitionApplicationStageInTransaction({
      id: applicationIdNum,
      tenantId,
      targetStage: "offer",
      reason: "Offer created",
      actorId: createdById,
      source: "offer-create",
    }, tx);
    return created;
  });

  const detail = await getOfferManage(created.id, { tenantId, showSensitive });
  const check = await safeBandCheck({ tenantId, jobRequisitionId: jobRequisitionIdNum, salary: baseSalary, currency });
  return { ...detail, ...bandWarningsView(check, showSensitive) };
};

// ── grade band check (Phase 3a) ─────────────────────────────────────────────

export const SALARY_BAND_WARNING = Object.freeze({
  BELOW: "SALARY_BELOW_BAND",
  ABOVE: "SALARY_ABOVE_BAND",
});

const GRADE_BAND_SELECT = { id: true, name: true, minSalary: true, maxSalary: true, bandCurrency: true };

// { requisitionFound, band }: band is null when the requisition has no grade or
// the grade has no band.
const loadRequisitionBand = async ({ tenantId, jobRequisitionId }, { db = prisma } = {}) => {
  const id = num(jobRequisitionId);
  if (!Number.isInteger(id) || id <= 0) return { requisitionFound: false, band: null };
  const requisition = await db.jobRequisition.findFirst({
    where: withTenant(tenantId, { id }),
    select: { id: true, gradeLevelId: true, position: { select: { band: true } } },
  });
  if (!requisition) return { requisitionFound: false, band: null };
  let grade = null;
  if (requisition.gradeLevelId) {
    grade = await db.gradeLevel.findFirst({
      where: withTenant(tenantId, { id: requisition.gradeLevelId }),
      select: GRADE_BAND_SELECT,
    });
  } else if (requisition.position?.band) {
    // Position.band is a free-text grade label; it names a GradeLevel only
    // when the tenant uses the same vocabulary, so a miss is "no band".
    grade = await db.gradeLevel.findFirst({
      where: withTenant(tenantId, { name: requisition.position.band }),
      select: GRADE_BAND_SELECT,
    });
  }
  const min = num(grade?.minSalary);
  const max = num(grade?.maxSalary);
  if (!grade || (min == null && max == null)) return { requisitionFound: true, band: null };
  return {
    requisitionFound: true,
    band: { gradeLevelId: grade.id, gradeName: grade.name, min, max, currency: grade.bandCurrency ?? null },
  };
};

/** The requisition's salary band, or null (no requisition, grade or band). */
export const resolveRequisitionBand = async (args, options = {}) => (await loadRequisitionBand(args, options)).band;

// Pure comparison. A band in another currency is not comparable (no FX here),
// so it yields no warning rather than a wrong one.
export const compareSalaryToBand = (salary, currency, band) => {
  const amount = num(salary);
  if (!band) return { hasBand: false, comparable: false, reason: "NO_BAND", warnings: [] };
  if (amount == null) return { hasBand: true, comparable: false, reason: "NO_SALARY", warnings: [] };
  if (band.currency && currency && String(band.currency).toUpperCase() !== String(currency).toUpperCase()) {
    return { hasBand: true, comparable: false, reason: "CURRENCY_MISMATCH", warnings: [] };
  }
  const warnings = [];
  if (band.min != null && amount < band.min) warnings.push({ code: SALARY_BAND_WARNING.BELOW, min: band.min, max: band.max });
  if (band.max != null && amount > band.max) warnings.push({ code: SALARY_BAND_WARNING.ABOVE, min: band.min, max: band.max });
  return { hasBand: true, comparable: true, reason: null, warnings };
};

export const checkOfferSalaryBand = async ({ tenantId, jobRequisitionId, salary, currency }, options = {}) => {
  const { requisitionFound, band } = await loadRequisitionBand({ tenantId, jobRequisitionId }, options);
  return { requisitionFound, band, ...compareSalaryToBand(salary, currency, band) };
};

// The band check must never block (or fail) an offer write: a lookup error is
// logged and reads as "no warning".
export const safeBandCheck = async (args, options = {}) => {
  try {
    return await checkOfferSalaryBand(args, options);
  } catch (err) {
    logger.warn({ errMessage: err?.message, jobRequisitionId: args?.jobRequisitionId }, "offer band check failed; no warning returned");
    return { band: null, hasBand: false, comparable: false, reason: "CHECK_FAILED", warnings: [] };
  }
};

// What a create response carries. A caller who may not see compensation gets
// no band figures (and so no warning: the code alone places the salary
// relative to a band they may not read).
export const bandWarningsView = (check, canSeeCompensation) =>
  canSeeCompensation ? { warnings: check?.warnings ?? [] } : { warnings: [], warningsRedacted: true };

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
