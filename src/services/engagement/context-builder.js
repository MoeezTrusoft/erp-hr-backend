// src/services/engagement/context-builder.js — assembles the counterparty
// context bundle (party + profile + active facts + a token-budgeted window of
// events) and renders it as the volatile part of an LLM prompt.
//
// Budgeting: newest events first until `tokenBudget` is spent, then the list
// is re-ordered chronologically and indexed so the model can cite "[#i]".
import { estimateTokens, toIso, truncate } from "./base.js";
import { redactEvent } from "./redaction.js";

export const DEFAULT_EVENT_LIMIT = 60;
export const DEFAULT_TOKEN_BUDGET = 60_000;
export const MAX_EVENT_BODY_CHARS = 12_000;

export async function loadProfile(tx, env, partyId) {
  return tx.engagementProfile.findUnique({ where: { tenantId_partyId: { tenantId: env.tenantId, partyId } } });
}

export async function loadActiveFacts(tx, env, partyId) {
  return tx.engagementFact.findMany({
    where: { tenantId: env.tenantId, partyId, status: "ACTIVE" },
    orderBy: [{ kind: "asc" }, { key: "asc" }, { extractedAt: "desc" }],
  });
}

/**
 * @param {object} opts
 * @param {boolean} [opts.onlyUnextracted] select events not yet folded into the profile
 * @param {number}  [opts.eventLimit]
 * @param {number}  [opts.tokenBudget]
 */
export async function loadEventWindow(tx, env, partyId, opts = {}) {
  const limit = Math.min(Math.max(opts.eventLimit ?? DEFAULT_EVENT_LIMIT, 1), 500);
  const where = { tenantId: env.tenantId, partyId };
  if (opts.onlyUnextracted) where.extractedAt = null;
  if (opts.eventIds?.length) where.id = { in: opts.eventIds };
  const rows = await tx.engagementEvent.findMany({ where, orderBy: { occurredAt: "desc" }, take: limit });
  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  let spent = 0;
  const kept = [];
  for (const row of rows) {
    const body = truncate(row.body, MAX_EVENT_BODY_CHARS);
    const cost = estimateTokens(body) + estimateTokens(row.subject) + 40;
    if (kept.length && spent + cost > budget) break;
    spent += cost;
    kept.push({ ...row, body });
  }
  return kept.reverse().map(redactEvent);
}

export async function buildContextBundle(tx, env, party, opts = {}) {
  const [profile, facts, events] = await Promise.all([
    loadProfile(tx, env, party.id),
    loadActiveFacts(tx, env, party.id),
    loadEventWindow(tx, env, party.id, opts),
  ]);
  return { party, profile, facts, events };
}

const participantLine = (participants) =>
  Array.isArray(participants) && participants.length
    ? participants.map((p) => (typeof p === "string" ? p : [p.role, p.name, p.address].filter(Boolean).join(" "))).join(", ")
    : "";

export function renderEvent(event, index) {
  const header = [
    `[#${index}]`,
    toIso(event.occurredAt) ?? "unknown-time",
    event.channel,
    event.direction,
    event.sourceSystem ? `via ${event.sourceSystem}` : "",
  ].filter(Boolean).join(" ");
  const who = participantLine(event.participants);
  const lines = [header];
  if (who) lines.push(`participants: ${who}`);
  if (event.subject) lines.push(`subject: ${event.subject}`);
  if (Array.isArray(event.attachments) && event.attachments.length) {
    lines.push(`attachments: ${event.attachments.map((a) => a?.name || a?.id || "file").join(", ")}`);
  }
  lines.push(event.body || "(no body)");
  return lines.join("\n");
}

export function renderParty(party) {
  return JSON.stringify({
    displayName: party.displayName,
    kind: party.kind,
    role: party.role,
    stage: party.stage,
    organization: party.organization ?? null,
    emails: party.emails ?? [],
    phones: party.phones ?? [],
    tags: party.tags ?? [],
    timezone: party.timezone ?? null,
    locale: party.locale ?? null,
  });
}

export function renderFacts(facts) {
  if (!facts?.length) return "(none)";
  return facts.map((f) => `- ${f.kind} ${f.key} = ${f.value} (confidence ${Number(f.confidence).toFixed(2)})`).join("\n");
}

/** The volatile user-message text for any purpose. */
export function renderContext(bundle, { eventsLabel = "EVENTS (chronological)" } = {}) {
  const { party, profile, facts, events } = bundle;
  return [
    `PARTY\n${renderParty(party)}`,
    `CURRENT PROFILE (version ${profile?.version ?? 0})\n${JSON.stringify(profile?.structured ?? {})}`,
    `CURRENT SUMMARY\n${profile?.summary || "(none yet)"}`,
    `ACTIVE FACTS\n${renderFacts(facts)}`,
    `${eventsLabel}\n${events.length ? events.map(renderEvent).join("\n\n") : "(no events)"}`,
  ].join("\n\n");
}
