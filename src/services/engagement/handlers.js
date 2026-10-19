// src/services/engagement/handlers.js — ONE handler map shared by the MCP
// facade (src/mcp/tools/engagementTools.js) and the REST parity router
// (src/routes/engagement.routes.js), ARCH-05 §12 parity. Every handler:
//   1. takes the verified request context (env()),
//   2. asserts the hr:engagement entitlement for the HTTP verb class,
//   3. runs inside a tenantTransaction (RLS GUC set),
//   4. returns a plain JSON-serialisable object.
import { z } from "zod";

import { assertPermission } from "../../lib/assertPermission.js";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { askContext, AskInputSchema } from "./ask.service.js";
import {
  DOCUMENT_KINDS, DOCUMENT_STATUSES, ENGAGEMENT_PERMISSION_KEY, EVENT_CHANNELS, FACT_KINDS, PARTY_ROLES, PARTY_STAGES,
  PROJECT_LINK_STATUSES, env,
} from "./base.js";
import { configuredModel } from "./claude.client.js";
import {
  DocumentListSchema, DocumentTransitionSchema, DocumentUpdateSchema, GenerateInputSchema,
  generateDocument, getDocumentOrFail, listDocuments, toDocumentView, transitionDocument, updateDocument,
} from "./generation.service.js";
import { EventInputBaseSchema, ThreadImportSchema, importThreadTimeline, ingestEvent, listEvents } from "./ingest.service.js";
import {
  IdentitySchema, PartyInputSchema, PartyPatchSchema, createParty, getPartyOrFail, linkIdentity, listParties, mergeParties,
  resolveParty, toPartyView, updateParty,
} from "./party.service.js";
import { DOCUMENT_TEMPLATES } from "./prompts.js";
import {
  FactListSchema, FactUpdateSchema, getProfile, listFacts, refreshProfile, updateFact,
} from "./profile.service.js";
import {
  ConfirmInputSchema, ProposeInputSchema, SyncInputSchema, confirmProjectLink, listProjectLinks, proposeProject, syncProjectLink,
} from "./project-sync.service.js";
import { withReceipt } from "./receipts.js";

const READ = "GET";
const CREATE = "POST";
const UPDATE = "PUT";

const inTx = (fn, opts = {}) => (ctx) => tenantTransaction(prisma, (tx) => fn(tx, ctx), { tenantId: ctx.tenantId, txOptions: { timeout: opts.timeoutMs ?? 20_000, maxWait: 5_000 } });
// LLM-backed handlers can run for minutes; keep the DB transaction short by
// doing the model call OUTSIDE the transaction boundary would lose atomicity
// of "run record + document". We keep atomicity and extend the timeout instead.
const LLM_TX = { timeoutMs: Number.parseInt(process.env.ENGAGEMENT_LLM_TX_TIMEOUT_MS || "300000", 10) };

const guard = (method) => {
  const ctx = env();
  assertPermission(ctx.permissions, method, ENGAGEMENT_PERMISSION_KEY, ctx.user.isAdmin);
  return ctx;
};

