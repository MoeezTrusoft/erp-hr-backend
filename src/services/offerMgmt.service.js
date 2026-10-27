import { offerLetterAccess } from "./offerLetter.service.js";
import {
  offerCreateSchema,
  offerTermsSchema,
  offerCompensationSchema,
} from "../lib/offerInput.js";
import { runOfferHandoff } from "./recruitmentHandoff.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { assertPermission } from "../lib/assertPermission.js";
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
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  offerScopeWhere,
  applicationScopeWhere,
  resolveRecruitmentScope,
} from "../lib/recruitmentAccess.js";
import { mcpCtx } from "../lib/requestContext.js";
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { transitionApplicationStageInTransaction } from "./applicationWorkflow.service.js";

const currentScope = (scope) =>
  scope ?? resolveRecruitmentScope(mcpCtx.getStore()?.user);
const accessWhere = (tenantId, scope, id) =>
  scopedWhere(tenantId, {
    AND: [
      offerScopeWhere(currentScope(scope)),
      ...(id == null ? [] : [{ id: Number(id) }]),
    ],
  });
const MASK = "••••••";

const OFFER_INCLUDE = {
  candidate: true,
  jobRequisition: { include: { position: true } },
  application: true,
};

// ── helpers ────────────────────────────────────────────────────────────────

const candidateName = (candidate) => {
  if (!candidate) return null;
  return (
    [candidate.firstName, candidate.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || null
  );
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
      if (entry.by)
        approvedBy.push({ stage, by: entry.by, at: entry.at ?? null });
    } else if (
      decision === "REJECTED" ||
      decision === "REJECT" ||
      decision === "DECLINED"
    ) {
      if (entry.by)
        rejectedBy.push({ stage, by: entry.by, at: entry.at ?? null });
      if (entry.reason && !reason) reason = entry.reason;
    }
  }
  return { approvedBy, rejectedBy, reason, stages: approvals };
};

// Mask the sensitive base of a compensation JSON blob unless showSensitive.
const compensationView = (compensation, showSensitive) => {
  if (!compensation || typeof compensation !== "object")
    return compensation ?? null;
  if (showSensitive) return compensation;
  return null;
};

const salaryView = (salary, showSensitive) =>
  showSensitive ? num(salary) : MASK;

// Build a formatted multi-line offer-letter preview string.
const buildPreview = (offer, showSensitive) => {
  const name = candidateName(offer.candidate) || "Candidate";
  const role = offer.jobRequisition?.title || "the position";
  const salaryLine = showSensitive
    ? `${offer.currency || "PKR"} ${num(offer.salary) ?? "—"}`
    : MASK;
  const start = offer.startDate
    ? new Date(offer.startDate).toISOString().slice(0, 10)
    : "TBD";
  const terms =
    offer.terms && typeof offer.terms === "object" ? offer.terms : {};
  const probation =
    terms.probationMonths != null ? `${terms.probationMonths} month(s)` : "N/A";
  const notice =
    terms.noticePeriodDays != null ? `${terms.noticePeriodDays} day(s)` : "N/A";
  const specialClauses = Array.isArray(terms.specialClauses)
    ? terms.specialClauses
    : terms.specialClauses
      ? [terms.specialClauses]
      : [];

  const lines = [
    `Dear ${name},`,
    ``,
    `We are pleased to offer you the position of ${role}` +
      (offer.employmentType ? ` (${offer.employmentType})` : "") +
      `.`,
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
    `Human Resources`,
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
    applicationId: offer.applicationId,
    employeeCategory: offer.employeeCategory,
    version: offer.version,
    role: offer.jobRequisition?.title ?? null,
    jobRequisitionId: offer.jobRequisitionId,
    offerType: offer.offerType ?? null,
    salary: salaryView(offer.salary, showSensitive),
    currency: offer.currency ?? null,
    status: offer.status,
    sentOn: offer.sentAt ?? null,
    viewedAt: offer.viewedAt ?? null,
    acceptedAt:
      offer.status === "ACCEPTED" ? (offer.respondedAt ?? null) : null,
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
const assertOfferInTenant = async (id, tenantId, scope) => {
  const existing = await prisma.offer.findFirst({
    where: accessWhere(tenantId, scope, id),
  });
  if (!existing)
    throw Object.assign(new Error("Offer not found"), { status: 404 });
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
  scope,
}) => {
  const take = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const skip = (currentPage - 1) * take;

  const where = accessWhere(tenantId, scope);
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

export const getOfferManage = async (
  id,
  { tenantId, showSensitive = false, scope },
) => {
  const offer = await prisma.offer.findFirst({
    where: accessWhere(tenantId, scope, id),
    include: OFFER_INCLUDE,
  });
  if (!offer)
    throw Object.assign(new Error("Offer not found"), { status: 404 });

  const detail = toManageRow(offer, showSensitive);
  detail.notes = currentScope(scope).canSeeInternalNotes
    ? (offer.notes ?? null)
    : null;
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

export const previewOfferManage = async (
  id,
  { tenantId, showSensitive = false, scope },
) => {
  const offer = await prisma.offer.findFirst({
    where: accessWhere(tenantId, scope, id),
    include: OFFER_INCLUDE,
  });
  if (!offer)
    throw Object.assign(new Error("Offer not found"), { status: 404 });

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

export const createOfferFull = async (
  input,
  { tenantId, showSensitive = false },
) => {
  const parsed = offerCreateSchema.safeParse(input);
  if (!parsed.success)
    throw Object.assign(new Error("Invalid offer terms or compensation"), {
      status: 422,
      code: "HR-5511",
    });
  const {
    applicationId,
    candidateId,
    jobRequisitionId,
    employmentType,
    employeeCategory,
    expiryDate,
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
  } = parsed.data;

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
  if (
    baseSalary == null ||
    !Number.isFinite(Number(baseSalary)) ||
    Number(baseSalary) <= 0
  ) {
    throw Object.assign(new Error("baseSalary is required"), { status: 400 });
  }

  const compensation = offerCompensationSchema.parse({
    baseSalary: num(baseSalary),
    currency,
    bonus: bonus ?? null,
    allowances: allowances ?? null,
    benefits: Array.isArray(benefits) ? benefits : [],
    ...(salaryFrequency ? { salaryFrequency } : {}),
  });

  const terms = offerTermsSchema.parse({
    probationMonths: probationMonths ?? null,
    noticePeriodDays: noticePeriodDays ?? null,
    additionalTerms: Array.isArray(specialClauses)
      ? specialClauses.join("\n")
      : (specialClauses ?? null),
    specialClauses: specialClauses ?? null,
    ...(department ? { department } : {}),
    ...(hiringManager ? { hiringManager } : {}),
    ...(workLocation ? { workLocation } : {}),
    ...(jobTitle ? { jobTitle } : {}),
  });

  const created = await tenantTransaction(
    prisma,
    async (tx) => {
      const verifiedAuthor = await offerLetterAccess(tx, tenantId);
      const application = await tx.application.findFirst({
        where: scopedWhere(tenantId, {
          id: applicationIdNum,
          candidateId: candidateIdNum,
          jobRequisitionId: jobRequisitionIdNum,
          ...applicationScopeWhere(currentScope()),
        }),
      });
      if (!application)
        throw Object.assign(new Error("Application not found"), {
          status: 404,
          code: "HR-5507",
        });
      if (!["MANAGEMENT", "EMPLOYEE", "INTERNEE"].includes(employeeCategory))
        throw Object.assign(new Error("Choose an employee category"), {
          status: 422,
          code: "HR-5503",
        });
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
          employeeCategory,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          terms,
          compensation,
          createdById: verifiedAuthor.id,
        }),
        include: OFFER_INCLUDE,
      });

      await transitionApplicationStageInTransaction(
        {
          id: applicationIdNum,
          tenantId,
          targetStage: "offer",
          reason: "Offer created",
          actorId: verifiedAuthor.id,
          source: "offer-create",
        },
        tx,
      );
      return created;
    },
    { tenantId },
  );

  return getOfferManage(created.id, { tenantId, showSensitive });
};

