// src/services/engagement/ingest.service.js — normalises any communication
// into an EngagementEvent attached to one party, deduplicated per tenant, and
// marks the party profile for refresh.
//
// Sources:
//   * manual / staff notes and forms (hr_engagement_event_ingest)
//   * Communication thread timelines pushed by the frontend
//     (hr_engagement_thread_import — items as communication_thread_timeline
//     returns them: channel, direction, sender, recipient, subject, body,
//     occurredAt, sourceId, transcript)
//   * fabric events (comms.mail.received.v1 …) drained by jobs/engagement.queue.js
import { z } from "zod";

import { EVENT_CHANNELS, EVENT_DIRECTIONS, hash, json, toIso, uniq } from "./base.js";
import { EVENTS, emit } from "./events.js";
import { IdentitySchema, resolveParty } from "./party.service.js";

const ParticipantSchema = z.object({
  role: z.string().trim().max(40).optional(),
  name: z.string().trim().max(200).optional(),
  address: z.string().trim().max(320).optional(),
}).strict();

export const EventInputBaseSchema = z.object({
  partyId: z.string().uuid().optional(),
  resolve: z.object({
    emails: z.array(z.string()).max(10).optional(),
    phones: z.array(z.string()).max(10).optional(),
    identities: z.array(IdentitySchema).max(10).optional(),
    displayName: z.string().trim().max(200).optional(),
    role: z.string().optional(),
    organization: z.string().trim().max(200).optional(),
  }).optional(),
  channel: z.enum(EVENT_CHANNELS),
  direction: z.enum(EVENT_DIRECTIONS).default("INBOUND"),
  sourceSystem: z.string().trim().min(1).max(60).default("MANUAL"),
  sourceId: z.string().trim().max(300).optional(),
  sourceThreadId: z.string().trim().max(300).optional(),
  dedupeKey: z.string().trim().max(400).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  subject: z.string().trim().max(1000).optional(),
  body: z.string().max(200_000),
  participants: z.array(z.union([ParticipantSchema, z.string().max(320)])).max(50).default([]),
  attachments: z.array(z.object({
    id: z.string().max(300).optional(),
    name: z.string().max(300).optional(),
    mimeType: z.string().max(120).optional(),
    assetId: z.string().max(300).optional(),
  }).strict()).max(50).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const EventInputSchema = EventInputBaseSchema.refine((v) => v.partyId || v.resolve, { message: "partyId or resolve is required" });

const deriveDedupeKey = (input, partyId) => {
  if (input.dedupeKey) return input.dedupeKey;
  if (input.sourceId) return `${input.sourceSystem}:${input.channel}:${input.sourceId}`;
  return `hash:${hash({ partyId, channel: input.channel, occurredAt: input.occurredAt ?? null, body: input.body })}`;
};

export const toEventView = (row) =>
  row && {
    id: row.id,
    partyId: row.partyId,
    channel: row.channel,
    direction: row.direction,
    sourceSystem: row.sourceSystem,
    sourceId: row.sourceId ?? null,
    sourceThreadId: row.sourceThreadId ?? null,
    occurredAt: row.occurredAt,
    subject: row.subject ?? null,
    body: row.body,
    participants: row.participants ?? [],
    attachments: row.attachments ?? [],
    metadata: row.metadata ?? {},
    extractedAt: row.extractedAt ?? null,
    createdAt: row.createdAt,
  };

export async function markProfileDirty(tx, env, partyId, occurredAt) {
  const tenantId = env.tenantId;
  const at = occurredAt ? new Date(occurredAt) : new Date();
  const existing = await tx.engagementProfile.findUnique({ where: { tenantId_partyId: { tenantId, partyId } } });
  if (!existing) {
    return tx.engagementProfile.create({ data: { tenantId, partyId, refreshStatus: "QUEUED", lastEventAt: at } });
  }
  const lastEventAt = existing.lastEventAt && existing.lastEventAt > at ? existing.lastEventAt : at;
  return tx.engagementProfile.update({
    where: { id: existing.id },
    data: { lastEventAt, refreshStatus: existing.refreshStatus === "RUNNING" ? "RUNNING" : "QUEUED" },
  });
}

/** Ingest ONE event. Returns { event, duplicate, partyId }. */
export async function ingestEvent(tx, env, rawInput) {
  const input = EventInputSchema.parse(rawInput);
  const party = await resolveParty(tx, env, { partyId: input.partyId, ...(input.resolve ?? {}) });
  const dedupeKey = deriveDedupeKey(input, party.id);
  const existing = await tx.engagementEvent.findUnique({
    where: { tenantId_dedupeKey: { tenantId: env.tenantId, dedupeKey } },
  });
  if (existing) return { event: toEventView(existing), duplicate: true, partyId: party.id };

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const row = await tx.engagementEvent.create({
    data: {
      tenantId: env.tenantId,
      partyId: party.id,
      channel: input.channel,
      direction: input.direction,
      sourceSystem: input.sourceSystem,
      sourceId: input.sourceId ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
      dedupeKey,
      occurredAt,
      subject: input.subject ?? null,
      body: input.body,
      bodyHash: hash(input.body),
      participants: json(input.participants),
      attachments: json(input.attachments),
      metadata: json(input.metadata),
    },
  });
  await markProfileDirty(tx, env, party.id, occurredAt);
  await emit(tx, env, EVENTS.EVENT_INGESTED, {
    aggregateType: "EngagementEvent",
    aggregateId: row.id,
    payload: { partyId: party.id, eventId: row.id, channel: row.channel, occurredAt: toIso(occurredAt) },
  });
  return { event: toEventView(row), duplicate: false, partyId: party.id };
}

// ── Communication thread timeline import ──────────────────────────────────
const TimelineItemSchema = z.object({
  id: z.string().max(300).optional(),
  sourceId: z.string().max(300).optional(),
  channel: z.string().max(40),
  direction: z.string().max(20).optional(),
  actorType: z.string().max(20).optional(),
  sender: z.string().max(320).optional(),
  recipient: z.string().max(320).optional(),
  cc: z.array(z.string().max(320)).optional(),
  subject: z.string().max(1000).optional(),
  body: z.string().max(200_000).optional(),
  occurredAt: z.string().optional(),
  durationSec: z.number().optional(),
  disposition: z.string().max(60).optional(),
  transcript: z.union([z.string(), z.object({
    text: z.string().optional(),
    segments: z.array(z.object({ speaker: z.string().optional(), text: z.string().optional(), startMs: z.number().optional() })).optional(),
  }).passthrough()]).optional(),
  attachments: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), mimeType: z.string().optional() }).passthrough()).optional(),
}).passthrough();

