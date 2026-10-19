// src/services/engagement/inbox.service.js — fabric event intake.
//
// comms.* envelopes are ids-only (ARCH-01 §13): the mail/SMS/transcript body
// lives in the Communication service. acceptFabricEvent() records the
// envelope idempotently; drainInbox() turns it into an EngagementEvent when a
// source fetcher is configured (HR_ENGAGEMENT_SOURCE_FETCH=communication,
// COMMUNICATION_SERVICE_URL) — otherwise the row is marked SKIPPED with
// lastErrorCode NO_SOURCE_FETCH and the record is completed later by the
// frontend's thread import (hr_engagement_thread_import), which already holds
// the authorised timeline.
import { EventEnvelope } from "@trusoft/contracts/envelopes";
import axios from "axios";

import defaultLogger from "../../lib/logger.js";
import prisma from "../../lib/prisma.js";
import { mcpCtx } from "../../lib/requestContext.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { ambientTenantHeader, signServiceJwtEdDSA } from "../../lib/serviceJwt.js";
import { hash, json } from "./base.js";
import { ingestEvent } from "./ingest.service.js";

export const ACCEPTED_EVENTS = Object.freeze({
  "comms.mail.received.v1": { channel: "EMAIL", direction: "INBOUND", tool: "communication_mail_message_get", idField: "messageId", argName: "messageId" },
  "comms.mail.sent.v1": { channel: "EMAIL", direction: "OUTBOUND", tool: "communication_mail_message_get", idField: "messageId", argName: "messageId" },
  "comms.sms.sent.v1": { channel: "SMS", direction: "OUTBOUND", tool: "communication_sms_get", idField: "smsId", argName: "smsId" },
  "comms.call.transcript_published.v1": { channel: "TRANSCRIPT", direction: "INBOUND", tool: "communication_call_transcript_get", idField: "callId", argName: "callId" },
  "comms.voicemail.transcribed.v1": { channel: "VOICEMAIL", direction: "INBOUND", tool: "communication_voicemail_get", idField: "voicemailId", argName: "voicemailId" },
});

