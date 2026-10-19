// src/services/engagement/profile.service.js — the living context profile.
//
// refreshProfile() folds every not-yet-extracted event into the profile with
// ONE structured LLM call: facts (with supersede semantics) + merged profile +
// summary + next best actions. The profile version increments per refresh;
// facts record the profileVersion they were extracted at and the source
// event, so every claim is traceable to a message.
import { z } from "zod";

import { FACT_KINDS, FACT_STATUSES, fail, json, toIso } from "./base.js";
import { recordRun, runStructured } from "./claude.client.js";
import { buildContextBundle, loadActiveFacts, loadProfile, renderContext } from "./context-builder.js";
import { EVENTS, emit } from "./events.js";
import { getPartyOrFail } from "./party.service.js";
import { ContextProfileSchema, ExtractionOutputSchema, SYSTEM_EXTRACTION } from "./prompts.js";

export const toProfileView = (row, party) =>
  ({
    partyId: party?.id ?? row?.partyId ?? null,
    version: row?.version ?? 0,
    summary: row?.summary ?? "",
    structured: row?.structured ?? {},
    model: row?.model ?? null,
    lastEventAt: row?.lastEventAt ?? null,
    lastRefreshedAt: row?.lastRefreshedAt ?? null,
    eventsAtRefresh: row?.eventsAtRefresh ?? 0,
    refreshStatus: row?.refreshStatus ?? "IDLE",
    lastError: row?.lastError ?? null,
  });

export const toFactView = (row) =>
  row && {
    id: row.id,
    partyId: row.partyId,
    profileVersion: row.profileVersion,
    kind: row.kind,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    status: row.status,
    sourceEventId: row.sourceEventId ?? null,
    supersededById: row.supersededById ?? null,
    extractedAt: row.extractedAt,
  };

export async function getProfile(tx, env, partyId) {
  const party = await getPartyOrFail(tx, env, partyId);
  const [profile, facts, pendingEvents] = await Promise.all([
    loadProfile(tx, env, partyId),
    loadActiveFacts(tx, env, partyId),
    tx.engagementEvent.count({ where: { tenantId: env.tenantId, partyId, extractedAt: null } }),
  ]);
  return { profile: toProfileView(profile, party), facts: facts.map(toFactView), pendingEvents };
}

