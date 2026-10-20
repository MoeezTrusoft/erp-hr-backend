// src/mcp/tools/reception.tools.js
//
// Recruitment Phase 3b — the Reception Console over MCP: today's arrivals,
// check-in, test code issue and live proctoring (plan 7.6 "Reception and
// proctoring").
//
// Who may do what (resolveAssessmentAccess; every tool first asserts
// hr:recruitment with its HTTP method, and answers 503
// HR-RECRUITMENT-ONSITE-TEST-DISABLED while HR_RECRUITMENT_ONSITE_TEST is off):
//   * every tool here: the reception capability (RECEPTION / RECEPTIONIST
//     roles, or a recruiter). A receptionist passes their siteRef and reaches
//     that site's interviews, kiosks and sessions only; a recruiter may leave
//     it out.
//   * granting extra time at check-in and hr_test_session_extend: recruiters
//     only.
// Nothing here returns an item, an answer key, a score or a band.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { assertAssessmentCapability, resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import { assertOnsiteTestEnabled } from "../../services/test-session.service.js";
import {
  ID_TYPES,
  checkInCandidate,
  extendTestSession,
  issueTestSession,
  listArrivals,
  listLiveSessions,
  pauseTestSession,
  resumeTestSession,
  voidTestSession,
} from "../../services/reception.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);
const siteInput = z.string().min(1).max(100).describe("Your site (required unless you are a recruiter)");

// Flag first (a disabled feature answers the same 503 to everyone), then the
// permission, then the reception capability.
function authorized(method, capability = "reception") {
  assertOnsiteTestEnabled();
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  const access = resolveAssessmentAccess(user);
  assertAssessmentCapability(access, capability);
  return { tenantId: user.tenantId, access, actorId: access.employeeId ?? null };
}

export function registerReceptionTools(server) {
  server.tool(
    "hr_reception_arrivals_list",
    "Today's interviews that need the on-site test, at your site (or every site for a recruiter): candidate name, time, place, interview id, check-in state and test status (AWAITING_CHECK_IN | CHECKED_IN | IN_PROGRESS | COMPLETED | WAIVED). Never a score or a band: a finished test reads COMPLETED, refer to the recruiter.",
    {
      siteRef: siteInput.optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day (YYYY-MM-DD, tenant time zone); default today"),
    },
    withToolError(async ({ siteRef, date }) => {
      const { tenantId, access } = authorized("GET");
      return text(await listArrivals({ tenantId, access, siteRef, date }));
    }, "hr_reception_arrivals_list"),
  );

  server.tool(
    "hr_candidate_checkin",
    "Check a candidate in for their on-site test: the ID type and only its last four characters, the candidate's consent (required), and any accommodation with its reason. Only a recruiter can grant extra time (up to the test's cap); reception records large text, screen reader or language. The interview moves to CHECKED_IN.",
    {
      interviewId: idInput.describe("Interview id"),
      idType: z.enum(ID_TYPES).describe("Identity document shown"),
      idLast4: z.string().regex(/^[A-Za-z0-9]{4}$/).describe("Exactly the last four characters of the ID number"),
      consent: z.literal(true).describe("The candidate consents to the test"),
      accommodations: z.object({
        extraTimePct: z.number().int().min(0).max(100).optional().describe("Extra time in percent (recruiter only)"),
        largeText: z.boolean().optional(),
        screenReader: z.boolean().optional(),
        language: z.enum(["en", "ur"]).optional(),
      }).optional(),
      accommodationReason: z.string().max(1000).optional().describe("Why the accommodation is granted (required with one)"),
      siteRef: siteInput.optional(),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("POST");
      return text(await checkInCandidate({ ...args, tenantId, access, actorId }));
    }, "hr_candidate_checkin"),
  );

  server.tool(
    "hr_test_session_issue",
    "Issue a test session for a checked-in candidate on one ACTIVE kiosk at the site. Returns a six-digit code ONCE (single use, valid 15 minutes, only on that kiosk unless the test allows any kiosk at the site). Refused while the interview or the kiosk already has a live session.",
    {
      interviewId: idInput.describe("Interview id"),
      workstationId: idInput.describe("Kiosk id"),
      siteRef: siteInput.optional(),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("POST");
      return text(await issueTestSession({ ...args, tenantId, access, actorId }));
    }, "hr_test_session_issue"),
  );

  server.tool(
    "hr_test_sessions_live_list",
    "The live kiosk grid for today at your site: candidate name, kiosk, session status (ISSUED | IN_PROGRESS | PAUSED | COMPLETED | EXPIRED | VOIDED), progress answered/total, time remaining and the integrity flag count. No scores.",
    { siteRef: siteInput.optional() },
    withToolError(async ({ siteRef }) => {
      const { tenantId, access } = authorized("GET");
      return text(await listLiveSessions({ tenantId, access, siteRef }));
    }, "hr_test_sessions_live_list"),
  );

  server.tool(
    "hr_test_session_pause",
    "Pause a running test session (the clock stops and the pause is recorded on the integrity timeline).",
    {
      sessionId: idInput.describe("Session id"),
      reason: z.string().max(1000).optional().describe("Why the session is paused"),
      siteRef: siteInput.optional(),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await pauseTestSession({ ...args, tenantId, access, actorId }));
    }, "hr_test_session_pause"),
  );

  server.tool(
    "hr_test_session_resume",
    "Resume a paused test session; the paused time is not counted against the candidate.",
    { sessionId: idInput.describe("Session id"), siteRef: siteInput.optional() },
    withToolError(async (args) => {
      const { tenantId, access } = authorized("PUT");
      return text(await resumeTestSession({ ...args, tenantId, access }));
    }, "hr_test_session_resume"),
  );

  server.tool(
    "hr_test_session_void",
    "Void a test session with a reason (kiosk failure, misconduct): the code and the kiosk session stop working and the attempt is INCOMPLETE for the recruiter to decide (retest, waive or release).",
    {
      sessionId: idInput.describe("Session id"),
      reason: z.string().min(1).max(1000).describe("Why the session is voided"),
      siteRef: siteInput.optional(),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("PUT");
      return text(await voidTestSession({ ...args, tenantId, access, actorId }));
    }, "hr_test_session_void"),
  );

  server.tool(
    "hr_test_session_extend",
    "Extend a live test session by some minutes with a reason (recruiter only), never past the test's maximum extra time.",
    {
      sessionId: idInput.describe("Session id"),
      minutes: z.number().int().min(1).max(120).describe("Minutes to add"),
      reason: z.string().min(1).max(1000).describe("Why the extension is granted"),
    },
    withToolError(async (args) => {
      const { tenantId, access, actorId } = authorized("PUT", "recruiter");
      return text(await extendTestSession({ ...args, tenantId, access, actorId }));
    }, "hr_test_session_extend"),
  );
}

export default registerReceptionTools;
