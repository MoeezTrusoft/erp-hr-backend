// src/services/onboardingPortal.service.js — Onboarding "Preboarding Portal".
//
// Backs the pre-boarding readiness board, the new-hire feedback survey, and the
// notes / activity feed for a single OnboardingChecklist. Three concerns, one
// service so the checklist stays the single source of truth:
//
//   * preboarding readiness — the 4 grouped boolean checklists persisted on
//     OnboardingChecklist.preboarding (Json). readyToCollect is DERIVED = every
//     `readiness` + `itSetup` item is true.
//   * feedback uses the owned canonical portal questionnaire.
//   * notes / activity — appended to OnboardingChecklist.activityLog (Json
//     array of { at, actor, text }), same shape onboardingDetail.service uses.
//
// Tenant-scoped fail-closed via scopedWhere / scopedData (RBAC Company.uuid on
// tenantId). All checklist lookups 404 on a missing OR cross-tenant row.
import { randomUUID } from "node:crypto";
import {
  runOnboardingManagement,
  managementChecklist,
  onboardingFailure,
} from "./onboardingManagement.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { ONBOARDING_FEEDBACK_QUESTIONS } from "../lib/onboardingTaxonomy.js";
import { submitPortalFeedback } from "./onboardingPortalScreen.service.js";

// The canonical preboarding JSON shape. Every group key defaults to false when a
// stored blob omits it, so old/partial rows still normalise to a full board.
const PREBOARDING_GROUPS = {
  readiness: [
    "documentsReceived",
    "personalInfoComplete",
    "vpnAccessEnabled",
    "joiningDateConfirmed",
  ],
  itSetup: [
    "companyEmailCreated",
    "systemAccessAssigned",
    "personalEmailComplete",
    "communicationToolSetup",
  ],
  engagement: [
    "welcomeEmailSent",
    "introVideoWatched",
    "firstDayAgendaReviewed",
  ],
  workspace: [
    "laptopAssigned",
    "idCardPrepared",
    "deskAllocated",
    "softwareInstalled",
    "accessoriesAllocated",
  ],
};

// readyToCollect is derived from these groups only (all items true).
const READY_GROUPS = ["readiness", "itSetup"];

const badRequest = (msg) => {
  const err = new Error(msg);
  err.status = 400;
  return err;
};

const toChecklistId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id))
    throw badRequest("A valid checklist id is required");
  return id;
};

// Normalise any stored blob into the canonical 4-group boolean board, defaulting
// missing keys to false and coercing stored values to strict booleans.
const normalizePreboarding = (stored) => {
  const src = stored && typeof stored === "object" ? stored : {};
  const out = {};
  for (const [group, keys] of Object.entries(PREBOARDING_GROUPS)) {
    const groupSrc =
      src[group] && typeof src[group] === "object" ? src[group] : {};
    out[group] = {};
    for (const key of keys) out[group][key] = groupSrc[key] === true;
  }
  return out;
};

const groupSummary = (preboarding, group) => {
  const keys = PREBOARDING_GROUPS[group];
  const done = keys.reduce(
    (n, key) => n + (preboarding[group][key] ? 1 : 0),
    0,
  );
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
  READY_GROUPS.every((group) =>
    PREBOARDING_GROUPS[group].every((key) => preboarding[group][key] === true),
  );

const shapePreboardingGet = (checklist) => {
  const preboarding = normalizePreboarding(checklist.preboarding);
  return {
    id: checklist.id,
    readyToCollect: deriveReadyToCollect(preboarding),
    preboarding,
    summary: buildSummary(preboarding),
  };
};

/**
 * Tool 1 — read the preboarding board for a checklist.
 * @param {number|string} id  checklistId
 * @param {string|null|undefined} tenantId
 */
export const getPreboarding = (id, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) =>
    shapePreboardingGet(await managementChecklist(tx, env, id)),
  );

/**
 * Tool 2 — update the preboarding board, either a single { group, key, value }
 * toggle OR a full `preboarding` object. Merges into the stored blob, recomputes
 * readyToCollect, and returns the refreshed get-shape.
 * @param {object} input { id, group?, key?, value?, preboarding? }
 * @param {string|null|undefined} tenantId
 */
export const updatePreboarding = (input, tenantId) =>
  runOnboardingManagement(tenantId, "PUT", async (tx, env) => {
    const checklist = await managementChecklist(tx, env, input.id, {
      lock: true,
    });
    const current = normalizePreboarding(checklist.preboarding),
      next = structuredClone(current);
    if (input.preboarding !== undefined) {
      const source = input.preboarding;
      if (!source || typeof source !== "object" || Array.isArray(source))
        throw badRequest("Invalid preboarding groups");
      for (const [group, values] of Object.entries(source)) {
        if (
          !PREBOARDING_GROUPS[group] ||
          !values ||
          typeof values !== "object" ||
          Array.isArray(values)
        )
          throw badRequest("Unknown preboarding group");
        for (const [key, value] of Object.entries(values)) {
          if (
            !PREBOARDING_GROUPS[group].includes(key) ||
            typeof value !== "boolean"
          )
            throw badRequest("Invalid preboarding item");
          next[group][key] = value;
        }
      }
    } else {
      if (
        !PREBOARDING_GROUPS[input.group]?.includes(input.key) ||
        typeof input.value !== "boolean"
      )
        throw badRequest("Invalid preboarding item");
      next[input.group][input.key] = input.value;
    }
    const updated = await tx.onboardingChecklist.update({
      where: { id: checklist.id },
      data: { preboarding: next, readyToCollect: deriveReadyToCollect(next) },
    });
    await changed(tx, env, checklist, "READINESS_UPDATED");
    return shapePreboardingGet(updated);
  });

