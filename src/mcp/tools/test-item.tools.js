// src/mcp/tools/test-item.tools.js
//
// Recruitment Phase 3b — the test item bank tools: list, get, create, edit
// (a published item gets a new version), submit for review, the four-eyes
// review decision, retire, spreadsheet import, AI drafting and the nightly
// statistics.
//
// Every tool checks hr:recruitment with its HTTP method first, then the
// caller's assessment capabilities (assessment-access.util.js) decide inside
// the service: authors write, reviewers publish (never their own item),
// reviewers and recruiters retire and read statistics. The answer key is
// returned only to reviewers, recruiters and the item's own author, and never
// in a list. All of it is behind the onsiteTest flag; AI drafting also needs
// the ai flag.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import {
  AI_DRAFT_MAX,
  AI_DRAFT_TYPES,
  ITEM_DIFFICULTIES,
  ITEM_LANGUAGES,
  ITEM_STATUS,
  ITEM_TYPES,
  MULTI_SCORING_RULES,
} from "../../lib/test-item.util.js";
import {
  REVIEW_DECISIONS,
  createTestItem,
  decideTestItemReview,
  draftTestItemsWithAi,
  getTestItem,
  getTestItemStats,
  listTestItems,
  retireTestItem,
  submitTestItemForReview,
  updateTestItem,
} from "../../services/test-item.service.js";
import { importTestItems } from "../../services/test-item-import.service.js";

const RESOURCE = "hr:recruitment";
// 2 MB of file as base64, plus line breaks some encoders insert.
const MAX_BASE64 = 2_900_000;

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

function authorized(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  return { user, access: resolveAssessmentAccess(user) };
}

const idInput = z.coerce.number().int().positive();
const optionInput = z.object({
  id: z.union([z.string().max(16), z.number().int()]).optional().describe("Option id (default a, b, c... by position; TRUE_FALSE uses true / false)"),
  text: z.string().max(20000).describe("Option text (p, br, strong, em, ul, ol, li, code, pre allowed)"),
  feedback: z.string().max(20000).optional().describe("Feedback shown to the author and reviewers only"),
});
const answerKeyInput = z.object({
  optionIds: z.array(z.union([z.string(), z.number()])).max(6).optional().describe("Correct option ids (choice types)"),
  optionId: z.union([z.string(), z.number()]).optional().describe("The correct option id (single-answer types)"),
  value: z.number().optional().describe("NUMERIC: the correct value"),
  tolerance: z.number().optional().describe("NUMERIC: accepted distance from the value (default 0)"),
});

// The editable content of an item; every field optional so an update can
// send only what changes. The service validates the whole merged item.
const itemFields = {
  type: z.enum(ITEM_TYPES).optional().describe("SINGLE | MULTI | TRUE_FALSE | NUMERIC | IMAGE_SINGLE"),
  stem: z.string().max(20000).optional().describe("The question (sanitised rich text)"),
  mediaId: idInput.nullable().optional().describe("DAM image id (required for IMAGE_SINGLE)"),
  options: z.array(optionInput).max(6).optional().describe("2 to 6 options; none for NUMERIC"),
  answerKey: answerKeyInput.optional().describe("The answer key, kept server-side and encrypted"),
  scoringRule: z.object({ multi: z.enum(MULTI_SCORING_RULES).optional() }).optional().describe("MULTI: ALL_OR_NOTHING (default) or PARTIAL"),
  difficulty: z.enum(ITEM_DIFFICULTIES).optional(),
  competencyKey: z.string().max(80).optional().describe("Competency key (linked to the skill taxonomy)"),
  skillId: idInput.nullable().optional().describe("Skill id; resolved from the competency when omitted"),
  jobFamily: z.string().max(80).nullable().optional(),
  gradeLevelIds: z.array(idInput).max(20).optional(),
  language: z.enum(ITEM_LANGUAGES).optional().describe("en (default) or ur"),
  timeEstimateSec: z.coerce.number().int().min(5).max(3600).nullable().optional(),
  rationale: z.string().max(20000).nullable().optional().describe("Why the key is correct and job-relevant; required before review"),
  discussionPrompt: z.boolean().optional().describe("Show this item in the interview report as a discussion prompt"),
  exposureCap: z.coerce.number().int().positive().nullable().optional().describe("Maximum times served per period"),
};

