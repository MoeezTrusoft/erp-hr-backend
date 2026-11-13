// src/services/candidatePipeline.service.js
//
// Candidate Pipeline (Kanban) read-model. Projects Application rows (joined to
// Candidate + JobRequisition) into board cards for the recruitment pipeline
// screen. Read-only: stage/status mutations live in the existing
// hr_application_update_stage / hr_application_update_status tools.
//
// Tenant-scoped by tenantId (RBAC Company.uuid; nullable → matches null rows,
// consistent with applicationService). Singleton prisma per ARCH-01 §5.3–5.4.
import prisma from "../lib/prisma.js";
import { listDepartments } from "./rbac.client.js"; // department is owned by RBAC (Company → Department)

// Fetch the tenant's RBAC departments once per request and index by id, so each
// card can show its requisition's department name. Fail-soft → empty map.
async function buildDeptMap() {
  try {
    return new Map((await listDepartments()).map((d) => [d.id, d]));
  } catch {
    return new Map();
  }
}

// Board stage order (left → right). Matches Application.stage enum values.
export const PIPELINE_STAGES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
];

// parsedResume is free-form AI-extracted JSON; years-of-experience has shown up
// under several keys across parser versions. Probe the known aliases, coerce to
// a finite number, else null.
const YEARS_EXPERIENCE_KEYS = [
  "yearsOfExperience",
  "totalExperience",
  "experienceYears",
];

function deriveYearsExperience(parsedResume) {
  if (!parsedResume || typeof parsedResume !== "object") return null;
  for (const key of YEARS_EXPERIENCE_KEYS) {
    const raw = parsedResume[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function toCard(application, deptMap) {
  const candidate = application.candidate ?? {};
  const firstName = candidate.firstName ?? "";
  const lastName = candidate.lastName ?? "";
  const name = `${firstName} ${lastName}`.trim();

  const documents = candidate.resumeMediaId
    ? [{ type: "resume", mediaId: candidate.resumeMediaId }]
    : [];

  // department comes from the card's requisition (JobRequisition.departmentId is
  // an RBAC Department.id), resolved via the per-request RBAC dept map.
  const departmentId = application.jobRequisition?.departmentId ?? null;
  const department = departmentId != null && deptMap ? (deptMap.get(departmentId) ?? null) : null;

  return {
    applicationId: application.id,
    candidateId: application.candidateId,
    name,
    position: application.jobRequisition?.title ?? null,
    departmentId,
    department,
    yearsExperience: deriveYearsExperience(candidate.parsedResume),
    appliedDate: application.appliedAt,
    status: application.status,
    stage: application.stage,
    documents,
  };
}

// Build the prisma `where` for the pipeline query from the caller filters.
// tenantId scopes every read; q matches candidate first/last/email
// (case-insensitive); filter narrows by requisition or candidate source.
function buildWhere({ tenantId, q, requisitionId, source }) {
  const candidateWhere = {};
  if (q && q.trim()) {
    const term = q.trim();
    candidateWhere.OR = [
      { firstName: { contains: term, mode: "insensitive" } },
      { lastName: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
    ];
  }
  if (source) candidateWhere.source = source;

  return {
    tenantId: tenantId ?? null,
    ...(requisitionId ? { jobRequisitionId: Number(requisitionId) } : {}),
    ...(Object.keys(candidateWhere).length ? { candidate: { is: candidateWhere } } : {}),
  };
}

function buildOrderBy(sort) {
  const order = sort === "asc" ? "asc" : "desc";
  return { appliedAt: order };
}

const CARD_INCLUDE = {
  candidate: true,
  jobRequisition: true,
};

/**
 * KANBAN board: applications grouped into ordered stage columns.
 * @returns {Promise<{ columns: Array<{ stage, count, cards }> }>}
 */
export const getPipelineBoard = async ({
  tenantId,
  q,
  requisitionId,
  source,
  sort = "desc",
} = {}) => {
  const where = buildWhere({ tenantId, q, requisitionId, source });

  const applications = await prisma.application.findMany({
    where,
    include: CARD_INCLUDE,
    orderBy: buildOrderBy(sort),
  });

  const deptMap = await buildDeptMap();
  const byStage = new Map(PIPELINE_STAGES.map((stage) => [stage, []]));
  for (const application of applications) {
    const bucket = byStage.get(application.stage);
    // Only board known stages; unknown/legacy stages are skipped so the column
    // set stays fixed (applied…rejected).
    if (bucket) bucket.push(toCard(application, deptMap));
  }

  const columns = PIPELINE_STAGES.map((stage) => {
    const cards = byStage.get(stage);
    return { stage, count: cards.length, cards };
  });

  return { columns };
};

/**
 * Flat, paginated list variant of the same cards.
 * @returns {Promise<{ items, total, page, pageSize }>}
 */
export const listPipelineCards = async ({
  tenantId,
  q,
  requisitionId,
  source,
  stage,
  sort = "desc",
  page = 1,
  pageSize = 20,
} = {}) => {
  const where = {
    ...buildWhere({ tenantId, q, requisitionId, source }),
    ...(stage ? { stage } : {}),
  };

  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const skip = (safePage - 1) * safePageSize;

  const [rows, total] = await Promise.all([
    prisma.application.findMany({
      where,
      include: CARD_INCLUDE,
      orderBy: buildOrderBy(sort),
      skip,
      take: safePageSize,
    }),
    prisma.application.count({ where }),
  ]);

  const deptMap = await buildDeptMap();
  return {
    items: rows.map((r) => toCard(r, deptMap)),
    total,
    page: safePage,
    pageSize: safePageSize,
  };
};
