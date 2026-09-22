// src/mcp/tools/recruitmentExtraTools.js — recruitment cost config (real
// cost-per-hire), candidate resume upload to DAM, the FR-04.10
// duplicate-candidate MERGE (typo-recovery), and the §1.4 requisition
// ATTACHMENT tools (list/upload/delete) closing decision B2.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { getCostConfig, setCostConfig } from "../../services/recruitmentCost.service.js";
import { uploadCandidateResume } from "../../services/candidateResume.service.js";
import { mergeCandidates } from "../../services/candidateMerge.service.js";
import {
  listRequisitionAttachments,
  addRequisitionAttachment,
  removeRequisitionAttachment,
} from "../../services/requisitionAttachment.service.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { ATTACHMENT_CATEGORIES } from "../../lib/requisitionFields.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

export function registerRecruitmentExtraTools(server) {
  // FR-04.10 — the recruiter half of duplicate recovery. The portal half is
  // the reconciliation + status link; this tool folds a typo-duplicate row
  // into the survivor inside one transaction. Registered as a TOOL (never a
  // resource) so the gateway's edge pre-check sees the name.
  server.tool(
    "hr_candidate_merge",
    "Merge a duplicate candidate into a survivor (FR-04.10 typo recovery). Fill-only-blanks on the survivor, transfer applications except where the survivor already has one to the same requisition, re-point consents/pool/skills/AI records, archive (never delete/anonymize) the source. Refuses self-merge, anonymized rows, legal holds and unconfirmed live-application conflicts.",
    {
      sourceId: z.string().min(1).describe("Duplicate candidate id to fold away; numeric string"),
      targetId: z.string().min(1).describe("Survivor candidate id that keeps its identity; numeric string"),
      keepTargetOnConflict: z.coerce.boolean().optional().describe("Confirm keep-target when both rows have live applications to one requisition (default true; set false to refuse conflicts)") ,
    },
    withToolError(async ({ sourceId, targetId, keepTargetOnConflict }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await mergeCandidates({
        tenantId: user.tenantId,
        sourceId,
        targetId,
        actorId: user.employeeId ?? null,
        keepTargetOnConflict,
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_candidate_merge")
  );
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
      period: z.string().optional().describe('Cost period key; default "all"'),
      jobAds: z.number().optional().describe("Job-advertising spend; rounded to int; default 0"),
      agencyFees: z.number().optional().describe("Recruitment-agency fees; rounded to int; default 0"),
      tools: z.number().optional().describe("Recruiting tools/software spend; rounded to int; default 0"),
      other: z.number().optional().describe("Other recruitment costs; rounded to int; default 0"),
      currency: z.string().optional().describe("ISO 4217 currency code; default PKR"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const cfg = await setCostConfig(user.tenantId, args);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: cfg }) }] };
    }, "hr_recruitment_cost_config_set")
  );

  server.tool(
    "hr_requisition_attachment_list",
    "List a requisition's typed attachments (decision §1.4). Scope-filtered: an ORG caller sees internal documents; a hiring-team caller sees only HIRING_TEAM rows. Metadata only — bytes stay in DAM.",
    {
      requisitionId: z.union([z.string(), z.number()]).describe("Requisition id; numeric string or number"),
    },
    withToolError(async ({ requisitionId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listRequisitionAttachments(requisitionId, user.tenantId, resolveRecruitmentScope(user));
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_requisition_attachment_list")
  );

  server.tool(
    "hr_requisition_attachment_upload",
    "Attach a document pointer to a requisition (decision §1.4). The BYTES live in DAM — pass the DAM media id you already uploaded. Category must be one of JOB_DESCRIPTION, BUSINESS_JUSTIFICATION, BUDGET_APPROVAL, HIRING_APPROVAL, OTHER_INTERNAL; a category that is not hiring-team material can never be tagged HIRING_TEAM.",
    {
      requisitionId: z.union([z.string(), z.number()]).describe("Requisition id; numeric string or number"),
      category: z.enum(ATTACHMENT_CATEGORIES).describe("Document category — drives the ACL"),
      mediaId: z.union([z.string(), z.number()]).describe("DAM media id of the uploaded file"),
      fileName: z.string().optional().describe("Original filename for display"),
      label: z.string().optional().describe("Free-text label for the document"),
      visibility: z.enum(["INTERNAL", "HIRING_TEAM"]).optional().describe('Defaults to INTERNAL; HIRING_TEAM is refused for non-hiring-team categories'),
    },
    withToolError(async ({ requisitionId, category, mediaId, fileName, label, visibility }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await addRequisitionAttachment(requisitionId, user.tenantId, resolveRecruitmentScope(user), {
        category,
        mediaId,
        fileName,
        label,
        visibility,
        uploadedById: user.employeeId ?? null,
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_requisition_attachment_upload")
  );

  server.tool(
    "hr_requisition_attachment_delete",
    "Remove a requisition attachment POINTER (decision §1.4). The DAM asset itself is untouched. A hiring-team caller can only delete rows it could read.",
    {
      requisitionId: z.union([z.string(), z.number()]).describe("Requisition id the attachment belongs to"),
      attachmentId: z.union([z.string(), z.number()]).describe("RequisitionAttachment id to remove"),
    },
    withToolError(async ({ requisitionId, attachmentId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      // The delete is scoped by tenant + audience inside the service, so a
      // foreign-tenant or unreadable row resolves to the same not-found.
      const data = await removeRequisitionAttachment(attachmentId, user.tenantId, resolveRecruitmentScope(user));
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_requisition_attachment_delete")
  );

  server.tool(
    "hr_candidate_resume_upload",
    "Upload a resume file for a candidate to DAM and set the candidate's resumeMediaId. Accepts raw base64 or a data: URI.",
    {
      candidateId: z.union([z.string(), z.number()]).describe("Candidate id (references Candidate); numeric string or number"),
      fileBase64: z.string().describe("Raw base64 or data: URI of the resume (PDF/DOCX)"),
      fileName: z.string().optional().describe("Resume filename; defaults to resume-<candidateId>.pdf"),
    },
    withToolError(async ({ candidateId, fileBase64, fileName }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await uploadCandidateResume({ candidateId, fileBase64, fileName, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_candidate_resume_upload")
  );
}