// ── pre-boarding transition ──────────────────────────────────────────────────

export const markOfferPreboarding = async (
  id,
  { tenantId, showSensitive = false, note, scope },
) => {
  const ctx = getCtx();
  if (!ctx.actorVerified || ctx.user?.tenantId !== tenantId)
    throw Object.assign(new Error("Verified company employee required"), {
      status: 401,
      code: "HR-5507",
    });
  assertPermission(ctx.permissions, "PUT", "hr:recruitment", false);
  if (resolveRecruitmentScope(ctx.user).level !== "ORG")
    throw Object.assign(new Error("Preboarding access is not permitted"), {
      status: 403,
      code: "HR-5507",
    });
  if (note !== undefined && (typeof note !== "string" || note.length > 2000))
    throw Object.assign(new Error("Preboarding note is too long"), {
      status: 422,
      code: "HR-5511",
    });
  const existing = await assertOfferInTenant(id, tenantId, scope);
  const who = await tenantTransaction(
    prisma,
    async (tx) => {
      const verifiedActor = await actor(tx, ctx);
      if (existing.status !== "ACCEPTED")
        throw Object.assign(
          new Error("Accept the offer before starting preboarding"),
          { status: 409, code: "HR-5508" },
        );
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId: existing.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db: tx },
      );
      return verifiedActor;
    },
    { tenantId },
  );
  const { handoff } = await runOfferHandoff({
    offerId: Number(id),
    tenantId,
    actorId: who.id,
  });
  if (handoff.status !== "COMPLETED" || !handoff.checklistId)
    throw Object.assign(
      new Error("Resolve the offer handoff before starting preboarding"),
      { status: 409, code: "HR-5508" },
    );
  await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Candidate" WHERE id=${existing.candidateId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId: existing.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db: tx },
      );
      await tx.$queryRaw`SELECT id FROM onboarding_checklists WHERE id=${handoff.checklistId} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
      const checklist = await tx.onboardingChecklist.findFirst({
        where: { id: handoff.checklistId, tenantId },
      });
      if (!checklist)
        throw Object.assign(new Error("Onboarding checklist not found"), {
          status: 404,
          code: "HR-5507",
        });
      const log = Array.isArray(checklist.activityLog)
        ? checklist.activityLog
        : [];
      if (
        log.some(
          (entry) =>
            entry.kind === "offer-preboarding" && entry.offerId === Number(id),
        )
      )
        return;
      await tx.onboardingChecklist.update({
        where: { id: checklist.id, tenantId },
        data: {
          ...(!checklist.currentStage ||
          checklist.currentStage === "pre_joining"
            ? { currentStage: "pre_boarding" }
            : {}),
          activityLog: [
            ...log,
            {
              kind: "offer-preboarding",
              offerId: Number(id),
              at: new Date().toISOString(),
              actor: who.id,
              text:
                "Preboarding initiated" +
                (note?.trim() ? ": " + note.trim() : ""),
            },
          ],
        },
      });
    },
    { tenantId },
  );
  return {
    ...(await getOfferManage(id, { tenantId, showSensitive, scope })),
    handoff: {
      id: handoff.id,
      status: handoff.status,
      checklistId: handoff.checklistId,
    },
  };
};
