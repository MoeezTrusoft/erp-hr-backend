// src/mcp/tools/test-workstation.tools.js
//
// Recruitment Phase 3b (plan 7.3.5) — kiosk workstation administration:
// register, list, revoke and rotate. HR admins only (the admin capability
// from resolveAssessmentAccess), after hr:recruitment with the HTTP method.
// The device token is in the register and rotate answers only; the list
// never carries a token or its hash. Flag onsiteTest (503 when off).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import {
  WORKSTATION_STATUS,
  listTestWorkstations,
  registerTestWorkstation,
  revokeTestWorkstation,
  rotateTestWorkstationToken,
} from "../../services/test-workstation.service.js";

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

export function registerTestWorkstationTools(server) {
  server.tool(
    "hr_test_workstation_register",
    "Register a kiosk PC for the on-site test with a label and site. The answer carries the device token ONCE; install it on the kiosk, it cannot be shown again.",
    {
      label: z.string().min(1).max(100).describe("Kiosk label, e.g. Lahore HQ desk 3"),
      siteRef: z.string().min(1).max(100).describe("Site reference"),
    },
    withToolError(async ({ label, siteRef }) => {
      const { tenantId, access, actorId } = authorized("POST");
      return text(await registerTestWorkstation({ label, siteRef, tenantId, access, actorId }));
    }, "hr_test_workstation_register"),
  );

  server.tool(
    "hr_test_workstations_list",
    "List registered kiosk workstations with site, status, last seen and token rotation time (never the token). Reception sees ACTIVE kiosks only, to pick one for a code.",
    {
      siteRef: z.string().max(100).optional().describe("Only this site"),
      status: z.enum(Object.values(WORKSTATION_STATUS)).optional().describe("ACTIVE or REVOKED"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional().describe("Page size (default 50, max 200)"),
    },
    withToolError(async (args) => {
      const { tenantId, access } = authorized("GET");
      return text(await listTestWorkstations({ ...args, tenantId, access }));
    }, "hr_test_workstations_list"),
  );

  server.tool(
    "hr_test_workstation_revoke",
    "Revoke a kiosk workstation with a reason; its token stops working at once.",
    {
      workstationId: idInput.describe("Workstation id"),
      reason: z.string().min(1).max(500).describe("Why the kiosk is revoked"),
    },
    withToolError(async ({ workstationId, reason }) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await revokeTestWorkstation({ workstationId, reason, tenantId, access, actorId }));
    }, "hr_test_workstation_revoke"),
  );

  server.tool(
    "hr_test_workstation_rotate",
    "Issue a new device token for an active kiosk workstation (shown ONCE); the old token stops working at once.",
    { workstationId: idInput.describe("Workstation id") },
    withToolError(async ({ workstationId }) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await rotateTestWorkstationToken({ workstationId, tenantId, access, actorId }));
    }, "hr_test_workstation_rotate"),
  );
}