// ── Input schemas advertised by the facade (zod raw shapes) ────────────────
export const INPUTS = Object.freeze({
  hr_engagement_party_list: z.object({
    q: z.string().trim().max(200).optional(),
    role: z.enum(PARTY_ROLES).optional(),
    stage: z.enum(PARTY_STAGES).optional(),
    ownerUserId: z.string().trim().max(100).optional(),
    includeMerged: z.boolean().optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  hr_engagement_party_get: z.object({ partyId: z.string().uuid() }),
  hr_engagement_party_create: PartyInputSchema.extend({ requestKey: z.string().trim().min(8).max(200).optional() }),
  hr_engagement_party_update: PartyPatchSchema.extend({ partyId: z.string().uuid() }),
  hr_engagement_party_resolve: z.object({
    emails: z.array(z.string()).max(10).optional(),
    phones: z.array(z.string()).max(10).optional(),
    identities: z.array(IdentitySchema).max(10).optional(),
    displayName: z.string().trim().max(200).optional(),
    role: z.enum(PARTY_ROLES).optional(),
    organization: z.string().trim().max(200).optional(),
    createIfMissing: z.boolean().optional(),
  }),
  hr_engagement_identity_link: z.object({ partyId: z.string().uuid(), system: IdentitySchema.shape.system, externalId: IdentitySchema.shape.externalId, reason: z.string().trim().max(500).optional() }),
  hr_engagement_party_merge: z.object({ sourcePartyId: z.string().uuid(), targetPartyId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }),
  hr_engagement_event_ingest: EventInputBaseSchema.extend({ requestKey: z.string().trim().min(8).max(200).optional() }),
  hr_engagement_event_list: z.object({ partyId: z.string().uuid(), channel: z.enum(EVENT_CHANNELS).optional(), limit: z.number().int().min(1).max(200).optional(), before: z.string().datetime({ offset: true }).optional() }),
  hr_engagement_thread_import: ThreadImportSchema,
  hr_engagement_profile_get: z.object({ partyId: z.string().uuid() }),
  hr_engagement_profile_refresh: z.object({ partyId: z.string().uuid(), force: z.boolean().optional(), eventLimit: z.number().int().min(1).max(500).optional() }),
  hr_engagement_fact_list: FactListSchema,
  hr_engagement_fact_update: FactUpdateSchema,
  hr_engagement_document_generate: GenerateInputSchema,
  hr_engagement_document_list: DocumentListSchema,
  hr_engagement_document_get: z.object({ documentId: z.string().uuid() }),
  hr_engagement_document_update: DocumentUpdateSchema,
  hr_engagement_document_transition: DocumentTransitionSchema,
  hr_engagement_project_propose: ProposeInputSchema,
  hr_engagement_project_link_list: z.object({ partyId: z.string().uuid().optional(), status: z.enum(PROJECT_LINK_STATUSES).optional(), limit: z.number().int().min(1).max(200).optional() }),
  hr_engagement_project_confirm: ConfirmInputSchema,
  hr_engagement_project_sync: SyncInputSchema,
  hr_engagement_context_ask: AskInputSchema,
  hr_engagement_catalog_get: z.object({}),
});

// define(name, verb, fn): permission check FIRST (deny-by-default, no schema
// leak to unauthorised callers), then input validation, then the transaction.
const define = (name, method, fn, txOpts) => async (raw) => {
  const ctx = guard(method);
  const args = INPUTS[name].parse(raw ?? {});
  return inTx((tx) => fn(tx, ctx, args), txOpts)(ctx);
};

export const handlers = Object.freeze({
  // ── Parties ──────────────────────────────────────────────────────────────
  hr_engagement_party_list: define("hr_engagement_party_list", READ, (tx, ctx, args) => listParties(tx, ctx, args)),
  hr_engagement_party_get: define("hr_engagement_party_get", READ, async (tx, ctx, { partyId }) => {
    const party = await getPartyOrFail(tx, ctx, partyId);
    const { profile, facts, pendingEvents } = await getProfile(tx, ctx, partyId);
    const [documents, links] = await Promise.all([listDocuments(tx, ctx, { partyId, limit: 20 }), listProjectLinks(tx, ctx, { partyId, limit: 20 })]);
    return { party: toPartyView(party), profile, facts, pendingEvents, documents: documents.items, projectLinks: links.items };
  }),
  hr_engagement_party_create: define("hr_engagement_party_create", CREATE, async (tx, ctx, { requestKey, ...input }) => {
    const { result } = await withReceipt(tx, { tenantId: ctx.tenantId, requestKey, toolName: "hr_engagement_party_create", payload: input }, async () => toPartyView(await createParty(tx, ctx, input)));
    return result;
  }),
  hr_engagement_party_update: define("hr_engagement_party_update", UPDATE, async (tx, ctx, { partyId, ...patch }) => toPartyView(await updateParty(tx, ctx, partyId, patch))),
  hr_engagement_party_resolve: define("hr_engagement_party_resolve", READ, async (tx, ctx, args) => toPartyView(await resolveParty(tx, ctx, { ...args, createIfMissing: args.createIfMissing ?? false }))),
  hr_engagement_identity_link: define("hr_engagement_identity_link", UPDATE, async (tx, ctx, { partyId, system, externalId }) => toPartyView(await linkIdentity(tx, ctx, partyId, { system, externalId }))),
  hr_engagement_party_merge: define("hr_engagement_party_merge", UPDATE, (tx, ctx, { sourcePartyId, targetPartyId }) => mergeParties(tx, ctx, { sourcePartyId, targetPartyId })),

  // ── Communication intake ─────────────────────────────────────────────────
  hr_engagement_event_ingest: define("hr_engagement_event_ingest", CREATE, async (tx, ctx, { requestKey, ...input }) => {
    const { result } = await withReceipt(tx, { tenantId: ctx.tenantId, requestKey, toolName: "hr_engagement_event_ingest", payload: input }, () => ingestEvent(tx, ctx, input));
    return result;
  }),
  hr_engagement_event_list: define("hr_engagement_event_list", READ, (tx, ctx, args) => listEvents(tx, ctx, args)),
  hr_engagement_thread_import: define("hr_engagement_thread_import", CREATE, (tx, ctx, args) => importThreadTimeline(tx, ctx, args)),

  // ── Profile and facts ────────────────────────────────────────────────────
  hr_engagement_profile_get: define("hr_engagement_profile_get", READ, (tx, ctx, { partyId }) => getProfile(tx, ctx, partyId)),
  hr_engagement_profile_refresh: define("hr_engagement_profile_refresh", UPDATE, (tx, ctx, { partyId, force, eventLimit }) => refreshProfile(tx, ctx, partyId, { force, eventLimit }), LLM_TX),
  hr_engagement_fact_list: define("hr_engagement_fact_list", READ, (tx, ctx, args) => listFacts(tx, ctx, args)),
  hr_engagement_fact_update: define("hr_engagement_fact_update", UPDATE, (tx, ctx, args) => updateFact(tx, ctx, args)),

  // ── Content generation ───────────────────────────────────────────────────
  hr_engagement_document_generate: define("hr_engagement_document_generate", CREATE, async (tx, ctx, { requestKey, ...input }) => {
    const { result } = await withReceipt(tx, { tenantId: ctx.tenantId, requestKey, toolName: "hr_engagement_document_generate", payload: input }, () => generateDocument(tx, ctx, input));
    return result;
  }, LLM_TX),
  hr_engagement_document_list: define("hr_engagement_document_list", READ, (tx, ctx, args) => listDocuments(tx, ctx, args)),
  hr_engagement_document_get: define("hr_engagement_document_get", READ, async (tx, ctx, { documentId }) => toDocumentView(await getDocumentOrFail(tx, ctx, documentId))),
  hr_engagement_document_update: define("hr_engagement_document_update", UPDATE, (tx, ctx, args) => updateDocument(tx, ctx, args)),
  hr_engagement_document_transition: define("hr_engagement_document_transition", UPDATE, (tx, ctx, args) => transitionDocument(tx, ctx, args)),

  // ── PM projects ──────────────────────────────────────────────────────────
  hr_engagement_project_propose: define("hr_engagement_project_propose", CREATE, (tx, ctx, args) => proposeProject(tx, ctx, args), LLM_TX),
  hr_engagement_project_link_list: define("hr_engagement_project_link_list", READ, (tx, ctx, args) => listProjectLinks(tx, ctx, args)),
  hr_engagement_project_confirm: define("hr_engagement_project_confirm", UPDATE, (tx, ctx, args) => confirmProjectLink(tx, ctx, args)),
  hr_engagement_project_sync: define("hr_engagement_project_sync", UPDATE, (tx, ctx, args) => syncProjectLink(tx, ctx, args), { timeoutMs: 60_000 }),

  // ── Q&A and catalog ──────────────────────────────────────────────────────
  hr_engagement_context_ask: define("hr_engagement_context_ask", READ, (tx, ctx, args) => askContext(tx, ctx, args), LLM_TX),
  hr_engagement_catalog_get: async () => {
    guard(READ);
    return {
      model: configuredModel(),
      documentKinds: DOCUMENT_KINDS.map((kind) => ({ kind, format: DOCUMENT_TEMPLATES[kind].format, guidance: DOCUMENT_TEMPLATES[kind].guidance })),
      documentStatuses: DOCUMENT_STATUSES,
      partyRoles: PARTY_ROLES,
      partyStages: PARTY_STAGES,
      eventChannels: EVENT_CHANNELS,
      factKinds: FACT_KINDS,
    };
  },
});

export const TOOL_DESCRIPTIONS = Object.freeze({
  hr_engagement_party_list: "List counterparties (visitors, leads, clients, authors, publishing users) with profile status; keyset paginated.",
  hr_engagement_party_get: "Get one counterparty with its context profile, active facts, recent documents and PM project links.",
  hr_engagement_party_create: "Create a counterparty (optionally idempotent via requestKey).",
  hr_engagement_party_update: "Update counterparty attributes, contact points, identities or stage (optimistic expectedVersion).",
  hr_engagement_party_resolve: "Resolve a counterparty from email / phone / identity link; optionally create a VISITOR when none matches.",
  hr_engagement_identity_link: "Link an external identity (Sales lead/customer, communication thread party, mailbox, phone) to a counterparty.",
  hr_engagement_party_merge: "Merge a duplicate counterparty into another; events, facts, documents and links move to the survivor.",
  hr_engagement_event_ingest: "Ingest one communication (email, SMS, chat, call transcript, voicemail, meeting note, form, note) into a counterparty's record; deduplicated; marks the profile for refresh.",
  hr_engagement_event_list: "List a counterparty's communication events newest first.",
  hr_engagement_thread_import: "Import communication_thread_timeline items for a counterparty (bulk, deduplicated).",
  hr_engagement_profile_get: "Get the context profile (summary + structured context) and active facts; reports unprocessed events.",
  hr_engagement_profile_refresh: "Fold unprocessed events into the profile with the LLM (synchronous; use force to re-read the recent window).",
  hr_engagement_fact_list: "List extracted facts (active, superseded, retracted) with provenance.",
  hr_engagement_fact_update: "Correct or retract a fact (creates a superseding fact with full confidence).",
  hr_engagement_document_generate: "Generate a grounded draft (EMAIL, SMS, CHAT_REPLY, QUOTATION, PROPOSAL, NDA, CONTRACT, EDITORIAL_ASSESSMENT, MEETING_SUMMARY, PROJECT_BRIEF, HANDOVER_BRIEF, CUSTOM) from the counterparty context.",
  hr_engagement_document_list: "List generated documents by party, kind or status.",
  hr_engagement_document_get: "Get a generated document.",
  hr_engagement_document_update: "Edit a draft's title/body/structured block (optimistic expectedVersion).",
  hr_engagement_document_transition: "Move a document through DRAFT → REVIEWED → APPROVED → SENT → ARCHIVED; SENT records the channel delivery reference and appends the outbound event.",
  hr_engagement_project_propose: "Produce a PM project proposal (project payload, brief, task breakdown) from the counterparty context; idempotent via requestKey.",
  hr_engagement_project_link_list: "List PM project links/proposals for a counterparty.",
  hr_engagement_project_confirm: "Record the PM project id after the frontend created/updated it through the PM tools.",
  hr_engagement_project_sync: "Create or update the PM project server-side via the PM service MCP (project_project_create / project_project_update).",
  hr_engagement_context_ask: "Ask a question about a counterparty; grounded answer with event citations.",
  hr_engagement_catalog_get: "Enumerations and document templates the engine supports (for UI pickers).",
});

export const READ_TOOLS = Object.freeze(Object.keys(handlers).filter((name) =>
  /_(list|get|resolve|ask)$/.test(name)));
export const TOOL_NAMES = Object.freeze(Object.keys(handlers));