/**
 * Tool 3 — submit new-hire feedback. Stored as an OnboardingSurvey row keyed by
 * [checklistId, FEEDBACK_SURVEY_TYPE]; upserted so a re-submit overwrites.
 * @param {object} input { checklistId, employeeId?, ratings, comments? }
 * @param {string|null|undefined} tenantId
 */
export const submitFeedback = async (input, tenantId) => {
  // General onboarding feedback must not overwrite a timed milestone survey.
  // Keep this transport adapter, but enforce the same employee ownership and
  // canonical questionnaire as the employee portal.
  if (!Array.isArray(input?.answers))
    throw badRequest(
      "Use the current onboarding questionnaire and answer every question",
    );
  return submitPortalFeedback({
    tenantId,
    checklistId: input.checklistId,
    employeeId: input.employeeId,
    answers: input.answers,
    comments: input.comments,
  });
};

/**
 * Tool 4 — view feedback surveys for a checklist, shaped for the FE feedback
 * table. Reads every survey on the checklist and parses responses.ratings.
 * @param {number|string} checklistId
 * @param {string|null|undefined} tenantId
 */
export const viewFeedback = (checklistId, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const c = await managementChecklist(tx, env, checklistId);
    const where = { tenantId, checklistId: c.id, employeeId: c.employeeId };
    const general = await tx.onboardingFeedback.findFirst({ where });
    const surveys = await tx.onboardingSurvey.findMany({
      where: { ...where, submittedAt: { not: null } },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    });
    const submissions = [
      ...(general
        ? [
            {
              id: general.id,
              type: "GENERAL",
              answers: general.responses,
              comments: general.comments,
              submittedAt: general.submittedAt,
            },
          ]
        : []),
      ...surveys.map((r) => ({
        id: r.id,
        type: r.type,
        answers: r.responses?.answers || [],
        comments: r.responses?.comments || null,
        submittedAt: r.submittedAt,
      })),
    ];
    return {
      checklistId: c.id,
      questions: ONBOARDING_FEEDBACK_QUESTIONS,
      submissions,
    };
  });
async function changed(tx, env, c, action) {
  const event = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    actorId: String(env.who.id),
    actorType: "user",
    eventName: "hr.onboarding.checklist_changed.v1",
    aggregateType: "OnboardingChecklist",
    aggregateId: String(c.id),
    payload: {
      checklistId: String(c.id),
      employeeId: String(c.employeeId),
      actorId: String(env.who.id),
      action,
    },
  });
  if (!event) onboardingFailure("Onboarding event could not be saved", 503);
}
export const addNote = (input, tenantId) =>
  runOnboardingManagement(tenantId, "PUT", async (tx, env) => {
    if (
      typeof input?.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 4000
    )
      throw badRequest("Note must contain 1–4000 characters");
    const c = await managementChecklist(tx, env, input.checklistId, {
      lock: true,
    });
    const log = Array.isArray(c.activityLog) ? c.activityLog : [];
    const key = input.idempotencyKey;
    if (
      key != null &&
      (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
    )
      throw badRequest("Invalid note request key");
    const old =
      key && log.find((e) => e.kind === "NOTE" && e.requestKey === key);
    if (old) {
      if (old.text !== input.text.trim())
        onboardingFailure(
          "Request key was already used for a different note",
          409,
        );
      return log.map(({ requestKey, requestHash, ...item }) => item);
    }
    const next = [
      ...log,
      {
        id: randomUUID(),
        kind: "NOTE",
        at: new Date().toISOString(),
        actor: String(env.who.id),
        text: input.text.trim(),
        ...(key ? { requestKey: key } : {}),
      },
    ];
    await tx.onboardingChecklist.update({
      where: { id: c.id },
      data: { activityLog: next },
    });
    await changed(tx, env, c, "NOTE_ADDED");
    return next.map(({ requestKey, requestHash, ...item }) => item);
  });

// Day-bucket label for the activity feed. "Today" / "Yesterday" / else the ISO
// calendar date (YYYY-MM-DD) of the entry, computed in UTC for stable buckets.
const dayLabel = (at, now = new Date()) => {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "unknown";
  const dayStart = (d) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
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
export const listActivity = (checklistId, tenantId) =>
  runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const checklist = await managementChecklist(
      tx,
      env,
      toChecklistId(checklistId),
    );
    const entries = (
      Array.isArray(checklist.activityLog) ? checklist.activityLog : []
    )
      .filter((e) => e && typeof e === "object")
      .map(({ requestKey, requestHash, ...e }) => e)
      .sort((a, b) => (+new Date(b.at) || 0) - (+new Date(a.at) || 0));
    const grouped = {};
    for (const e of entries) (grouped[dayLabel(e.at)] ||= []).push(e);
    return { entries, grouped };
  });
