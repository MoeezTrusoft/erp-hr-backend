import { createApplication } from "./applicationService.js";
// src/services/talentPoolMgmt.service.js
//
// Talent Pool MANAGEMENT surface (net-new, sits alongside talentPool.service.js
// which owns add/remove/list). These read/write helpers back the four
// hr_talent_pool_manage_* / _profile_ / _move_to_pipeline / _invite MCP tools.
//
// TENANCY (C.2 / T-P2.1): every read/write is folded through the shared
// tenancy helpers so a verified RBAC Company.uuid (tenantId, opaque string) is
// applied to every query. F-06 rejects tenantless interactive traffic before
// this service executes. The verified tenant always wins over the body.
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

import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import {
  candidateScopeWhere,
  applicationScopeWhere,
} from "../lib/recruitmentAccess.js";
import prisma from "../lib/prisma.js";
import { scopedWhere, withTenant } from "../lib/tenancy.js";
export { listManagedPool } from "./talentPoolList.service.js";
import { poolExperienceYears as deriveExperienceYears } from "./talentPoolList.service.js";
import { inviteToApply } from "./talentPoolInvitation.service.js";

// ── DERIVATION HELPERS ──────────────────────────────────────────────────────

// Resolve a set of BusinessUnit ids → names, batched + tenant-scoped fail-closed.
const resolveDepartmentNames = async (departmentIds, tenantId) => {
  const ids = [
    ...new Set(
      departmentIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)),
    ),
  ];
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
      ? (parsedResume.contact.location ??
        parsedResume.contact.city ??
        parsedResume.contact.address)
      : null);
  return typeof raw === "string" && raw.trim().length ? raw.trim() : null;
};

const deriveSkillNames = (candidateSkills) =>
  Array.isArray(candidateSkills)
    ? candidateSkills
        .map((s) => s.name)
        .filter((name) => typeof name === "string" && name.length)
    : [];

const fullName = (candidate) =>
  [candidate?.firstName, candidate?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim() || null;

// ── PROFILE ─────────────────────────────────────────────────────────────────

/**
 * Tool 2 — hr_talent_pool_profile_get.
 * Consolidated candidate profile for the talent-pool detail panel: contact,
 * roles previously applied to, interview score (avg overallScore), last
 * interview date, merged notes, and skills. Tenant-scoped, fail-closed.
 */
export const getPoolProfile = async ({ candidateId, tenantId } = {}) => {
  const { scope } = await requireRecruitmentActor({ tenantId });
  const id = Number(candidateId);

  const candidate = await prisma.candidate.findFirst({
    // Candidate is scoped by tenantId (nullable) — reuse the fail-closed helper.
    where: withTenant(tenantId, {
      id,
      anonymizedAt: null,
      ...candidateScopeWhere(scope),
    }),
    include: {
      candidateSkills: { select: { name: true } },
      talentPools: { select: { notes: true }, where: withTenant(tenantId, {}) },
      applications: {
        where: applicationScopeWhere(scope),
        orderBy: { appliedAt: "desc" },
        include: {
          jobRequisition: { select: { title: true, departmentId: true } },
          interviews: {
            select: {
              scheduledAt: true,
              scorecards: {
                where: { submittedAt: { not: null } },
                select: { overallScore: true },
              },
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

  // Role / department come from the candidate's most-recent application (same
  // derivation as the list), so the Add-to-Pool form can auto-fill them.
  const recent = mostRecentApplication(candidate.applications);
  const departmentId = recent?.jobRequisition?.departmentId ?? null;
  const deptNames = await resolveDepartmentNames([departmentId], tenantId);

  return {
    candidate: {
      name: fullName(candidate),
      email: candidate.email ?? null,
      phone: candidate.phone ?? null,
      source: candidate.source ?? null,
      location: candidate.location ?? deriveLocation(candidate.parsedResume),
    },
    role: recent?.jobRequisition?.title ?? null,
    department:
      departmentId != null ? (deptNames.get(departmentId) ?? null) : null,
    departmentId,
    experienceYears: deriveExperienceYears(candidate.parsedResume),
    location: candidate.location ?? deriveLocation(candidate.parsedResume),
    previousRolesApplied,
    interviewScore,
    lastInterviewDate,
    notes: scope.canSeeInternalNotes ? notes : [],
    notesRedacted: !scope.canSeeInternalNotes,
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
export const moveToPipeline = async ({
  candidateId,
  jobRequisitionId,
  tenantId,
  addedById,
} = {}) => {
  const { who } = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.create",
    allowedScopes: ["ORG"],
  });
  addedById = who.id;
  const cId = Number(candidateId);
  const rId = Number(jobRequisitionId);

  const existing = await prisma.application.findFirst({
    where: withTenant(tenantId, { candidateId: cId, jobRequisitionId: rId }),
    include: { candidate: true, jobRequisition: true },
  });
  if (existing) return { created: false, application: existing };

  const application = await createApplication({
    candidateId: cId,
    jobRequisitionId: rId,
    tenantId,
    createdById: addedById,
  });

  return { created: true, application };
};

// ── INVITE ──────────────────────────────────────────────────────────────────

/** Record a consent-checked invitation and its durable message. Applications remain a separate explicit action. */
export const inviteCandidate = async ({
  candidateId,
  jobRequisitionId,
  tenantId,
} = {}) => {
  const { who } = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.update",
    allowedScopes: ["ORG"],
  });
  const lifecycle = await inviteToApply({
    tenantId,
    candidateId: Number(candidateId),
    jobRequisitionId: jobRequisitionId ?? null,
    actorId: who.id,
  });
  return {
    candidateId: Number(candidateId),
    invited: true,
    invitation: lifecycle.invitation,
    invitationReused: lifecycle.reused,
    pipeline: null,
  };
};
