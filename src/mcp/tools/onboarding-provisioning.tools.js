// src/mcp/tools/onboarding-provisioning.tools.js
//
// Recruitment Phase 4 (plan 6.7, flag onboardingAutomation; every tool answers
// 503 HR-ONBOARDING-AUTOMATION-DISABLED with it off) — IT's provisioning queue:
// the requests for an account, a mailbox, a device, access or a workspace that
// the hire handoff raised from the checklist's IT and workspace tasks.
//
// Who may do what. Every tool checks hr:onboarding with its HTTP method (GET
// for the reads, PUT for the update), then the flag. Inside that grant, a
// caller whose role claims are IT only (resolveProvisioningActor) may move a
// request to IN_PROGRESS, FULFILLED or REJECTED and record its reference and
// notes, but not cancel it; HR may do everything. The rows carry the hire's
// display name and the task title only, nothing else from the checklist.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  PROVISIONING_EXTERNAL_REF_MAX,
  PROVISIONING_KINDS,
  PROVISIONING_NOTES_MAX,
  PROVISIONING_STATUSES,
  resolveProvisioningActor,
} from "../../lib/onboarding-provisioning.util.js";
import {
  assertOnboardingAutomationEnabled,
  getProvisioningRequest,
  listProvisioningRequests,
  updateProvisioningRequest,
} from "../../services/onboarding-provisioning.service.js";

const RESOURCE = "hr:onboarding";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

// Permission first, then the flag, then the caller's role claims.
function authorized(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  assertOnboardingAutomationEnabled();
  return { user, actor: resolveProvisioningActor(user) };
}

const idInput = z.coerce.number().int().positive();

export function registerOnboardingProvisioningTools(server) {
  server.tool(
    "hr_onboarding_provisioning_requests_list",
    "IT's provisioning queue: requests for an account, email, device, access or workspace raised from new hires' onboarding checklists, soonest due first. Filter by status, kind, employee, checklist, overdue (open and past due) or due before a date. Each row carries the new hire's display name, the task title, the version to send back on update and the transitions allowed from its status.",
    {
      status: z.enum(PROVISIONING_STATUSES).optional().describe("REQUESTED | IN_PROGRESS | FULFILLED | REJECTED | CANCELLED"),
      kind: z.enum(PROVISIONING_KINDS).optional().describe("ACCOUNT | EMAIL | DEVICE | ACCESS | WORKSPACE | OTHER"),
      employeeId: idInput.optional().describe("The new hire's employee id"),
      checklistId: idInput.optional().describe("Onboarding checklist id"),
      overdue: z.boolean().optional().describe("true: open and past due; false: everything else"),
      dueBefore: z.string().min(1).optional().describe("ISO 8601 date or instant; requests due strictly before it"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    },
    withToolError(async (args) => {
      const { user } = authorized("GET");
      return text(await listProvisioningRequests({ ...args, tenantId: user.tenantId }));
    }, "hr_onboarding_provisioning_requests_list"),
  );

  server.tool(
    "hr_onboarding_provisioning_request_get",
    "One provisioning request with the new hire's display name, the linked task's title and completion, its version and the transitions allowed from its status.",
    { requestId: idInput.describe("Provisioning request id") },
    withToolError(async ({ requestId }) => {
      const { user } = authorized("GET");
      return text(await getProvisioningRequest({ tenantId: user.tenantId, requestId }));
    }, "hr_onboarding_provisioning_request_get"),
  );

  server.tool(
    "hr_onboarding_provisioning_request_update",
    "Work a provisioning request: move it REQUESTED → IN_PROGRESS → FULFILLED or REJECTED (any open request → CANCELLED, HR only), and record IT's ticket or asset reference and notes. Send the version you read as expectedVersion; a stale one answers 409. REJECTED needs notes saying why. FULFILLED completes the linked checklist task in the same transaction and records who fulfilled it and when.",
    {
      requestId: idInput.describe("Provisioning request id"),
      expectedVersion: z.coerce.number().int().min(0).describe("The version from the last read"),
      status: z.enum(PROVISIONING_STATUSES).optional().describe("Target status"),
      externalRef: z.string().max(PROVISIONING_EXTERNAL_REF_MAX).nullable().optional().describe("IT ticket, asset tag or account reference; null clears it"),
      notes: z.string().max(PROVISIONING_NOTES_MAX).nullable().optional().describe("Notes; required with REJECTED; null clears them"),
    },
    withToolError(async ({ requestId, expectedVersion, status, externalRef, notes }) => {
      const { user, actor } = authorized("PUT");
      return text(await updateProvisioningRequest({
        tenantId: user.tenantId,
        requestId,
        expectedVersion,
        status,
        externalRef,
        notes,
        actorId: actor.employeeId,
        allowCancel: actor.canCancel,
      }));
    }, "hr_onboarding_provisioning_request_update"),
  );
}