export function registerTestItemTools(server) {
  server.tool(
    "hr_test_items_list",
    "List test bank items you may see: reviewers and recruiters see all, authors their own drafts plus published items. Never returns answer keys. Filters: status, competency, job family, difficulty, language, type and a text search.",
    {
      status: z.enum(Object.values(ITEM_STATUS)).optional(),
      competencyKey: z.string().max(80).optional(),
      jobFamily: z.string().max(80).optional(),
      difficulty: z.enum(ITEM_DIFFICULTIES).optional(),
      language: z.enum(ITEM_LANGUAGES).optional(),
      type: z.enum(ITEM_TYPES).optional(),
      q: z.string().max(200).optional().describe("Search the stem or item code"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 50, max 100)"),
    },
    withToolError(async (args) => {
      const { user, access } = authorized("GET");
      return text(await listTestItems({ ...args, tenantId: user.tenantId, access }));
    }, "hr_test_items_list"),
  );

  server.tool(
    "hr_test_item_get",
    "Get one test item version. The answer key, per-option feedback, rationale and review comment are included only for reviewers, recruiters and the item's author.",
    { itemId: idInput.describe("Test item id (one version)") },
    withToolError(async ({ itemId }) => {
      const { user, access } = authorized("GET");
      return text(await getTestItem({ itemId, tenantId: user.tenantId, access }));
    }, "hr_test_item_get"),
  );

  server.tool(
    "hr_test_item_create",
    "Write a new test item as a DRAFT (version 1) authored by you. Needs type, stem, difficulty, competencyKey, the options (2 to 6, none for NUMERIC) and the answer key.",
    itemFields,
    withToolError(async (args) => {
      const { user, access } = authorized("POST");
      return text(await createTestItem({ input: args, tenantId: user.tenantId, access }));
    }, "hr_test_item_create"),
  );

  server.tool(
    "hr_test_item_update",
    "Edit a test item. A DRAFT is edited in place (its author or a recruiter); a PUBLISHED item is never changed: the edit becomes the next version as a DRAFT, and the published version stays live until the new one is published. IN_REVIEW and RETIRED items cannot be edited.",
    { itemId: idInput.describe("Test item id (one version)"), ...itemFields },
    withToolError(async ({ itemId, ...patch }) => {
      const { user, access } = authorized("PUT");
      return text(await updateTestItem({ itemId, patch, tenantId: user.tenantId, access }));
    }, "hr_test_item_update"),
  );

  server.tool(
    "hr_test_item_submit_review",
    "Send a DRAFT test item to review (DRAFT -> IN_REVIEW). The item must be complete and carry a rationale.",
    { itemId: idInput.describe("Test item id") },
    withToolError(async ({ itemId }) => {
      const { user, access } = authorized("PUT");
      return text(await submitTestItemForReview({ itemId, tenantId: user.tenantId, access }));
    }, "hr_test_item_submit_review"),
  );

  server.tool(
    "hr_test_item_review_decide",
    "Review an IN_REVIEW test item: PUBLISH it (any earlier published version of the same item is retired) or RETURN it to DRAFT with a comment. The item's author can never review it.",
    {
      itemId: idInput.describe("Test item id"),
      decision: z.enum(REVIEW_DECISIONS).describe("PUBLISH or RETURN"),
      comment: z.string().max(2000).optional().describe("Review comment (required for RETURN)"),
    },
    withToolError(async ({ itemId, decision, comment }) => {
      const { user, access } = authorized("PUT");
      return text(await decideTestItemReview({ itemId, decision, comment, tenantId: user.tenantId, access }));
    }, "hr_test_item_review_decide"),
  );

  server.tool(
    "hr_test_item_retire",
    "Retire a test item version with a reason; it is no longer drawn into tests. Reviewers and recruiters.",
    {
      itemId: idInput.describe("Test item id"),
      reason: z.string().min(1).max(2000).describe("Why the item is retired"),
    },
    withToolError(async ({ itemId, reason }) => {
      const { user, access } = authorized("PUT");
      return text(await retireTestItem({ itemId, reason, tenantId: user.tenantId, access }));
    }, "hr_test_item_retire"),
  );

  server.tool(
    "hr_test_items_import",
    "Import test items from a CSV or XLSX file (base64, at most 2 MB and 500 item rows). Header row columns: type, stem, option_a..option_f, feedback_a..feedback_f, correct (option letters separated by ';', or true/false for TRUE_FALSE), numeric_value, numeric_tolerance, multi_scoring (ALL_OR_NOTHING | PARTIAL), difficulty, competency_key, and optionally item_code, skill_id, job_family, grade_level_ids (';' separated), language (en | ur), time_estimate_sec, rationale, discussion_prompt (yes | no), exposure_cap, media_id. Required: type, stem, difficulty, competency_key. Valid rows land as DRAFT items authored by you; invalid rows are reported with their row number and reasons and nothing of them is saved. dryRun validates without saving.",
    {
      contentBase64: z.string().min(1).max(MAX_BASE64).describe("The file, base64 encoded"),
      format: z.enum(["csv", "xlsx"]).optional().describe("File format (default from the file name or content)"),
      fileName: z.string().max(255).optional(),
      dryRun: z.boolean().optional().describe("Validate and report only"),
    },
    withToolError(async (args) => {
      const { user, access } = authorized("POST");
      return text(await importTestItems({ ...args, dryRun: args.dryRun === true, tenantId: user.tenantId, access }));
    }, "hr_test_items_import"),
  );

  server.tool(
    "hr_test_item_draft_ai",
    `Ask the AI plane to draft up to ${AI_DRAFT_MAX} test items from a requisition's skills (or the competencies you name). Valid drafts are stored as AI-drafted DRAFT items authored by you and need the same human review; invalid drafts are reported and dropped. Needs the AI feature switched on.`,
    {
      requisitionId: idInput.optional().describe("Requisition whose skills the items should test"),
      competencyKeys: z.array(z.string().max(80)).max(20).optional().describe("Competencies to draft for (default: the requisition's skills)"),
      count: z.coerce.number().int().min(1).max(AI_DRAFT_MAX).optional().describe("How many drafts (default 5)"),
      difficulty: z.enum(ITEM_DIFFICULTIES).optional().describe("Default MEDIUM"),
      language: z.enum(ITEM_LANGUAGES).optional().describe("Default en"),
      types: z.array(z.enum(AI_DRAFT_TYPES)).max(4).optional().describe("Item types to draft (default SINGLE)"),
    },
    withToolError(async (args) => {
      const { user, access } = authorized("POST");
      return text(await draftTestItemsWithAi({ ...args, tenantId: user.tenantId, access }));
    }, "hr_test_item_draft_ai"),
  );

  server.tool(
    "hr_test_item_stats_get",
    "The nightly statistics for a test item version: sample size, difficulty (proportion correct), discrimination (point-biserial against the total score), option selection rates, average time and the review flags (TOO_EASY, TOO_HARD, LOW_DISCRIMINATION, LEAKAGE_SUSPECTED), latest first. Reviewers and recruiters.",
    {
      itemId: idInput.describe("Test item id"),
      limit: z.coerce.number().int().min(1).max(90).optional().describe("How many nightly rows (default 10)"),
    },
    withToolError(async ({ itemId, limit }) => {
      const { user, access } = authorized("GET");
      return text(await getTestItemStats({ itemId, limit, tenantId: user.tenantId, access }));
    }, "hr_test_item_stats_get"),
  );
}

export default registerTestItemTools;
