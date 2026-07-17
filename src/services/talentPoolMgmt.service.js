// src/services/talentPoolMgmt.service.js
//
// Talent Pool MANAGEMENT surface (net-new, sits alongside talentPool.service.js
// which owns add/remove/list). These read/write helpers back the four
// hr_talent_pool_manage_* / _profile_ / _move_to_pipeline / _invite MCP tools.
//
// TENANCY (C.2 / T-P2.1): every read/write is folded through the shared
// tenancy helpers so a verified RBAC Company.uuid (tenantId, opaque string) is
// applied fail-closed — a null tenant matches ONLY null-tenant rows and can
// never widen across tenants. The verified tenant always wins over the body.
//
// DERIVATIONS (schema has no dedicated columns for these):
//   * role / department  → the candidate's MOST-RECENT Application (by appliedAt
//                          desc) → jobRequisition.title / .departmentId, else null.
//   * experienceYears    → probed out of Candidate.parsedResume
//                          (yearsOfExperience | totalExperience), else null.
//   * location           → Candidate has NO location column → always null.
//   * skills             → candidateSkills[].name.
//   * interviewScore     → avg of InterviewScorecard.overallScore across all the
//                          candidate's interviews (via applications), else null.

import prisma from "../lib/prisma.js";
import { scopedWhere, withTenant } from "../lib/tenancy.js";

// ── DERIVATION HELPERS ──────────────────────────────────────────────────────

