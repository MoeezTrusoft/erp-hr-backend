// src/mcp/tools/candidate-duplicate.tools.js — Recruitment Phase 2 duplicate
// candidate suggestions (flag `duplicates`, HR_RECRUITMENT_DUPLICATES).
//
//   hr_candidate_duplicate_list     GET  ORG — suggestions with both candidates'
//                                         display fields, boolean signals and
//                                         fresh conflicts. Works with the flag
//                                         off (shows what was detected).
//   hr_candidate_duplicate_resolve  PUT  ORG — MERGE (through the existing
//                                         candidate merge) or DISMISS.
//   hr_candidate_duplicate_detect   POST ORG — run detection for one candidate
//                                         now; 503 when the flag is off.
//
// Gated on hr:recruitment with the HTTP method (assertPermission maps it to the
// action). MERGE needs no second assertion: hr_candidate_merge asserts the same
// PUT on hr:recruitment, which this tool has already checked. The actor is the
// verified employee from the MCP context, never a tool argument.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { buildListPayload } from "../../utils/apiContract.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import {
  detectCandidateDuplicates,
  listDuplicateSuggestions,
  resolveDuplicateSuggestion,
} from "../../services/candidate-duplicate.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

export function registerCandidateDuplicateTools(server) {
  server.tool(
    "hr_candidate_duplicate_list",
    "List likely-duplicate candidate pairs (recruiters only): both candidates' profile fields, which signals matched (email/phone/name/profile/resume, booleans only), the score, and the conflicts a merge must resolve (legal hold, anonymized, live applications to the same requisition, consent mismatch)",
    {
      status: z.enum(["OPEN", "MERGED", "DISMISSED", "ALL"]).optional().describe("Suggestion status (default OPEN)"),
      candidateId: z.coerce.number().int().positive().optional().describe("Only pairs that include this candidate"),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(100).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const status = args.status ?? "OPEN";
      const { items, total, page, pageSize } = await listDuplicateSuggestions({
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        status,
        candidateId: args.candidateId,
        page: args.page,
        pageSize: args.pageSize,
      });
      return reply(buildListPayload({
        items,
        page,
        pageSize,
        total,
        sort: "score",
        order: "desc",
        filters: { status, candidateId: args.candidateId ?? null },
      }));
    }, "hr_candidate_duplicate_list")
  );

  server.tool(
    "hr_candidate_duplicate_resolve",
    "Resolve a duplicate-candidate suggestion (recruiters only). MERGE folds the other candidate into survivorId with the candidate merge (refused for anonymized or legally held candidates; a live application to the same requisition on both needs keepSurvivorOnConflict=true) and dismisses other open suggestions for the merged-away candidate. DISMISS records the decision; the pair is never proposed again.",
    {
      id: z.coerce.number().int().positive().describe("Suggestion id"),
      action: z.enum(["MERGE", "DISMISS"]),
      survivorId: z.coerce.number().int().positive().optional().describe("MERGE only: the candidate that keeps its identity (one of the pair)"),
      keepSurvivorOnConflict: z.boolean().optional().describe("MERGE only: confirm keeping the survivor's application where both have a live application to one requisition (default false)"),
      note: z.string().max(500).optional().describe("Reason recorded with the decision"),
      expectedStatus: z.enum(["OPEN", "MERGED", "DISMISSED"]).optional().describe("Status the caller saw (default OPEN); a mismatch is a 409"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      if (args.action === "MERGE" && args.survivorId == null) {
        throw Object.assign(new Error("survivorId is required for MERGE"), { status: 400, code: "HR-RECRUITMENT-DUPLICATE-SURVIVOR-INVALID" });
      }
      const data = await resolveDuplicateSuggestion({
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        id: args.id,
        action: args.action,
        survivorId: args.survivorId,
        keepSurvivorOnConflict: args.keepSurvivorOnConflict === true,
        note: args.note ?? null,
        expectedStatus: args.expectedStatus ?? "OPEN",
        actorId: user.employeeId ?? null,
      });
      return reply({ success: true, data });
    }, "hr_candidate_duplicate_resolve")
  );

  server.tool(
    "hr_candidate_duplicate_detect",
    "Run duplicate detection now for one candidate (recruiters only) and store any new suggestions. Unavailable (503) while duplicate detection is switched off.",
    { candidateId: z.coerce.number().int().positive().describe("Candidate id") },
    withToolError(async ({ candidateId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await detectCandidateDuplicates({
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        candidateId,
      });
      return reply({ success: true, data });
    }, "hr_candidate_duplicate_detect")
  );
}
