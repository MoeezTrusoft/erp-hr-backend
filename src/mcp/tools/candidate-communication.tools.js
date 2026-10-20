// src/mcp/tools/candidate-communication.tools.js — Recruitment Phase 2.
//
// The candidate communications log and the recruiter's manual messages:
//   hr_candidate_communications_list            GET  log for a candidate or application (scoped)
//   hr_candidate_communication_send             POST manual template message (ORG only, idempotent)
//   hr_candidate_communication_cancel           PUT  cancel a QUEUED message (ORG only)
//   hr_recruitment_communication_templates_list GET  the template catalogue
//
// Gated on hr:recruitment with the method-matching action. The actor is the
// verified employee from the MCP context, never an argument. Send returns 503
// HR-RECRUITMENT-COMMUNICATIONS-DISABLED while the `communications` flag is
// off; the reads (and cancelling) work regardless.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { buildListPayload } from "../../utils/apiContract.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import {
  CANCEL_REASON_MAX,
  PERSONAL_NOTE_MAX,
  cancelCandidateCommunication,
  listCandidateCommunications,
  listCommunicationTemplates,
  sendManualCandidateCommunication,
} from "../../services/candidate-communication.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const id = z.union([z.string(), z.number()]);

export function registerCandidateCommunicationTools(server) {
  server.tool(
    "hr_candidate_communications_list",
    "Candidate communications log for one candidate or application: template, category, status, suppression reason, schedule and send time (never message bodies or contact details), scoped to the caller",
    {
      candidateId: id.optional().describe("Candidate id"),
      applicationId: id.optional().describe("Application id"),
      status: z.enum(["QUEUED", "SENT", "SUPPRESSED", "FAILED", "CANCELLED"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(200).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const { items, total, page, pageSize } = await listCandidateCommunications({
        ...args,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
      });
      return text(
        buildListPayload({
          items,
          page,
          pageSize,
          total,
          sort: "createdAt",
          order: "desc",
          filters: {
            candidateId: args.candidateId ?? null,
            applicationId: args.applicationId ?? null,
            status: args.status ?? null,
          },
        }),
      );
    }, "hr_candidate_communications_list"),
  );

  server.tool(
    "hr_candidate_communication_send",
    "Send a catalogue template to a candidate about one application (recruiters only); optional plain-text personal note on offer and general-update templates. Queued and checked against do-not-contact and consent at send. Idempotent on clientRequestId",
    {
      applicationId: id.describe("Application id"),
      templateId: z.string().min(1).max(100).describe("Template id from hr_recruitment_communication_templates_list"),
      personalNote: z.string().max(PERSONAL_NOTE_MAX).optional().describe("Plain-text note merged into the message"),
      clientRequestId: z.string().min(1).max(100).describe("Caller-chosen idempotency key; a retry with the same key returns the same message"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await sendManualCandidateCommunication({
        ...args,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        actorId: user.employeeId ?? null,
      });
      return text(data);
    }, "hr_candidate_communication_send"),
  );

  server.tool(
    "hr_candidate_communication_cancel",
    "Cancel a queued candidate message (for example a delayed rejection) with a reason (recruiters only)",
    {
      id: id.describe("Communication id"),
      reason: z.string().min(1).max(CANCEL_REASON_MAX),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:recruitment", user.isAdmin);
      const data = await cancelCandidateCommunication({
        ...args,
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        actorId: user.employeeId ?? null,
      });
      return text(data);
    }, "hr_candidate_communication_cancel"),
  );

  server.tool(
    "hr_recruitment_communication_templates_list",
    "The candidate communication template catalogue: id, category, the events each answers, description, and whether a recruiter can send it by hand",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      return text({ items: listCommunicationTemplates() });
    }, "hr_recruitment_communication_templates_list"),
  );
}
