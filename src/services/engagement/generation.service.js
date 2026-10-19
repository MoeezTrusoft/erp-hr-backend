// src/services/engagement/generation.service.js — grounded content drafts
// (emails, SMS, chat replies, quotations, proposals, NDAs, contracts,
// editorial assessments, meeting summaries, project and handover briefs).
// Every draft stores the profile version and the event ids it was grounded
// in, plus the LLM run id, so a reviewer can audit what the model saw.
import { z } from "zod";

import { DOCUMENT_FORMATS, DOCUMENT_KINDS, DOCUMENT_STATUSES, DOCUMENT_TRANSITIONS, fail, json, toIso } from "./base.js";
import { recordRun, runStructured } from "./claude.client.js";
import { buildContextBundle, renderContext } from "./context-builder.js";
import { EVENTS, emit } from "./events.js";
import { getPartyOrFail } from "./party.service.js";
import { DOCUMENT_TEMPLATES, GenerationOutputSchema, SYSTEM_GENERATION } from "./prompts.js";

export const GenerateInputSchema = z.object({
  partyId: z.string().uuid(),
  kind: z.enum(DOCUMENT_KINDS),
  instructions: z.string().trim().max(8000).optional(),
  format: z.enum(DOCUMENT_FORMATS).optional(),
  language: z.string().trim().max(40).optional(),
  tone: z.string().trim().max(120).optional(),
  replyToEventId: z.string().uuid().optional(),
  eventLimit: z.number().int().min(1).max(200).optional(),
  requestKey: z.string().trim().min(8).max(200).optional(),
});