export async function acceptFabricEvent(raw, { source = "fabric", log = defaultLogger } = {}) {
  const envelope = EventEnvelope.parse(raw);
  if (!ACCEPTED_EVENTS[envelope.name]) return { ignored: true, name: envelope.name };
  return mcpCtx.run({ user: { tenantId: envelope.tenantId }, log }, () =>
    tenantTransaction(prisma, async (tx) => {
      const existing = await tx.engagementInboxEvent.findUnique({ where: { tenantId_eventId: { tenantId: envelope.tenantId, eventId: envelope.id } } });
      if (existing) {
        if (hash(existing.payload) !== hash(json(envelope))) throw Object.assign(new Error("Inbox event content changed"), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
        return { queued: false, duplicate: true };
      }
      await tx.engagementInboxEvent.create({ data: { tenantId: envelope.tenantId, eventId: envelope.id, source, payload: json(envelope) } });
      return { queued: true, duplicate: false };
    }, { tenantId: envelope.tenantId }),
  );
}

let fetcher = null;
/** Test seam / alternative transport: (toolName, args, tenantId) => object|null */
export const setSourceFetcher = (fn) => { fetcher = fn; };

const sourceFetchConfigured = () => Boolean(fetcher) || (process.env.HR_ENGAGEMENT_SOURCE_FETCH === "communication" && process.env.COMMUNICATION_SERVICE_URL);

async function fetchSource(toolName, args, tenantId) {
  if (fetcher) return fetcher(toolName, args, tenantId);
  const headers = {
    ...ambientTenantHeader(),
    "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-mcp-internal": "1",
  };
  const token = signServiceJwtEdDSA();
  if (token) headers["X-Service-Authorization"] = `Bearer ${token}`;
  const res = await axios.request({
    baseURL: process.env.COMMUNICATION_SERVICE_URL,
    url: process.env.COMMUNICATION_MCP_PATH || "/mcp",
    method: "POST",
    timeout: Number.parseInt(process.env.COMMUNICATION_SERVICE_TIMEOUT || "15000", 10),
    headers,
    data: { jsonrpc: "2.0", id: `hr-engagement-${Date.now()}`, method: "tools/call", params: { name: toolName, arguments: args } },
  });
  const text = res?.data?.result?.content?.[0]?.text;
  if (res?.data?.result?.isError || !text) return null;
  const parsed = JSON.parse(text);
  return parsed?.data ?? parsed;
}

/** Normalise a fetched source record into EventInput fields. */
export function mapSourceRecord(name, record) {
  const spec = ACCEPTED_EVENTS[name];
  if (spec.channel === "EMAIL") {
    const from = record.fromEmail || record.from || null;
    const to = (record.toAddresses || record.to || []).map((t) => (typeof t === "string" ? t : t?.email)).filter(Boolean);
    const inbound = spec.direction === "INBOUND";
    return {
      resolve: inbound ? { emails: from ? [from] : [], displayName: record.fromName || undefined } : { emails: to },
      subject: record.subject || undefined,
      body: record.bodyText || String(record.bodyHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || record.snippet || "(empty message)",
      participants: [from ? `from ${from}` : null, ...to.map((t) => `to ${t}`)].filter(Boolean),
      attachments: (record.attachments || []).map((a) => ({ id: a.id != null ? String(a.id) : undefined, name: a.name || a.filename, mimeType: a.mimeType })),
      occurredAt: record.date || record.receivedAt || record.sentAt || undefined,
      sourceThreadId: record.threadId != null ? String(record.threadId) : undefined,
    };
  }
  if (spec.channel === "SMS") {
    const phone = record.phone || record.toPhone || record.to || record.fromPhone || record.from;
    return {
      resolve: { phones: phone ? [String(phone)] : [] },
      body: record.body || record.messageBody || "(empty message)",
      participants: [phone ? `phone ${phone}` : null].filter(Boolean),
      occurredAt: record.createdAt || record.sentAt || record.createdOn || undefined,
    };
  }
  const transcript = record.transcript ?? record;
  const text = Array.isArray(transcript?.segments) && transcript.segments.length
    ? transcript.segments.map((s) => `${s.speaker || "speaker"}: ${s.text || ""}`).join("\n")
    : transcript?.text || record.text || "";
  return {
    resolve: { phones: record.phone ? [String(record.phone)] : [], identities: record.contactId ? [{ system: "COMMUNICATION_CONTACT", externalId: String(record.contactId) }] : [] },
    subject: transcript?.summary || record.summary || undefined,
    body: text ? `TRANSCRIPT:\n${text}` : "(transcript unavailable)",
    occurredAt: record.startedAt || record.finalizedAt || record.time || undefined,
    metadata: { sentiment: transcript?.sentiment ?? null, language: transcript?.language ?? null },
  };
}

/** Process PENDING inbox rows (system context). */
export async function drainInbox({ log = defaultLogger, batch = 50 } = {}) {
  const rows = await prisma.engagementInboxEvent.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: batch,
  });
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const envelope = row.payload;
    const spec = ACCEPTED_EVENTS[envelope?.name];
    const env = { tenantId: row.tenantId, user: { tenantId: row.tenantId }, permissions: [], correlationId: envelope?.correlationId, actorId: "engagement-engine", log };
    try {
      if (!spec) {
        await prisma.engagementInboxEvent.update({ where: { id: row.id }, data: { status: "SKIPPED", lastErrorCode: "UNSUPPORTED_EVENT", processedAt: new Date() } });
        skipped += 1;
        continue;
      }
      if (!sourceFetchConfigured()) {
        await prisma.engagementInboxEvent.update({ where: { id: row.id }, data: { status: "SKIPPED", lastErrorCode: "NO_SOURCE_FETCH", processedAt: new Date() } });
        skipped += 1;
        continue;
      }
      const sourceId = envelope.payload?.[spec.idField];
      const record = await mcpCtx.run({ user: { tenantId: row.tenantId }, log }, () => fetchSource(spec.tool, { [spec.argName]: sourceId }, row.tenantId));
      if (!record) throw Object.assign(new Error("source record unavailable"), { code: "SOURCE_UNAVAILABLE" });
      const mapped = mapSourceRecord(envelope.name, record);
      await mcpCtx.run({ user: { tenantId: row.tenantId }, log }, () =>
        tenantTransaction(prisma, async (tx) => {
          await ingestEvent(tx, env, {
            ...mapped,
            channel: spec.channel,
            direction: spec.direction,
            sourceSystem: "COMMUNICATION_FABRIC",
            sourceId: String(sourceId),
            metadata: { ...(mapped.metadata || {}), fabricEventId: envelope.id, fabricEventName: envelope.name },
          });
          await tx.engagementInboxEvent.update({ where: { id: row.id }, data: { status: "PROCESSED", processedAt: new Date(), lastErrorCode: null } });
        }, { tenantId: row.tenantId }),
      );
      processed += 1;
    } catch (err) {
      failed += 1;
      const attempts = (row.attempts ?? 0) + 1;
      const exhausted = attempts >= 5;
      await prisma.engagementInboxEvent.update({
        where: { id: row.id },
        data: { attempts, status: exhausted ? "FAILED" : "PENDING", lastErrorCode: String(err?.code || "INGEST_FAILED").slice(0, 60), nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000), processedAt: exhausted ? new Date() : null },
      });
      log.warn({ inboxId: row.id, attempts, code: err?.code, err: { message: err?.message } }, "engagement inbox event failed");
    }
  }
  return { scanned: rows.length, processed, skipped, failed };
}
