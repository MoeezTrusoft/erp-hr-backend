// src/services/onboardingPortal.service.js — Onboarding "Preboarding Portal".
//
// Backs the pre-boarding readiness board, the new-hire feedback survey, and the
// notes / activity feed for a single OnboardingChecklist. Three concerns, one
// service so the checklist stays the single source of truth:
//
//   * preboarding readiness — the 4 grouped boolean checklists persisted on
//     OnboardingChecklist.preboarding (Json). readyToCollect is DERIVED = every
//     `readiness` + `itSetup` item is true.
//   * feedback — persisted as an OnboardingSurvey row (responses = { ratings,
//     comments }). SurveyType only carries DAY_30/DAY_60/DAY_90, so the "new
//     hire feedback" survey is stored under DAY_30 (the earliest touch-point);
//     the [checklistId, type] unique means submit is an UPSERT (create/append).
//   * notes / activity — appended to OnboardingChecklist.activityLog (Json
//     array of { at, actor, text }), same shape onboardingDetail.service uses.
//
// Tenant-scoped fail-closed via scopedWhere / scopedData (RBAC Company.uuid on
// tenantId). All checklist lookups 404 on a missing OR cross-tenant row.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// The canonical preboarding JSON shape. Every group key defaults to false when a
// stored blob omits it, so old/partial rows still normalise to a full board.
const PREBOARDING_GROUPS = {
  readiness: ["documentsReceived", "personalInfoComplete", "vpnAccessEnabled", "joiningDateConfirmed"],
  itSetup: ["companyEmailCreated", "systemAccessAssigned", "personalEmailComplete", "communicationToolSetup"],
  engagement: ["welcomeEmailSent", "introVideoWatched", "firstDayAgendaReviewed"],
  workspace: ["laptopAssigned", "idCardPrepared", "deskAllocated", "softwareInstalled", "accessoriesAllocated"],
};

// readyToCollect is derived from these groups only (all items true).
const READY_GROUPS = ["readiness", "itSetup"];

const FEEDBACK_SURVEY_TYPE = "DAY_30";

const notFound = () => {
  const err = new Error("Onboarding checklist not found");
  err.status = 404;
  return err;
};

const badRequest = (msg) => {
  const err = new Error(msg);
  err.status = 400;
  return err;
};

const toChecklistId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id)) throw badRequest("A valid checklist id is required");
  return id;
};

const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
  e?.preferred_name ||
  null;

// Normalise any stored blob into the canonical 4-group boolean board, defaulting
// missing keys to false and coercing stored values to strict booleans.
const normalizePreboarding = (stored) => {
  const src = stored && typeof stored === "object" ? stored : {};
  const out = {};
  for (const [group, keys] of Object.entries(PREBOARDING_GROUPS)) {
    const groupSrc = src[group] && typeof src[group] === "object" ? src[group] : {};
    out[group] = {};
    for (const key of keys) out[group][key] = groupSrc[key] === true;
  }
  return out;
};

const groupSummary = (preboarding, group) => {
  const keys = PREBOARDING_GROUPS[group];
  const done = keys.reduce((n, key) => n + (preboarding[group][key] ? 1 : 0), 0);
  return { done, total: keys.length };
};

const buildSummary = (preboarding) => {
  const readiness = groupSummary(preboarding, "readiness");
  const it = groupSummary(preboarding, "itSetup");
  const engagement = groupSummary(preboarding, "engagement");
  const workspace = groupSummary(preboarding, "workspace");
  const done = readiness.done + it.done + engagement.done + workspace.done;
  const total = readiness.total + it.total + engagement.total + workspace.total;
  return {
    readinessDone: readiness.done,
    readinessTotal: readiness.total,
    itDone: it.done,
    itTotal: it.total,
    engagementDone: engagement.done,
    engagementTotal: engagement.total,
    workspaceDone: workspace.done,
    workspaceTotal: workspace.total,
    overallPct: total === 0 ? 0 : Math.round((done / total) * 100),
  };
};

