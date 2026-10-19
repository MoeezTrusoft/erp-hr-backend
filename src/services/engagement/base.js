// src/services/engagement/base.js — shared primitives for the Engagement
// Context Engine (communication-driven relationship context for publishing
// leads, clients and publishing users).
//
// Error codes: HR-47xx (free range per constants/errorCodes.js review).
//   HR-4700 bad request · HR-4701 party not found · HR-4702 document not found
//   HR-4703 LLM not configured · HR-4704 LLM refused · HR-4705 LLM output
//   truncated/invalid · HR-4706 idempotency conflict · HR-4707 version conflict
//   HR-4708 project link not found · HR-4709 LLM unavailable (transport)
//   HR-4710 invalid state transition
import { createHash } from "node:crypto";

import { mcpCtx } from "../../lib/requestContext.js";
import defaultLogger from "../../lib/logger.js";

export const ENGAGEMENT_PERMISSION_KEY = "hr:engagement";

export const PARTY_KINDS = Object.freeze(["PERSON", "ORGANIZATION"]);
export const PARTY_ROLES = Object.freeze(["VISITOR", "LEAD", "CLIENT", "PUBLISHING_USER", "AUTHOR", "PARTNER"]);
export const PARTY_STAGES = Object.freeze(["NEW", "ENGAGED", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "ACTIVE", "DORMANT", "LOST", "MERGED"]);
export const IDENTITY_SYSTEMS = Object.freeze([
  "CONTACT", "SALES_CUSTOMER", "SALES_LEAD", "SALES_OPPORTUNITY", "THREAD_PARTY", "COMMUNICATION_CONTACT",
  "RBAC_USER", "HR_EMPLOYEE", "VISITOR_SESSION", "MAILBOX", "PHONE", "EMAIL", "EXTERNAL",
]);
export const EVENT_CHANNELS = Object.freeze(["EMAIL", "SMS", "WEBCHAT", "CHAT", "CALL", "TRANSCRIPT", "VOICEMAIL", "MEETING", "NOTE", "FORM", "DOCUMENT", "SYSTEM"]);
export const EVENT_DIRECTIONS = Object.freeze(["INBOUND", "OUTBOUND", "INTERNAL"]);
export const FACT_KINDS = Object.freeze(["IDENTITY", "CONTACT_RULE", "PREFERENCE", "REQUIREMENT", "PROJECT_DETAIL", "COMMITMENT", "DECISION", "OBJECTION", "TIMELINE", "BUDGET", "RISK", "SENTIMENT", "OTHER"]);
export const FACT_STATUSES = Object.freeze(["ACTIVE", "SUPERSEDED", "RETRACTED"]);
export const DOCUMENT_KINDS = Object.freeze(["EMAIL", "SMS", "CHAT_REPLY", "QUOTATION", "PROPOSAL", "NDA", "CONTRACT", "EDITORIAL_ASSESSMENT", "MEETING_SUMMARY", "PROJECT_BRIEF", "HANDOVER_BRIEF", "CUSTOM"]);
export const DOCUMENT_STATUSES = Object.freeze(["DRAFT", "REVIEWED", "APPROVED", "SENT", "ARCHIVED"]);
export const DOCUMENT_FORMATS = Object.freeze(["MARKDOWN", "HTML", "TEXT"]);
export const PROJECT_LINK_STATUSES = Object.freeze(["PROPOSED", "SYNCING", "CREATED", "UPDATED", "FAILED", "DISMISSED"]);

// Allowed document status transitions (ARCH-01 §3.5 explicit state machine).
export const DOCUMENT_TRANSITIONS = Object.freeze({
  DRAFT: ["REVIEWED", "APPROVED", "ARCHIVED"],
  REVIEWED: ["APPROVED", "DRAFT", "ARCHIVED"],
  APPROVED: ["SENT", "DRAFT", "ARCHIVED"],
  SENT: ["ARCHIVED"],
  ARCHIVED: [],
});

export function fail(code, message, status = 409, extra = {}) {
  throw Object.assign(new Error(message), { status, code, ...extra });
}

export const hash = (value) =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex");

export const json = (value) => JSON.parse(JSON.stringify(value ?? null));

/** Verified request context (tenant/user/permissions) or 401. */
export function env() {
  const store = mcpCtx.getStore();
  if (!store?.user?.tenantId) fail("HR-4010", "Unauthenticated", 401);
  return {
    tenantId: store.user.tenantId,
    user: store.user,
    permissions: store.permissions ?? [],
    correlationId: store.correlationId,
    log: store.log || defaultLogger,
    actorId: store.user.userId != null ? String(store.user.userId) : store.user.email || "service",
  };
}

export const log = () => mcpCtx.getStore()?.log || defaultLogger;

/** Rough token estimate (~4 chars/token) used only for context budgeting. */
export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

export const truncate = (text, max) => {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
};

export const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();
export const normalizePhone = (value) => {
  const digits = String(value ?? "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  return digits.startsWith("+") ? `+${digits.slice(1).replace(/\D/g, "")}` : digits;
};

export const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

export const uniq = (values) => Array.from(new Set(values.filter(Boolean)));

export const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
