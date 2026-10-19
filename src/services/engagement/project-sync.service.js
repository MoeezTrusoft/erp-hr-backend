// src/services/engagement/project-sync.service.js — turns a relationship into
// a PM project (create) and keeps it current (update), both as a proposal the
// frontend applies through its PM binding (project_project_create /
// project_brief_save) and as a server-side sync through pm-mcp.client.js.
import { z } from "zod";

import { PROJECT_LINK_STATUSES, fail, json, toIso } from "./base.js";
import { recordRun, runStructured } from "./claude.client.js";
import { buildContextBundle, renderContext } from "./context-builder.js";
import { EVENTS, emit } from "./events.js";
import { getPartyOrFail } from "./party.service.js";
import { callPmTool } from "./pm-mcp.client.js";
import { ProjectProposalSchema, SYSTEM_PROJECT } from "./prompts.js";
import { getDocumentOrFail } from "./generation.service.js";

export const ProposeInputSchema = z.object({
  partyId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  pmProjectId: z.number().int().positive().optional(),
  instructions: z.string().trim().max(8000).optional(),
  requestKey: z.string().trim().min(8).max(200),
});

export const toLinkView = (row) =>
  row && {
    id: row.id,
    partyId: row.partyId,
    documentId: row.documentId ?? null,
    requestKey: row.requestKey,
    pmProjectId: row.pmProjectId ?? null,
    status: row.status,
    proposal: row.proposal ?? {},
    brief: row.brief ?? {},
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastError: row.lastError ?? null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

/** Build the PM create/update payload from an LLM proposal (contract: pm-inputs createProjectSchema). */
export function toPmProjectPayload(proposal, { pmProjectId, expectedVersion } = {}) {
  const p = proposal.project;
  const configuration = {
    planningMode: "ai",
    tags: p.tags?.slice(0, 50) ?? [],
    aiPlanningBrief: [proposal.brief.objectives, ...proposal.brief.requirements.map((r) => `- ${r.title}: ${r.description}`)].join("\n").slice(0, 20000),
    deliverables: (p.deliverables ?? proposal.brief.requirements.map((r) => r.title).join("\n")).slice(0, 20000),
    constraints: (p.constraints ?? proposal.brief.constraints.join("\n")).slice(0, 20000),
    ...(p.targetTimeline ? { targetTimeline: p.targetTimeline.slice(0, 100) } : {}),
  };
  const base = {
    name: p.name,
    description: p.description || null,
    status: p.status,
    startDate: p.startDate ? toIso(p.startDate) : null,
    endDate: p.endDate ? toIso(p.endDate) : null,
    configuration,
  };
  if (pmProjectId) return { projectId: pmProjectId, expectedVersion, ...base };
  return base;
}

/** Shape the brief for project_brief_save (contract: pm-lifecycle BriefContent). */
export const toBriefContent = (proposal) => ({
  title: proposal.brief.title,
  objectives: proposal.brief.objectives,
  requirements: proposal.brief.requirements.map((r) => ({
    key: r.key, title: r.title, description: r.description, acceptanceCriteria: r.acceptanceCriteria,
    evidenceIds: [], classification: r.classification, priority: r.priority,
  })),
  assumptions: proposal.brief.assumptions,
  exclusions: proposal.brief.exclusions,
  constraints: proposal.brief.constraints,
  questions: proposal.brief.questions,
});

export async function proposeProject(tx, env, rawInput) {
  const input = ProposeInputSchema.parse(rawInput);
  const party = await getPartyOrFail(tx, env, input.partyId);
  const existing = await tx.engagementProjectLink.findUnique({ where: { tenantId_requestKey: { tenantId: env.tenantId, requestKey: input.requestKey } } });
  if (existing) return { link: toLinkView(existing), replayed: true };

  const bundle = await buildContextBundle(tx, env, party, {});
  const document = input.documentId ? await getDocumentOrFail(tx, env, input.documentId) : null;
  const extra = [
    document ? `SOURCE DOCUMENT (${document.kind}, ${document.status}):\n${document.body}` : null,
    input.pmProjectId ? `An existing PM project (#${input.pmProjectId}) will be UPDATED; describe the current, complete scope.` : "A NEW PM project will be created.",
    input.instructions ? `STAFF INSTRUCTIONS:\n${input.instructions}` : null,
    `Today's date: ${toIso(new Date()).slice(0, 10)}.`,
  ].filter(Boolean).join("\n\n");
  const messages = [{ role: "user", content: `${renderContext(bundle)}\n\n${extra}` }];
  const { output, run, error } = await runStructured({ purpose: "PROJECT_PROPOSAL", system: SYSTEM_PROJECT, messages, schema: ProjectProposalSchema });
  const runId = await recordRun(tx, { tenantId: env.tenantId, partyId: party.id }, run);
  if (error) throw error;

  const row = await tx.engagementProjectLink.create({
    data: {
      tenantId: env.tenantId,
      partyId: party.id,
      documentId: document?.id ?? null,
      requestKey: input.requestKey,
      pmProjectId: input.pmProjectId ?? null,
      status: "PROPOSED",
      proposal: json({ ...output, pmPayload: toPmProjectPayload(output, { pmProjectId: input.pmProjectId }), llmRunId: runId, profileVersion: bundle.profile?.version ?? 0 }),
      brief: json(toBriefContent(output)),
    },
  });
  await emit(tx, env, EVENTS.PROJECT_PROPOSED, {
    aggregateType: "EngagementProjectLink",
    aggregateId: row.id,
    payload: { partyId: party.id, linkId: row.id, pmProjectId: row.pmProjectId, llmRunId: runId },
  });
  return { link: toLinkView(row), replayed: false };
}

export const LinkListSchema = z.object({
  partyId: z.string().uuid().optional(),
  status: z.enum(PROJECT_LINK_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function listProjectLinks(tx, env, rawInput = {}) {
  const input = LinkListSchema.parse(rawInput);
  const where = { tenantId: env.tenantId };
  if (input.partyId) where.partyId = input.partyId;
  if (input.status) where.status = input.status;
  const rows = await tx.engagementProjectLink.findMany({ where, orderBy: { createdAt: "desc" }, take: input.limit ?? 50 });
  return { items: rows.map(toLinkView), nextCursor: null };
}

async function getLinkOrFail(tx, env, linkId) {
  const row = await tx.engagementProjectLink.findFirst({ where: { tenantId: env.tenantId, id: linkId } });
  if (!row) fail("HR-4708", "Project link not found", 404);
  return row;
}

export const ConfirmInputSchema = z.object({
  linkId: z.string().uuid(),
  pmProjectId: z.number().int().positive(),
  status: z.enum(["CREATED", "UPDATED", "DISMISSED"]).default("CREATED"),
  note: z.string().trim().max(500).optional(),
});

/** Frontend-driven path: the browser called project_project_create and reports the id. */
export async function confirmProjectLink(tx, env, rawInput) {
  const input = ConfirmInputSchema.parse(rawInput);
  const link = await getLinkOrFail(tx, env, input.linkId);
  const row = await tx.engagementProjectLink.update({
    where: { id: link.id },
    data: { pmProjectId: input.pmProjectId, status: input.status, lastSyncedAt: new Date(), lastError: input.note ?? null, version: { increment: 1 } },
  });
  await emit(tx, env, EVENTS.PROJECT_SYNCED, {
    aggregateType: "EngagementProjectLink",
    aggregateId: row.id,
    payload: { partyId: row.partyId, linkId: row.id, pmProjectId: row.pmProjectId, status: row.status, via: "frontend" },
  });
  return toLinkView(row);
}

export const SyncInputSchema = z.object({
  linkId: z.string().uuid(),
  expectedProjectVersion: z.number().int().positive().optional(),
});

/** Server-side path: call PM's MCP directly with the service identity. */
export async function syncProjectLink(tx, env, rawInput) {
  const input = SyncInputSchema.parse(rawInput);
  const link = await getLinkOrFail(tx, env, input.linkId);
  if (!["PROPOSED", "FAILED", "CREATED", "UPDATED"].includes(link.status)) fail("HR-4710", `A ${link.status} link cannot be synced`, 409);
  const proposal = ProjectProposalSchema.parse(link.proposal);
  const isUpdate = Boolean(link.pmProjectId);
  const payload = toPmProjectPayload(proposal, isUpdate ? { pmProjectId: link.pmProjectId, expectedVersion: input.expectedProjectVersion } : {});
  if (isUpdate && !input.expectedProjectVersion) fail("HR-4700", "expectedProjectVersion is required to update an existing PM project", 400);

  await tx.engagementProjectLink.update({ where: { id: link.id }, data: { status: "SYNCING", version: { increment: 1 } } });
  const result = await callPmTool(isUpdate ? "project_project_update" : "project_project_create", payload, { idempotencyKey: `${link.requestKey}:${isUpdate ? "update" : "create"}:${link.version}` });
  const returnedId = Number(result.data?.id ?? result.data?.projectId ?? result.data?.project?.id);
  const data = result.ok
    ? { status: isUpdate ? "UPDATED" : "CREATED", pmProjectId: link.pmProjectId ?? (Number.isInteger(returnedId) && returnedId > 0 ? returnedId : null), lastSyncedAt: new Date(), lastError: null }
    : { status: "FAILED", lastError: String(result.error || "sync failed").slice(0, 500) };
  const row = await tx.engagementProjectLink.update({ where: { id: link.id }, data: { ...data, version: { increment: 1 } } });
  await emit(tx, env, EVENTS.PROJECT_SYNCED, {
    aggregateType: "EngagementProjectLink",
    aggregateId: row.id,
    payload: { partyId: row.partyId, linkId: row.id, pmProjectId: row.pmProjectId, status: row.status, via: "service" },
  });
  return toLinkView(row);
}