export const FactListSchema = z.object({
  partyId: z.string().uuid(),
  status: z.enum(FACT_STATUSES).optional(),
  kind: z.enum(FACT_KINDS).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export async function listFacts(tx, env, rawInput) {
  const input = FactListSchema.parse(rawInput);
  const where = { tenantId: env.tenantId, partyId: input.partyId };
  if (input.status) where.status = input.status;
  if (input.kind) where.kind = input.kind;
  const rows = await tx.engagementFact.findMany({ where, orderBy: [{ status: "asc" }, { kind: "asc" }, { key: "asc" }, { extractedAt: "desc" }], take: input.limit ?? 200 });
  return { items: rows.map(toFactView), nextCursor: null };
}

export const FactUpdateSchema = z.object({
  factId: z.string().uuid(),
  value: z.string().trim().min(1).max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(["ACTIVE", "RETRACTED"]).optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Staff correction: edit a fact value (creates a superseding fact) or retract it. */
export async function updateFact(tx, env, rawInput) {
  const input = FactUpdateSchema.parse(rawInput);
  const fact = await tx.engagementFact.findFirst({ where: { tenantId: env.tenantId, id: input.factId } });
  if (!fact) fail("HR-4700", "Fact not found", 404);
  if (input.status === "RETRACTED") {
    const row = await tx.engagementFact.update({ where: { id: fact.id }, data: { status: "RETRACTED" } });
    await touchProfileForManualChange(tx, env, fact.partyId);
    return toFactView(row);
  }
  if (input.value == null && input.confidence == null) return toFactView(fact);
  const replacement = await tx.engagementFact.create({
    data: {
      tenantId: env.tenantId,
      partyId: fact.partyId,
      profileVersion: fact.profileVersion,
      kind: fact.kind,
      key: fact.key,
      value: input.value ?? fact.value,
      confidence: input.confidence ?? 1,
      status: "ACTIVE",
      sourceEventId: fact.sourceEventId,
    },
  });
  await tx.engagementFact.update({ where: { id: fact.id }, data: { status: "SUPERSEDED", supersededById: replacement.id } });
  await touchProfileForManualChange(tx, env, fact.partyId);
  return toFactView(replacement);
}

async function touchProfileForManualChange(tx, env, partyId) {
  const profile = await loadProfile(tx, env, partyId);
  if (profile) await tx.engagementProfile.update({ where: { id: profile.id }, data: { refreshStatus: "QUEUED" } });
}

const SUPERSEDE_LIMIT = 500;

/**
 * Refresh the profile of one party from its unextracted events.
 * @param {object} opts
 * @param {boolean} [opts.force] re-read the recent window even when nothing is pending
 * @returns the refreshed profile view + counts
 */
export async function refreshProfile(tx, env, partyId, opts = {}) {
  const party = await getPartyOrFail(tx, env, partyId);
  const tenantId = env.tenantId;
  let profile = await loadProfile(tx, env, partyId);
  if (!profile) profile = await tx.engagementProfile.create({ data: { tenantId, partyId } });

  const bundle = await buildContextBundle(tx, env, party, {
    onlyUnextracted: !opts.force,
    eventLimit: opts.eventLimit,
    tokenBudget: opts.tokenBudget,
  });
  if (!bundle.events.length && !opts.force) {
    if (profile.refreshStatus !== "IDLE") {
      profile = await tx.engagementProfile.update({ where: { id: profile.id }, data: { refreshStatus: "IDLE" } });
    }
    return { profile: toProfileView(profile, party), newFacts: 0, supersededFacts: 0, eventsProcessed: 0, skipped: true };
  }

  await tx.engagementProfile.update({ where: { id: profile.id }, data: { refreshStatus: "RUNNING", lastError: null } });

  const messages = [{
    role: "user",
    content: `${renderContext({ ...bundle, profile }, { eventsLabel: "NEW EVENTS (chronological, indexed)" })}\n\nUpdate the profile from the NEW EVENTS. Today's date for relative dates: ${toIso(new Date()).slice(0, 10)}.`,
  }];
  const { output, run, error } = await runStructured({ purpose: "EXTRACT", system: SYSTEM_EXTRACTION, messages, schema: ExtractionOutputSchema });
  const runId = await recordRun(tx, { tenantId, partyId }, run);
  if (error) {
    await tx.engagementProfile.update({ where: { id: profile.id }, data: { refreshStatus: "FAILED", lastError: error.code } });
    throw error;
  }

  const nextVersion = (profile.version ?? 0) + 1;
  const activeFacts = await loadActiveFacts(tx, env, partyId);
  const activeByKey = new Map(activeFacts.map((f) => [f.key, f]));
  let supersededFacts = 0;
  let newFacts = 0;
  for (const fact of output.facts.slice(0, SUPERSEDE_LIMIT)) {
    const sourceEvent = fact.sourceEventIndex != null ? bundle.events[fact.sourceEventIndex] : null;
    const created = await tx.engagementFact.create({
      data: {
        tenantId,
        partyId,
        profileVersion: nextVersion,
        kind: fact.kind,
        key: fact.key,
        value: fact.value,
        confidence: fact.confidence,
        status: "ACTIVE",
        sourceEventId: sourceEvent?.id ?? null,
      },
    });
    newFacts += 1;
    const supersededKey = fact.supersedesKey || (activeByKey.has(fact.key) ? fact.key : null);
    const previous = supersededKey ? activeByKey.get(supersededKey) : null;
    if (previous && previous.id !== created.id) {
      await tx.engagementFact.update({ where: { id: previous.id }, data: { status: "SUPERSEDED", supersededById: created.id } });
      activeByKey.delete(supersededKey);
      supersededFacts += 1;
    }
    activeByKey.set(fact.key, created);
  }

  const structured = json({ ...ContextProfileSchema.parse(output.profile), nextBestActions: output.nextBestActions });
  const lastEventAt = bundle.events.reduce((max, e) => (!max || e.occurredAt > max ? e.occurredAt : max), profile.lastEventAt);
  const updated = await tx.engagementProfile.update({
    where: { id: profile.id },
    data: {
      version: nextVersion,
      summary: output.summary,
      structured,
      model: run.model,
      refreshStatus: "IDLE",
      lastError: null,
      lastRefreshedAt: new Date(),
      lastEventAt,
      eventsAtRefresh: { increment: bundle.events.length },
    },
  });
  await tx.engagementEvent.updateMany({
    where: { tenantId, id: { in: bundle.events.map((e) => e.id) } },
    data: { extractedAt: new Date() },
  });
  const stage = structured.relationship?.stage;
  await emit(tx, env, EVENTS.PROFILE_REFRESHED, {
    aggregateType: "EngagementProfile",
    aggregateId: updated.id,
    payload: { partyId, profileVersion: nextVersion, llmRunId: runId, sentiment: structured.relationship?.sentiment ?? "UNKNOWN", stage: stage ?? null },
  });
  return { profile: toProfileView(updated, party), newFacts, supersededFacts, eventsProcessed: bundle.events.length, skipped: false, llmRunId: runId };
}