// readyToCollect = every item in the READY_GROUPS is true.
const deriveReadyToCollect = (preboarding) =>
  READY_GROUPS.every((group) => PREBOARDING_GROUPS[group].every((key) => preboarding[group][key] === true));

const shapePreboardingGet = (checklist) => {
  const preboarding = normalizePreboarding(checklist.preboarding);
  return {
    id: checklist.id,
    readyToCollect: !!checklist.readyToCollect,
    preboarding,
    summary: buildSummary(preboarding),
  };
};

/**
 * Tool 1 — read the preboarding board for a checklist.
 * @param {number|string} id  checklistId
 * @param {string|null|undefined} tenantId
 */
export const getPreboarding = async (id, tenantId) => {
  const checklistId = toChecklistId(id);
  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: checklistId }),
    select: { id: true, readyToCollect: true, preboarding: true },
  });
  if (!checklist) throw notFound();
  return shapePreboardingGet(checklist);
};

/**
 * Tool 2 — update the preboarding board, either a single { group, key, value }
 * toggle OR a full `preboarding` object. Merges into the stored blob, recomputes
 * readyToCollect, and returns the refreshed get-shape.
 * @param {object} input { id, group?, key?, value?, preboarding? }
 * @param {string|null|undefined} tenantId
 */
export const updatePreboarding = async (input, tenantId) => {
  const { id, group, key, value, preboarding } = input || {};
  const checklistId = toChecklistId(id);

  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: checklistId }),
    select: { id: true, preboarding: true },
  });
  if (!checklist) throw notFound();

  const current = normalizePreboarding(checklist.preboarding);
  let next;

  if (preboarding !== undefined) {
    if (preboarding === null || typeof preboarding !== "object" || Array.isArray(preboarding)) {
      throw badRequest("`preboarding` must be an object of the 4 groups");
    }
    // Full-object mode: normalise the caller blob against the canonical shape.
    next = normalizePreboarding(preboarding);
  } else {
    // Single-toggle mode.
    if (!PREBOARDING_GROUPS[group]) {
      throw badRequest("`group` must be one of readiness|itSetup|engagement|workspace");
    }
    if (!PREBOARDING_GROUPS[group].includes(key)) {
      throw badRequest(`\`key\` is not valid for group ${group}`);
    }
    if (typeof value !== "boolean") throw badRequest("`value` must be a boolean");
    next = { ...current, [group]: { ...current[group], [key]: value } };
  }

  const readyToCollect = deriveReadyToCollect(next);

  const updated = await prisma.onboardingChecklist.update({
    where: { id: checklist.id },
    data: { preboarding: next, readyToCollect },
    select: { id: true, readyToCollect: true, preboarding: true },
  });

  return shapePreboardingGet(updated);
};

/**
 * Tool 3 — submit new-hire feedback. Stored as an OnboardingSurvey row keyed by
 * [checklistId, FEEDBACK_SURVEY_TYPE]; upserted so a re-submit overwrites.
 * @param {object} input { checklistId, employeeId?, ratings, comments? }
 * @param {string|null|undefined} tenantId
 */
export const submitFeedback = async (input, tenantId) => {
  const { checklistId: rawChecklistId, employeeId, ratings, comments } = input || {};
  const checklistId = toChecklistId(rawChecklistId);

  if (!ratings || typeof ratings !== "object" || Array.isArray(ratings)) {
    throw badRequest("`ratings` object is required");
  }

  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: checklistId }),
    select: { id: true, employeeId: true },
  });
  if (!checklist) throw notFound();

  // employeeId defaults to the checklist's own new hire when the caller omits it.
  const empId =
    employeeId !== undefined && employeeId !== null && `${employeeId}`.trim() !== ""
      ? Number(employeeId)
      : checklist.employeeId;
  if (!Number.isInteger(empId)) throw badRequest("A valid employeeId is required");

  const submittedAt = new Date();
  const responses = { ratings, comments: comments ?? null };

  const created = await prisma.onboardingSurvey.upsert({
    where: { checklistId_type: { checklistId, type: FEEDBACK_SURVEY_TYPE } },
    update: { responses, submittedAt, ...scopedData(tenantId, {}) },
    create: scopedData(tenantId, {
      checklistId,
      employeeId: empId,
      type: FEEDBACK_SURVEY_TYPE,
      responses,
      submittedAt,
    }),
    select: {
      id: true,
      checklistId: true,
      employeeId: true,
      type: true,
      responses: true,
      submittedAt: true,
    },
  });

  return created;
};

