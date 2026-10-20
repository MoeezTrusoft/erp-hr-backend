// src/mcp/tools/test-blueprint.tools.js
//
// Recruitment Phase 3b (plan 7.3.3) — job-specific test blueprints: list,
// read, create, edit (a published blueprint gets a new version), dual
// approval, publish behind the pool depth rule, link to a requisition or job
// family, resolve for a requisition, and a sample preview without keys.
//
// Every tool checks hr:recruitment with its HTTP method first, then the
// service applies the assessment capabilities (resolveAssessmentAccess):
//   * list / get: authors, reviewers, recruiters; a hiring manager sees the
//     blueprints of their own requisitions and job families
//   * create / update: authors and recruiters
//   * approve: HR (recruiter or HR admin) or HIRING_MANAGER (the hiring
//     manager of a requisition the blueprint is for); two different people
//   * publish: reviewers and recruiters
//   * link: recruiters, or a hiring manager for their own requisition
//   * resolve: authors, reviewers, recruiters, a manager on their requisition
//   * preview: authors, reviewers, recruiters
// All behind flag onsiteTest (503 when off).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import { BLUEPRINT_LANGUAGES, BLUEPRINT_NAVIGATION, BLUEPRINT_SCOPES, BLUEPRINT_STATUS, DIFFICULTIES } from "../../lib/test-blueprint.util.js";
import {
  APPROVAL_ROLES,
  approveTestBlueprint,
  createTestBlueprint,
  getTestBlueprint,
  linkTestBlueprint,
  listTestBlueprints,
  previewTestBlueprint,
  publishTestBlueprint,
  resolveTestBlueprint,
  updateTestBlueprint,
} from "../../services/test-blueprint.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

function authorized(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  const access = resolveAssessmentAccess(user);
  return { tenantId: user.tenantId, access, actorId: access.employeeId ?? null };
}

const idInput = z.coerce.number().int().positive();
const pct = z.coerce.number().int().min(0).max(100);

const sectionInput = z.object({
  key: z.string().max(60).optional().describe("Section key (default s1, s2, ...)"),
  label: z.string().max(120).optional().describe("Shown to the candidate (default the competency)"),
  competencyKey: z.string().min(1).max(80).describe("The competency this section tests (one per section)"),
  itemCount: z.coerce.number().int().min(1).max(50).describe("Items drawn for this section"),
  difficultyMix: z.object(Object.fromEntries(DIFFICULTIES.map((d) => [d, pct.optional()]))).optional()
    .describe("Percent EASY / MEDIUM / HARD, summing to 100 (default 30/50/20)"),
  mustPass: z.boolean().optional().describe("Must be passed whatever the total"),
  sectionPassMarkPct: pct.optional().describe("Section pass mark"),
  timeLimitMin: z.coerce.number().int().min(1).max(240).optional().describe("Optional section clock"),
});

const blueprintFields = {
  name: z.string().min(1).max(200).describe("Blueprint name"),
  language: z.enum(BLUEPRINT_LANGUAGES).optional().describe("Item language (default en)"),
  jobFamily: z.string().max(100).nullable().optional().describe("Job family the test is for"),
  sections: z.array(sectionInput).min(2).max(5).describe("Two to five sections"),
  durationMin: z.coerce.number().int().min(5).max(240).optional().describe("Overall clock (default 30)"),
  passMarkPct: pct.optional().describe("Pass mark (default 60)"),
  borderlineBandPct: pct.optional().describe("Borderline band below the pass mark (default 10)"),
  hardFloorPct: pct.nullable().optional().describe("Hard floor (default off)"),
  autoReleaseBelowFloor: z.boolean().optional().describe("Release automatically below the hard floor when no integrity flag"),
  negativeMarking: z.boolean().optional().describe("Deduct for wrong answers (default off)"),
  negativeMarkFraction: z.number().gt(0).max(1).nullable().optional().describe("Deduction per wrong answer (default 0.25)"),
  navigation: z.enum(BLUEPRINT_NAVIGATION).optional().describe("FREE (default) or FORWARD_ONLY"),
  flagForReview: z.boolean().optional().describe("Candidates may flag items to revisit (default on; off when forward-only)"),
  retakeCooldownDays: z.coerce.number().int().min(0).max(3650).optional().describe("Retake cooldown per job family (default 180)"),
  resultValidityDays: z.coerce.number().int().min(0).max(3650).optional().describe("A result is reused for this long (default 90)"),
  testWeightPct: pct.optional().describe("Test weight in the composite score (default 30)"),
  integrityFlagThreshold: z.coerce.number().int().min(0).max(100).optional().describe("Integrity flags that send a result to REVIEW (default 3)"),
  maxExtraTimePct: pct.optional().describe("Largest extra-time accommodation (default 50)"),
  allowAnySiteKiosk: z.boolean().optional().describe("A session code works on any kiosk at the site"),
};

const updateFields = Object.fromEntries(Object.entries(blueprintFields).map(([k, v]) => [k, v.optional()]));