// Resolve a set of BusinessUnit ids → names, batched + tenant-scoped fail-closed.
const resolveDepartmentNames = async (departmentIds, tenantId) => {
  const ids = [...new Set(departmentIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  if (!ids.length) return new Map();
  const units = await prisma.businessUnit.findMany({
    where: scopedWhere(tenantId, { id: { in: ids } }),
    select: { id: true, name: true },
  });
  return new Map(units.map((unit) => [unit.id, unit.name]));
};

// Probe a candidate's parsed-resume JSON for a years-of-experience figure.
// parsedResume is free-form AI output, so we look at the two documented keys and
// coerce to a finite number; anything else → null.
const deriveExperienceYears = (parsedResume) => {
  if (!parsedResume || typeof parsedResume !== "object") return null;
  const raw = parsedResume.yearsOfExperience ?? parsedResume.totalExperience;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// The candidate's most-recent application is the one with the latest appliedAt.
// Applications are included pre-sorted (appliedAt desc) so element 0 is newest.
const mostRecentApplication = (applications) =>
  Array.isArray(applications) && applications.length ? applications[0] : null;

// Candidate has no location column, but the parsed-resume JSON usually carries
// one. Probe the documented free-form keys and return the first non-empty string.
const deriveLocation = (parsedResume) => {
  if (!parsedResume || typeof parsedResume !== "object") return null;
  const raw =
    parsedResume.location ??
    parsedResume.city ??
    parsedResume.address ??
    (parsedResume.contact && typeof parsedResume.contact === "object"
      ? parsedResume.contact.location ?? parsedResume.contact.city ?? parsedResume.contact.address
      : null);
  return typeof raw === "string" && raw.trim().length ? raw.trim() : null;
};

const deriveSkillNames = (candidateSkills) =>
  Array.isArray(candidateSkills)
    ? candidateSkills.map((s) => s.name).filter((name) => typeof name === "string" && name.length)
    : [];

const fullName = (candidate) =>
  [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" ").trim() || null;

// Shared include: everything the list/profile derivations need in one round-trip.
const candidateInclude = {
  candidateSkills: { select: { name: true } },
  applications: {
    orderBy: { appliedAt: "desc" },
    include: { jobRequisition: { select: { title: true, departmentId: true } } },
  },
};

// ── LIST ────────────────────────────────────────────────────────────────────

/**
 * Tool 1 — hr_talent_pool_manage_list.
 * Returns enriched talent-pool membership rows (candidate + derived role /
 * department / experience / skills), tenant-scoped, with q/filter/sort/paging.
 */
export const listManagedPool = async ({
  tenantId,
  q,
  poolName,
  sort = "addedAt",
  order = "desc",
  page = 1,
  limit = 20,
} = {}) => {
  const resolvedPage = Number(page) > 0 ? Number(page) : 1;
  const resolvedLimit = Number(limit) > 0 ? Number(limit) : 20;
  const skip = (resolvedPage - 1) * resolvedLimit;

  const candidateFilter = q
    ? {
        candidate: {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
          ],
        },
      }
    : {};

  const where = scopedWhere(tenantId, {
    ...(poolName ? { poolName } : {}),
    ...candidateFilter,
  });

  // Only addedAt is a real TalentPool column; guard the sort so an odd value
  // can't throw a Prisma "unknown field" error.
  const sortField = sort === "addedAt" ? "addedAt" : "addedAt";
  const sortOrder = order === "asc" ? "asc" : "desc";

  const [memberships, total] = await Promise.all([
    prisma.talentPool.findMany({
      where,
      skip,
      take: resolvedLimit,
      orderBy: { [sortField]: sortOrder },
      include: {
        candidate: { include: candidateInclude },
      },
    }),
    prisma.talentPool.count({ where }),
  ]);

  // Resolve each candidate's most-recent-application departmentId → BusinessUnit
  // name, batched across the page so we never issue N queries.
  const deptIds = memberships
    .map((m) => mostRecentApplication(m.candidate?.applications)?.jobRequisition?.departmentId)
    .filter((id) => id != null);
  const deptNames = await resolveDepartmentNames(deptIds, tenantId);

  const rows = memberships.map((m) => {
    const candidate = m.candidate || {};
    const recent = mostRecentApplication(candidate.applications);
    const departmentId = recent?.jobRequisition?.departmentId ?? null;
    return {
      membershipId: m.id,
      candidateId: m.candidateId,
      name: fullName(candidate),
      role: recent?.jobRequisition?.title ?? null,
      department: departmentId != null ? deptNames.get(departmentId) ?? null : null,
      departmentId,
      experienceYears: deriveExperienceYears(candidate.parsedResume),
      location: candidate.location ?? deriveLocation(candidate.parsedResume),
      skills: deriveSkillNames(candidate.candidateSkills),
      poolName: m.poolName,
      notes: m.notes ?? null,
      addedAt: m.addedAt,
    };
  });

  return { items: rows, total, page: resolvedPage, limit: resolvedLimit };
};

// ── PROFILE ─────────────────────────────────────────────────────────────────

/**
 * Tool 2 — hr_talent_pool_profile_get.
 * Consolidated candidate profile for the talent-pool detail panel: contact,
 * roles previously applied to, interview score (avg overallScore), last
 * interview date, merged notes, and skills. Tenant-scoped, fail-closed.
 */
export const getPoolProfile = async ({ candidateId, tenantId } = {}) => {
  const id = Number(candidateId);

  const candidate = await prisma.candidate.findFirst({
    // Candidate is scoped by tenantId (nullable) — reuse the fail-closed helper.
    where: withTenant(tenantId, { id }),
    include: {
      candidateSkills: { select: { name: true } },
      talentPools: { select: { notes: true }, where: withTenant(tenantId, {}) },
      applications: {
        orderBy: { appliedAt: "desc" },
        include: {
          jobRequisition: { select: { title: true } },
          interviews: {
            select: {
              scheduledAt: true,
              scorecards: { select: { overallScore: true } },
            },
          },
        },
      },
    },
  });

  if (!candidate) {
    const err = new Error("Candidate not found");
    err.status = 404;
    throw err;
  }

  const previousRolesApplied = (candidate.applications || [])
    .map((a) => a.jobRequisition?.title)
    .filter((title) => typeof title === "string" && title.length);

  // Flatten every scorecard across every interview of every application.
  const scores = [];
  let lastInterviewDate = null;
  for (const app of candidate.applications || []) {
    for (const interview of app.interviews || []) {
      if (interview.scheduledAt) {
        if (!lastInterviewDate || interview.scheduledAt > lastInterviewDate) {
          lastInterviewDate = interview.scheduledAt;
        }
      }
      for (const sc of interview.scorecards || []) {
        const n = Number(sc.overallScore);
        if (Number.isFinite(n)) scores.push(n);
      }
    }
  }
  const interviewScore = scores.length
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : null;

  // Merge pool notes (across the candidate's memberships) with the candidate's
  // own notes into a single de-duplicated list.
  const notes = [
    ...(candidate.talentPools || []).map((tp) => tp.notes),
    candidate.notes,
  ].filter((note) => typeof note === "string" && note.trim().length);

  return {
    candidate: {
      name: fullName(candidate),
      email: candidate.email ?? null,
      phone: candidate.phone ?? null,
      source: candidate.source ?? null,
      location: candidate.location ?? deriveLocation(candidate.parsedResume),
    },
    previousRolesApplied,
    interviewScore,
    lastInterviewDate,
    notes,
    skills: deriveSkillNames(candidate.candidateSkills),
  };
};

// ── MOVE TO PIPELINE ────────────────────────────────────────────────────────

/**
 * Tool 3 — hr_talent_pool_move_to_pipeline.
 * Create an Application linking candidate → requisition (stage "applied",
 * status "open"), tenant-stamped. Respects @@unique([candidateId,
 * jobRequisitionId]) — returns the existing application if the pair already
 * exists (created:false) rather than throwing.
 */
export const moveToPipeline = async ({ candidateId, jobRequisitionId, tenantId, addedById } = {}) => {
  const cId = Number(candidateId);
  const rId = Number(jobRequisitionId);

  const existing = await prisma.application.findFirst({
    where: withTenant(tenantId, { candidateId: cId, jobRequisitionId: rId }),
    include: { candidate: true, jobRequisition: true },
  });
  if (existing) return { created: false, application: existing };

  const application = await prisma.application.create({
    data: {
      candidateId: cId,
      jobRequisitionId: rId,
      stage: "applied",
      status: "open",
      tenantId: tenantId ?? null,
      createdById: addedById != null ? Number(addedById) : null,
    },
    include: { candidate: true, jobRequisition: true },
  });

  return { created: true, application };
};

// ── INVITE ──────────────────────────────────────────────────────────────────

/**
 * Tool 4 — hr_talent_pool_invite.
 * Record an "invited to apply" note. Appends the note to the candidate's
 * TalentPool membership row(s) when present, else to Candidate.notes. When a
 * jobRequisitionId is supplied it also performs the move-to-pipeline behaviour.
 */
export const inviteCandidate = async ({ candidateId, jobRequisitionId, tenantId, addedById } = {}) => {
  const cId = Number(candidateId);

  const candidate = await prisma.candidate.findFirst({
    where: withTenant(tenantId, { id: cId }),
  });
  if (!candidate) {
    const err = new Error("Candidate not found");
    err.status = 404;
    throw err;
  }

  const stamp = `Invited to apply ${new Date().toISOString().slice(0, 10)}`;

  const appendNote = (prev) => (prev && prev.trim().length ? `${prev}\n${stamp}` : stamp);

  const memberships = await prisma.talentPool.findMany({
    where: withTenant(tenantId, { candidateId: cId }),
    select: { id: true, notes: true },
  });

  let updatedMemberships = 0;
  if (memberships.length) {
    for (const m of memberships) {
      await prisma.talentPool.update({
        where: { id: m.id },
        data: { notes: appendNote(m.notes) },
      });
      updatedMemberships += 1;
    }
  } else {
    // No pool membership — fall back to the candidate's own notes column.
    await prisma.candidate.update({
      where: { id: cId },
      data: { notes: appendNote(candidate.notes) },
    });
  }

  let pipeline = null;
  if (jobRequisitionId != null && `${jobRequisitionId}`.trim().length) {
    pipeline = await moveToPipeline({ candidateId: cId, jobRequisitionId, tenantId, addedById });
  }

  return {
    candidateId: cId,
    invited: true,
    note: stamp,
    updatedMemberships,
    updatedCandidateNotes: memberships.length === 0,
    pipeline,
  };
};