/**
 * Tool 4 — view feedback surveys for a checklist, shaped for the FE feedback
 * table. Reads every survey on the checklist and parses responses.ratings.
 * @param {number|string} checklistId
 * @param {string|null|undefined} tenantId
 */
export const viewFeedback = async (checklistId, tenantId) => {
  const id = toChecklistId(checklistId);

  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id }),
    select: {
      id: true,
      employee: {
        select: {
          employee_name: true,
          first_name: true,
          last_name: true,
          preferred_name: true,
          job_title: true,
        },
      },
      surveys: {
        orderBy: { submittedAt: "desc" },
        select: { responses: true, submittedAt: true },
      },
    },
  });
  if (!checklist) throw notFound();

  const candidate = employeeName(checklist.employee);
  const role = checklist.employee?.job_title ?? null;

  return (checklist.surveys || []).map((survey) => {
    const responses = survey.responses && typeof survey.responses === "object" ? survey.responses : {};
    const ratings = responses.ratings && typeof responses.ratings === "object" ? responses.ratings : {};
    return {
      candidate,
      role,
      roleClarity: ratings.roleClarity ?? null,
      teamSupport: ratings.teamSupport ?? null,
      onboardingProcess: ratings.onboardingProcess ?? null,
      additionalComments: responses.comments ?? null,
      submittedAt: survey.submittedAt ?? null,
    };
  });
};

/**
 * Tool 5 — append a note to the checklist activityLog.
 * @param {object} input { checklistId, text, actor? }
 * @param {string|null|undefined} tenantId
 */
export const addNote = async (input, tenantId) => {
  const { checklistId, text, actor } = input || {};
  const id = toChecklistId(checklistId);

  if (typeof text !== "string" || !text.trim()) throw badRequest("`text` is required");

  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id }),
    select: { id: true, activityLog: true },
  });
  if (!checklist) throw notFound();

  const entry = {
    at: new Date().toISOString(),
    actor: actor ?? "system",
    text: text.trim(),
  };

  const log = Array.isArray(checklist.activityLog) ? checklist.activityLog : [];
  const updated = await prisma.onboardingChecklist.update({
    where: { id: checklist.id },
    data: { activityLog: [...log, entry] },
    select: { activityLog: true },
  });

  return Array.isArray(updated.activityLog) ? updated.activityLog : [];
};

// Day-bucket label for the activity feed. "Today" / "Yesterday" / else the ISO
// calendar date (YYYY-MM-DD) of the entry, computed in UTC for stable buckets.
const dayLabel = (at, now = new Date()) => {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "unknown";
  const dayStart = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diffDays = Math.round((dayStart(now) - dayStart(when)) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return when.toISOString().slice(0, 10);
};

/**
 * Tool 6 — list activityLog entries newest-first, plus a `grouped` field
 * bucketing entries by day label.
 * @param {number|string} checklistId
 * @param {string|null|undefined} tenantId
 */
export const listActivity = async (checklistId, tenantId) => {
  const id = toChecklistId(checklistId);

  const checklist = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id }),
    select: { id: true, activityLog: true },
  });
  if (!checklist) throw notFound();

  const entries = Array.isArray(checklist.activityLog) ? [...checklist.activityLog] : [];
  entries.sort((a, b) => {
    const ta = new Date(a?.at).getTime() || 0;
    const tb = new Date(b?.at).getTime() || 0;
    return tb - ta;
  });

  const now = new Date();
  const grouped = {};
  for (const entry of entries) {
    const label = dayLabel(entry?.at, now);
    (grouped[label] ||= []).push(entry);
  }

  return { entries, grouped };
};