export function registerTestBlueprintTools(server) {
  server.tool(
    "hr_test_blueprints_list",
    "List on-site test blueprints (all versions) with status, timing, pass mark and approvals; filter by status, job family or key. A hiring manager sees the blueprints for their own requisitions and job families.",
    {
      status: z.enum(Object.values(BLUEPRINT_STATUS)).optional().describe("Filter by status"),
      jobFamily: z.string().max(100).optional().describe("Filter by job family"),
      blueprintKey: z.string().max(80).optional().describe("All versions of one blueprint"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 50, max 100)"),
    },
    withToolError(async (args) => {
      const { tenantId, access } = authorized("GET");
      return text(await listTestBlueprints({ ...args, tenantId, access }));
    }, "hr_test_blueprints_list"),
  );

  server.tool(
    "hr_test_blueprint_get",
    "Read one test blueprint: sections with their item counts per difficulty, timing, marks, approvals and active links.",
    { blueprintId: idInput.describe("Blueprint id") },
    withToolError(async ({ blueprintId }) => {
      const { tenantId, access } = authorized("GET");
      return text(await getTestBlueprint({ blueprintId, tenantId, access }));
    }, "hr_test_blueprint_get"),
  );

  server.tool(
    "hr_test_blueprint_create",
    "Create a DRAFT test blueprint: two to five sections (competency, item count, difficulty mix summing to 100, must-pass, section pass mark, optional clock), duration, pass mark, borderline band, hard floor, negative marking, navigation, cooldown, validity, weights and kiosk rules.",
    { ...blueprintFields, blueprintKey: z.string().max(80).optional().describe("Stable key shared by all versions (generated when omitted)") },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("POST");
      return text(await createTestBlueprint({ input: args, tenantId, access, actorId }));
    }, "hr_test_blueprint_create"),
  );

  server.tool(
    "hr_test_blueprint_update",
    "Edit a test blueprint. An unpublished version is edited in place and loses both approvals (back to DRAFT); a PUBLISHED one is never changed: the edit becomes its next version as a DRAFT under the same key.",
    { blueprintId: idInput.describe("Blueprint id"), ...updateFields },
    withToolError(async ({ blueprintId, ...input }) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await updateTestBlueprint({ blueprintId, input, tenantId, access, actorId }));
    }, "hr_test_blueprint_update"),
  );

  server.tool(
    "hr_test_blueprint_approve",
    "Approve a test blueprint's job relevance as HIRING_MANAGER (the hiring manager of a requisition it is for) or HR (a recruiter or HR admin). Both approvals, from two different people, make it APPROVED; any later edit clears them.",
    {
      blueprintId: idInput.describe("Blueprint id"),
      as: z.enum(APPROVAL_ROLES).describe("Approve as HIRING_MANAGER or HR"),
    },
    withToolError(async ({ blueprintId, as }) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await approveTestBlueprint({ blueprintId, as, tenantId, access, actorId }));
    }, "hr_test_blueprint_approve"),
  );

  server.tool(
    "hr_test_blueprint_publish",
    "Publish an APPROVED test blueprint. Refused with the pool depth report when any section's published item pool is under three times its draw per difficulty. The previous published version of the same key is retired and its links move to this one.",
    { blueprintId: idInput.describe("Blueprint id") },
    withToolError(async ({ blueprintId }) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await publishTestBlueprint({ blueprintId, tenantId, access, actorId }));
    }, "hr_test_blueprint_publish"),
  );

  server.tool(
    "hr_test_blueprint_link",
    "Link a test blueprint to a REQUISITION (scopeId = requisition id), a JOB_FAMILY_GRADE (scopeKey = job family, scopeId = grade level id) or a JOB_FAMILY (scopeKey). Replaces the scope's previous link. An unpublished blueprint cannot replace a published one.",
    {
      blueprintId: idInput.describe("Blueprint id"),
      scopeType: z.enum(BLUEPRINT_SCOPES).describe("REQUISITION | JOB_FAMILY_GRADE | JOB_FAMILY"),
      scopeId: idInput.optional().describe("Requisition id or grade level id"),
      scopeKey: z.string().max(100).optional().describe("Job family"),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await linkTestBlueprint({ ...args, tenantId, access, actorId }));
    }, "hr_test_blueprint_link"),
  );

  server.tool(
    "hr_test_blueprint_resolve",
    "Which published test blueprint applies to a requisition and why: the requisition's own link, else its job family and grade, else its job family.",
    { requisitionId: idInput.describe("Requisition id") },
    withToolError(async ({ requisitionId }) => {
      const { tenantId, access } = authorized("GET");
      return text(await resolveTestBlueprint({ requisitionId, tenantId, access }));
    }, "hr_test_blueprint_resolve"),
  );

  server.tool(
    "hr_test_blueprint_preview",
    "A sample draw of the test a candidate would get from this blueprint: item stems and shuffled options per section, never answer keys or rationales. Does not count as exposure.",
    { blueprintId: idInput.describe("Blueprint id") },
    withToolError(async ({ blueprintId }) => {
      const { tenantId, access } = authorized("GET");
      return text(await previewTestBlueprint({ blueprintId, tenantId, access }));
    }, "hr_test_blueprint_preview"),
  );
}
