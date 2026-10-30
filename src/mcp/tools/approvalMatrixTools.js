// src/mcp/tools/approvalMatrixTools.js — configurable approval matrices (ATTENDANCE and PAYROLL
// kept separate). Reading is allowed for anyone who may see the setup; changing, publishing and
// retiring need the same hr:payroll write grant as the other setup screens.
import { z } from "zod";
import {
  getApprovalMatrix,
  saveApprovalMatrixDraft,
  discardApprovalMatrixDraft,
  publishApprovalMatrix,
  retireApprovalMatrix,
} from "../../services/approvalMatrix.service.js";
import { MATRIX_KINDS } from "../../lib/approvalMatrix.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

const RESOURCE = "hr:payroll";
const jsonResult = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}
const kind = z.enum(MATRIX_KINDS).describe("Request kind the matrix routes: ATTENDANCE or PAYROLL");
const level = z
  .object({
    name: z.string().describe("Level name shown in the Approval Centre"),
    action: z.enum(["RECOMMEND", "VERIFY", "APPROVE"]).describe("What the approver does. Only the last level may APPROVE"),
    required: z.boolean().optional().describe("A required level cannot be skipped (default true)"),
    paused: z.boolean().optional().describe("Keep the level in the route but skip it for now (default false). The deciding level cannot pause"),
    approverMode: z.enum(["NAMED", "EMPLOYEE_MANAGER"]).describe("Named employees, or the subject employee's line manager"),
    approverIds: z.array(z.coerce.number().int().positive()).optional().describe("Employee ids when NAMED"),
    canReject: z.boolean().optional().describe("May reject / recommend rejection (default true)"),
    canReturn: z.boolean().optional().describe("May return the request to the previous level (default true)"),
    satisfiedByInitiator: z.boolean().optional().describe("The initiator raising the request counts as this level (e.g. HR raising payroll)"),
    allowSelf: z.boolean().optional().describe("Verification levels only: the employee a request is about may verify their own request (raising it counts as verifying)"),
    thresholdAmount: z.number().nullable().optional().describe("PAYROLL only: engage this optional level at or above this net total"),
  })
  .strict();

export function registerApprovalMatrixTools(server) {
  const run = (method, fn, name) =>
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, method, RESOURCE, user.isAdmin);
      return jsonResult(await fn({ ...args, tenantId: user.tenantId, actorId: user.userId ?? user.id ?? "unknown" }));
    }, name);

  server.tool(
    "hr_approval_route_get",
    "Read the approval matrix of a kind: the published route, the draft and the earlier versions. usingFixedStages is true until a route is published",
    { kind },
    run("GET", getApprovalMatrix, "hr_approval_route_get"),
  );
  server.tool(
    "hr_approval_route_save_draft",
    "Save the draft approval matrix of a kind (ordered levels). Validates approvers and the rules; nothing applies until it is published",
    { kind, levels: z.array(level).min(1).max(8), note: z.string().max(500).optional() },
    run("PUT", saveApprovalMatrixDraft, "hr_approval_route_save_draft"),
  );
  server.tool(
    "hr_approval_route_discard_draft",
    "Discard the draft approval matrix of a kind",
    { kind },
    run("PUT", discardApprovalMatrixDraft, "hr_approval_route_discard_draft"),
  );
  server.tool(
    "hr_approval_route_publish",
    "Publish the draft approval matrix of a kind. New submissions follow it; requests already submitted keep their route",
    { kind, reason: z.string().min(1).max(500).describe("Why the route changes (audited)") },
    run("PUT", publishApprovalMatrix, "hr_approval_route_publish"),
  );
  server.tool(
    "hr_approval_route_retire",
    "Withdraw the published approval matrix of a kind so new submissions use the four fixed stages again",
    { kind, reason: z.string().min(1).max(500) },
    run("PUT", retireApprovalMatrix, "hr_approval_route_retire"),
  );
}