export const toDocumentView = (row) =>
  row && {
    id: row.id,
    partyId: row.partyId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    format: row.format,
    structured: row.structured ?? {},
    instructions: row.instructions ?? null,
    profileVersion: row.profileVersion,
    sourceEventIds: row.sourceEventIds ?? [],
    llmRunId: row.llmRunId ?? null,
    version: row.version,
    createdByUserId: row.createdByUserId ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    approvedAt: row.approvedAt ?? null,
    sentAt: row.sentAt ?? null,
    deliveryRef: row.deliveryRef ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

export async function generateDocument(tx, env, rawInput) {
  const input = GenerateInputSchema.parse(rawInput);
  const party = await getPartyOrFail(tx, env, input.partyId);
  const template = DOCUMENT_TEMPLATES[input.kind];
  const bundle = await buildContextBundle(tx, env, party, { eventLimit: input.eventLimit });
  const replyTarget = input.replyToEventId ? bundle.events.findIndex((e) => e.id === input.replyToEventId) : -1;
  const format = input.format || template.format;
  const brief = [
    `DOCUMENT KIND: ${input.kind}`,
    `REQUIRED FORMAT: ${format}`,
    `TEMPLATE GUIDANCE: ${template.guidance}`,
    input.language ? `LANGUAGE: ${input.language}` : null,
    input.tone ? `TONE: ${input.tone}` : null,
    replyTarget >= 0 ? `THIS IS A REPLY TO EVENT [#${replyTarget}].` : null,
    input.instructions ? `STAFF INSTRUCTIONS:\n${input.instructions}` : "STAFF INSTRUCTIONS: (none)",
    `Today's date: ${toIso(new Date()).slice(0, 10)}.`,
  ].filter(Boolean).join("\n");
  const messages = [{ role: "user", content: `${renderContext(bundle)}\n\n${brief}` }];

  const { output, run, error } = await runStructured({ purpose: "GENERATE", system: SYSTEM_GENERATION, messages, schema: GenerationOutputSchema });
  const runId = await recordRun(tx, { tenantId: env.tenantId, partyId: party.id }, run);
  if (error) throw error;

  const usedEventIds = output.usedEventIndexes.map((i) => bundle.events[i]?.id).filter(Boolean);
  const row = await tx.engagementDocument.create({
    data: {
      tenantId: env.tenantId,
      partyId: party.id,
      kind: input.kind,
      status: "DRAFT",
      title: output.title,
      body: output.body,
      format: output.format || format,
      structured: json({ ...output.structured, assumptions: output.assumptions, missingInformation: output.missingInformation, suggestedSubject: output.suggestedSubject }),
      instructions: input.instructions ?? null,
      profileVersion: bundle.profile?.version ?? 0,
      sourceEventIds: usedEventIds.length ? usedEventIds : bundle.events.map((e) => e.id),
      llmRunId: runId,
      createdByUserId: env.user?.userId != null ? String(env.user.userId) : null,
    },
  });
  await emit(tx, env, EVENTS.DOCUMENT_GENERATED, {
    aggregateType: "EngagementDocument",
    aggregateId: row.id,
    payload: { partyId: party.id, documentId: row.id, kind: row.kind, llmRunId: runId },
  });
  return toDocumentView(row);
}

export async function getDocumentOrFail(tx, env, documentId) {
  const row = await tx.engagementDocument.findFirst({ where: { tenantId: env.tenantId, id: documentId } });
  if (!row) fail("HR-4702", "Document not found", 404);
  return row;
}

export const DocumentListSchema = z.object({
  partyId: z.string().uuid().optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function listDocuments(tx, env, rawInput = {}) {
  const input = DocumentListSchema.parse(rawInput);
  const where = { tenantId: env.tenantId };
  if (input.partyId) where.partyId = input.partyId;
  if (input.kind) where.kind = input.kind;
  if (input.status) where.status = input.status;
  const rows = await tx.engagementDocument.findMany({ where, orderBy: { createdAt: "desc" }, take: input.limit ?? 50 });
  return { items: rows.map(toDocumentView), nextCursor: null };
}

export const DocumentUpdateSchema = z.object({
  documentId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().min(1).optional(),
  structured: z.record(z.string(), z.unknown()).optional(),
});

/** Staff edit of a draft (versioned). Only DRAFT/REVIEWED documents are editable. */
export async function updateDocument(tx, env, rawInput) {
  const input = DocumentUpdateSchema.parse(rawInput);
  const current = await getDocumentOrFail(tx, env, input.documentId);
  if (!["DRAFT", "REVIEWED"].includes(current.status)) fail("HR-4710", `A ${current.status} document cannot be edited`, 409);
  if (current.version !== input.expectedVersion) fail("HR-4707", "Document was modified by another writer", 412, { currentVersion: current.version });
  const data = { version: { increment: 1 } };
  if (input.title !== undefined) data.title = input.title;
  if (input.body !== undefined) data.body = input.body;
  if (input.structured !== undefined) data.structured = json(input.structured);
  const result = await tx.engagementDocument.updateMany({ where: { tenantId: env.tenantId, id: current.id, version: current.version }, data });
  if (!result?.count) fail("HR-4707", "Document was modified by another writer", 412, { currentVersion: current.version + 1 });
  return toDocumentView(await getDocumentOrFail(tx, env, current.id));
}

export const DocumentTransitionSchema = z.object({
  documentId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  to: z.enum(DOCUMENT_STATUSES),
  deliveryRef: z.string().trim().max(300).optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Explicit state machine. SENT records the delivery reference the caller got
 * from the channel tool it used (communication_mail_send / communication_sms_send
 * / sales_message_create); the engine never sends on its own.
 */
export async function transitionDocument(tx, env, rawInput) {
  const input = DocumentTransitionSchema.parse(rawInput);
  const current = await getDocumentOrFail(tx, env, input.documentId);
  if (!DOCUMENT_TRANSITIONS[current.status].includes(input.to)) {
    fail("HR-4710", `Cannot move a ${current.status} document to ${input.to}`, 409);
  }
  if (current.version !== input.expectedVersion) fail("HR-4707", "Document was modified by another writer", 412, { currentVersion: current.version });
  const userId = env.user?.userId != null ? String(env.user.userId) : null;
  const data = { status: input.to, version: { increment: 1 } };
  if (input.to === "APPROVED") Object.assign(data, { approvedByUserId: userId, approvedAt: new Date() });
  if (input.to === "SENT") Object.assign(data, { sentAt: new Date(), deliveryRef: input.deliveryRef ?? null });
  const result = await tx.engagementDocument.updateMany({ where: { tenantId: env.tenantId, id: current.id, version: current.version }, data });
  if (!result?.count) fail("HR-4707", "Document was modified by another writer", 412, { currentVersion: current.version + 1 });
  const row = await getDocumentOrFail(tx, env, current.id);
  if (input.to === "SENT") {
    // A sent document is itself part of the communication record.
    await tx.engagementEvent.create({
      data: {
        tenantId: env.tenantId,
        partyId: row.partyId,
        channel: row.kind === "SMS" ? "SMS" : row.kind === "EMAIL" ? "EMAIL" : row.kind === "CHAT_REPLY" ? "WEBCHAT" : "DOCUMENT",
        direction: "OUTBOUND",
        sourceSystem: "ENGAGEMENT_DOCUMENT",
        sourceId: row.id,
        dedupeKey: `ENGAGEMENT_DOCUMENT:${row.id}:SENT`,
        occurredAt: row.sentAt ?? new Date(),
        subject: row.title,
        body: row.body,
        bodyHash: row.id,
        participants: [],
        attachments: [],
        metadata: { documentKind: row.kind, deliveryRef: row.deliveryRef ?? null },
      },
    });
    const profile = await tx.engagementProfile.findUnique({ where: { tenantId_partyId: { tenantId: env.tenantId, partyId: row.partyId } } });
    if (profile) await tx.engagementProfile.update({ where: { id: profile.id }, data: { refreshStatus: "QUEUED", lastEventAt: row.sentAt ?? new Date() } });
  }
  await emit(tx, env, EVENTS.DOCUMENT_TRANSITIONED, {
    aggregateType: "EngagementDocument",
    aggregateId: row.id,
    payload: { partyId: row.partyId, documentId: row.id, kind: row.kind, from: current.status, to: row.status },
  });
  return toDocumentView(row);
}
