// src/mcp/tools/recruitmentExtraTools.js — recruitment cost config (real
// cost-per-hire) + candidate resume upload to DAM.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { getCostConfig, setCostConfig } from "../../services/recruitmentCost.service.js";
import { uploadCandidateResume } from "../../services/candidateResume.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  return { user: ctx?.user || {}, permissions: ctx?.permissions || {} };
}

export function registerRecruitmentExtraTools(server) {
  server.tool(
    "hr_recruitment_cost_config_get",
    "Get the tenant's recruitment cost inputs (jobAds, agencyFees, tools, other, currency) used for real cost-per-hire.",
    { period: z.string().optional().describe('Cost period; default "all"') },
    withToolError(async ({ period }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const cfg = await getCostConfig(user.tenantId, period || "all");
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: cfg }) }] };
    }, "hr_recruitment_cost_config_get")
  );

  server.tool(
    "hr_recruitment_cost_config_set",
    "Set/update the tenant's recruitment cost inputs. Missing fields keep their current value. Makes cost-per-hire real (analytics stops using illustrative constants).",
    {
      period: z.string().optional(),
      jobAds: z.number().optional(),
      agencyFees: z.number().optional(),
      tools: z.number().optional(),
      other: z.number().optional(),
      currency: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const cfg = await setCostConfig(user.tenantId, args);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: cfg }) }] };
    }, "hr_recruitment_cost_config_set")
  );

  server.tool(
    "hr_candidate_resume_upload",
    "Upload a resume file for a candidate to DAM and set the candidate's resumeMediaId. Accepts raw base64 or a data: URI.",
    {
      candidateId: z.union([z.string(), z.number()]),
      fileBase64: z.string().describe("Raw base64 or data: URI of the resume (PDF/DOCX)"),
      fileName: z.string().optional(),
    },
    withToolError(async ({ candidateId, fileBase64, fileName }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await uploadCandidateResume({ candidateId, fileBase64, fileName, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_candidate_resume_upload")
  );
}