export const ThreadImportSchema = z.object({
  partyId: z.string().uuid(),
  threadId: z.string().max(300).optional(),
  items: z.array(TimelineItemSchema).min(1).max(500),
});

const CHANNEL_MAP = Object.freeze({
  EMAIL: "EMAIL", MAIL: "EMAIL", SMS: "SMS", WEBCHAT: "WEBCHAT", CHAT: "CHAT", CALL: "CALL",
  FAX: "DOCUMENT", NOTE: "NOTE", SYSTEM: "SYSTEM", VOICEMAIL: "VOICEMAIL", MEETING: "MEETING",
});

const transcriptText = (transcript) => {
  if (!transcript) return "";
  if (typeof transcript === "string") return transcript;
  if (Array.isArray(transcript.segments) && transcript.segments.length) {
    return transcript.segments.map((s) => `${s.speaker || "speaker"}: ${s.text || ""}`.trim()).join("\n");
  }
  return transcript.text || "";
};

/** Map one communication_thread_timeline item to an EventInput. */
export function mapTimelineItem(item, { partyId, threadId }) {
  const channel = CHANNEL_MAP[String(item.channel || "").toUpperCase()] || "NOTE";
  const transcript = transcriptText(item.transcript);
  const isCallWithTranscript = channel === "CALL" && transcript;
  const bodyParts = [];
  if (item.body) bodyParts.push(item.body);
  if (isCallWithTranscript) bodyParts.push(`TRANSCRIPT:\n${transcript}`);
  if (channel === "CALL" && !transcript && item.disposition) bodyParts.push(`Call disposition: ${item.disposition}`);
  const participants = uniq([
    item.sender ? `from ${item.sender}` : null,
    item.recipient ? `to ${item.recipient}` : null,
    ...(item.cc ?? []).map((c) => `cc ${c}`),
  ]);
  const direction = ["INBOUND", "OUTBOUND", "INTERNAL"].includes(String(item.direction || "").toUpperCase())
    ? String(item.direction).toUpperCase()
    : item.actorType === "HUMAN" || item.actorType === "BOT" ? "OUTBOUND" : "INBOUND";
  return {
    partyId,
    channel: isCallWithTranscript ? "TRANSCRIPT" : channel,
    direction,
    sourceSystem: "COMMUNICATION_THREAD",
    sourceId: item.sourceId || item.id || undefined,
    sourceThreadId: threadId,
    occurredAt: toIso(item.occurredAt) ?? undefined,
    subject: item.subject || undefined,
    body: bodyParts.join("\n\n") || "(no content)",
    participants,
    attachments: (item.attachments ?? []).map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType })),
    metadata: { durationSec: item.durationSec ?? null, disposition: item.disposition ?? null, actorType: item.actorType ?? null },
  };
}

export async function importThreadTimeline(tx, env, rawInput) {
  const input = ThreadImportSchema.parse(rawInput);
  let imported = 0;
  let duplicates = 0;
  const eventIds = [];
  for (const item of input.items) {
    const mapped = mapTimelineItem(item, { partyId: input.partyId, threadId: input.threadId });
    const result = await ingestEvent(tx, env, mapped);
    if (result.duplicate) duplicates += 1;
    else {
      imported += 1;
      eventIds.push(result.event.id);
    }
  }
  return { partyId: input.partyId, imported, duplicates, eventIds };
}

export async function listEvents(tx, env, { partyId, channel, limit = 50, before } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = { tenantId: env.tenantId, partyId };
  if (channel) where.channel = channel;
  if (before) where.occurredAt = { lt: new Date(before) };
  const rows = await tx.engagementEvent.findMany({ where, orderBy: { occurredAt: "desc" }, take: take + 1 });
  const page = rows.slice(0, take);
  return {
    items: page.map(toEventView),
    nextCursor: rows.length > take ? toIso(page[page.length - 1].occurredAt) : null,
  };
}
