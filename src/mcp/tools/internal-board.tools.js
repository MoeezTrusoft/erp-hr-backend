// src/mcp/tools/internal-board.tools.js
//
// Recruitment Phase 5 (plan 6.2) — the internal job board and referrals, the
// employee side (hr_self_internal_* / hr_self_referral*).
//
// hr:self VIEW, the grant every employee holds (the my-payslip and onboarding
// self-portal gate). The subject is ALWAYS the verified claim's employeeId: an
// employeeId argument is accepted only so a client that sends one is checked,
// and a DIFFERENT id is refused (403), never honoured, whatever else the
// session holds (an admin claim or an HR grant does not turn these into a view
// of someone else's applications or referrals; HR has its own tools). A
// session with no employee bound gets a calm 400.
//
// Every tool answers 503 HR-RECRUITMENT-INTERNAL-BOARD-DISABLED while the
// internalBoard flag is off.
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  REFERRAL_NAME_MAX_LENGTH,
  REFERRAL_NOTE_MAX_LENGTH,
  REFERRAL_RELATIONSHIP_MAX_LENGTH,
} from "../../lib/internal-mobility.util.js";
import { assertInternalBoardEnabled } from "../../services/internal-referral.service.js";
import {
  applyToInternalJob,
  createReferral,
  getInternalJob,
  listInternalJobs,
  listMyReferrals,
} from "../../services/internal-board.service.js";

const SELF_RESOURCE = "hr:self";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);
const selfEmployeeInput = idInput
  .optional()
  .describe("Ignored for selection: always the caller's own; a different id is refused");
const pageInput = {
  page: z.coerce.number().int().min(1).optional().describe("Page number (default 1)"),
  pageSize: z.coerce.number().int().min(1).max(100).optional().describe("Rows per page (default 50, max 100)"),
};

/**
 * The caller's own employee id from the verified claim. A different explicit
 * id is refused; no binding is a 400.
 * @returns {number}
 */
export function resolveSelfEmployeeId(user, explicit) {
  const claim = Number(user?.employeeId);
  const acting = Number.isInteger(claim) && claim > 0 ? claim : null;
  const requested = explicit == null || explicit === "" ? null : Number(explicit);
  if (requested != null && requested !== acting) {
    throw Object.assign(new Error("Insufficient permissions: employeeId does not belong to the acting session"), {
      status: 403,
      code: "HR-4030",
    });
  }
  if (acting == null) {
    throw Object.assign(new Error("Your account is not linked to an employee record"), {
      status: 400,
      code: "HR-RECRUITMENT-INTERNAL-NO-EMPLOYEE",
    });
  }
  return acting;
}

// Permission, then the flag, then the pin to the caller.
function selfCaller(explicitEmployeeId) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, "GET", SELF_RESOURCE, user.isAdmin);
  assertInternalBoardEnabled();
  return { tenantId: user.tenantId, employeeId: resolveSelfEmployeeId(user, explicitEmployeeId) };
}

export function registerInternalBoardTools(server) {
  server.tool(
    "hr_self_internal_jobs_list",
    "Open roles on the internal job board (posted to the careers site or internally): title, department id and name, location, employment type, posted and closing dates, a plain description, and whether you already applied. Roles you manage, recruit for or are being replaced on are not listed. Never salary bands or internal notes.",
    {
      q: z.string().max(100).optional().describe("Search the job title"),
      ...pageInput,
      employeeId: selfEmployeeInput,
    },
    withToolError(async ({ q, page, pageSize, employeeId } = {}) => {
      const caller = selfCaller(employeeId);
      return text(await listInternalJobs({ ...caller, q, page, pageSize }));
    }, "hr_self_internal_jobs_list"),
  );

  server.tool(
    "hr_self_internal_job_get",
    "One role on your internal job board (the same fields as the list). A role that is not on your board is not found.",
    { requisitionId: idInput.describe("Requisition id"), employeeId: selfEmployeeInput },
    withToolError(async ({ requisitionId, employeeId }) => {
      const caller = selfCaller(employeeId);
      return text(await getInternalJob({ ...caller, requisitionId }));
    }, "hr_self_internal_job_get"),
  );

  server.tool(
    "hr_self_internal_job_apply",
    "Apply for a role on your internal job board. Uses your candidate record (matched by work email, else personal email) or creates one, and records your consent to the candidate privacy notice. One application per role; a second attempt is refused (409).",
    {
      requisitionId: idInput.describe("Requisition id"),
      consent: z.literal(true).describe("You confirm the candidate privacy notice for this application"),
      policyVersion: z.string().max(50).optional().describe("Version of the privacy notice you were shown"),
      employeeId: selfEmployeeInput,
    },
    withToolError(async ({ requisitionId, consent, policyVersion, employeeId }) => {
      const caller = selfCaller(employeeId);
      return text(await applyToInternalJob({ ...caller, requisitionId, consent, policyVersion }));
    }, "hr_self_internal_job_apply"),
  );

  server.tool(
    "hr_self_referral_create",
    "Refer someone you know for a role on your internal job board. You confirm they agreed to be referred. Someone already in process for the role is recorded as a DUPLICATE referral. Colleagues cannot be referred (they apply themselves). Returns the referral with its status and bonus status.",
    {
      requisitionId: idInput.describe("Requisition id"),
      firstName: z.string().min(1).max(REFERRAL_NAME_MAX_LENGTH).describe("Their first name"),
      lastName: z.string().max(REFERRAL_NAME_MAX_LENGTH).optional().describe("Their last name"),
      email: z.string().email().max(254).describe("Their email address"),
      phone: z.string().max(30).optional().describe("Their phone number"),
      relationship: z.string().max(REFERRAL_RELATIONSHIP_MAX_LENGTH).optional().describe("How you know them (e.g. former colleague)"),
      note: z.string().max(REFERRAL_NOTE_MAX_LENGTH).optional().describe("Why you recommend them (seen by the recruiter)"),
      consent: z.literal(true).describe("You confirm the person agreed to be referred and to be contacted about the role"),
      employeeId: selfEmployeeInput,
    },
    withToolError(async ({ employeeId, ...form }) => {
      const caller = selfCaller(employeeId);
      return text(await createReferral({ ...caller, ...form }));
    }, "hr_self_referral_create"),
  );

  server.tool(
    "hr_self_referrals_list",
    "Your own referrals, newest first: the role, how you know them, the referral status (SUBMITTED, IN_PROCESS, HIRED, REJECTED, WITHDRAWN, DUPLICATE) and the bonus status. Never the candidate's screening or interview details.",
    { ...pageInput, employeeId: selfEmployeeInput },
    withToolError(async ({ page, pageSize, employeeId } = {}) => {
      const caller = selfCaller(employeeId);
      return text(await listMyReferrals({ ...caller, page, pageSize }));
    }, "hr_self_referrals_list"),
  );
}
