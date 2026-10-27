// src/mcp/tools/interview-scheduling.tools.js
//
// Recruitment Phase 3a — slot finding, candidate self-scheduling, no-show and
// calendar re-sync.
//
// Who may do what (resolveRecruitmentScope; out-of-scope rows are not found):
//   * propose / send / cancel a slot offer: recruiters (ORG), or a hiring
//     manager on their own requisition (MANAGED). Others get 403.
//   * list slot offers: any recruitment scope, cut to the applications the
//     caller can see.
//   * no-show: anyone who can see the interview (a recruiter, the
//     requisition's manager, or a panelist on it).
//   * calendar re-sync: ORG, or MANAGED on their own requisition.
// Every tool checks hr:recruitment with its HTTP method first.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitment-access.util.js";
import {
  INTERVIEW_TYPES,
  SLOT_OFFER_STATUS,
  cancelSlotOffer,
  listSlotOffers,
  proposeSlots,
  sendSlotOffer,
} from "../../services/interview-slot-offer.service.js";
import { markNoShow } from "../../services/interview-schedule.service.js";
import { requeueInterviewCalendarSync } from "../../services/interview-calendar-sync.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);
const panelInput = z.array(z.coerce.number().int().positive()).min(1).max(10);
const slotInput = z.array(z.union([z.string(), z.object({ start: z.string(), end: z.string().optional() })])).min(1).max(10);

// One shape for every tool: permission first, then the caller's scope.
function authorized(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  const scope = resolveRecruitmentScope(user);
  return { user, scope, actorId: scope.employeeId ?? null };
}

export function registerInterviewSchedulingTools(server) {
  server.tool(
    "hr_interview_slots_propose",
    "Propose 3-5 interview slots in which the whole chosen panel is free (calendar free-busy when available, the panel's scheduled interviews, approved leave, work schedules, the company's working hours and time zone), at least 24 hours ahead and spread across days. A preview unless save is true, which stores it as a PROPOSED slot offer.",
    {
      applicationId: idInput.describe("Application id"),
      interviewerIds: panelInput.describe("Panel employee ids"),
      interviewType: z.enum(INTERVIEW_TYPES).optional().describe("Interview type (default PANEL)"),
      durationMinutes: z.coerce.number().int().min(15).max(480).optional().describe("Length (default 60)"),
      location: z.string().max(500).optional().describe("Room, address or meeting link"),
      from: z.string().optional().describe("Search from (ISO 8601); never earlier than 24 h from now"),
      to: z.string().optional().describe("Search until (ISO 8601); default the next 10 working days"),
      count: z.coerce.number().int().min(3).max(5).optional().describe("How many slots (3-5, default 5)"),
      save: z.boolean().optional().describe("Store the proposal as a PROPOSED slot offer"),
    },
    withToolError(async (args) => {
      const { user, scope, actorId } = authorized("POST");
      const data = await proposeSlots({ ...args, tenantId: user.tenantId, actorId, scope, save: args.save === true });
      return text(data);
    }, "hr_interview_slots_propose"),
  );

  server.tool(
    "hr_interview_slot_offer_send",
    "Send interview slots to the candidate through their portal link: either a saved proposal (slotOfferId, optionally trimming its slots) or a set given here. Every slot is re-checked for the panel; any other open offer for the application is cancelled; a do-not-contact candidate is refused.",
    {
      slotOfferId: idInput.optional().describe("A PROPOSED slot offer to send"),
      applicationId: idInput.optional().describe("Application id (when sending a new set)"),
      interviewerIds: panelInput.optional().describe("Panel employee ids (when sending a new set)"),
      interviewType: z.enum(INTERVIEW_TYPES).optional().describe("Interview type (default PANEL)"),
      durationMinutes: z.coerce.number().int().min(15).max(480).optional().describe("Length (default 60)"),
      location: z.string().max(500).optional().describe("Room, address or meeting link"),
      slots: slotInput.optional().describe("Slot start times (ISO 8601), or { start } objects"),
    },
    withToolError(async (args) => {
      const { user, scope, actorId } = authorized("POST");
      const data = await sendSlotOffer({ ...args, tenantId: user.tenantId, actorId, scope });
      return text(data);
    }, "hr_interview_slot_offer_send"),
  );

  server.tool(
    "hr_interview_slot_offer_cancel",
    "Cancel a PROPOSED or SENT interview slot offer with a reason; the candidate's link stops working.",
    {
      slotOfferId: idInput.describe("Slot offer id"),
      reason: z.string().min(1).max(500).describe("Why the offer is withdrawn"),
    },
    withToolError(async ({ slotOfferId, reason }) => {
      const { user, scope, actorId } = authorized("PUT");
      const data = await cancelSlotOffer({ slotOfferId, reason, tenantId: user.tenantId, actorId, scope });
      return text(data);
    }, "hr_interview_slot_offer_cancel"),
  );

  server.tool(
    "hr_interview_slot_offers_list",
    "List interview slot offers for an application or a requisition, with their status (PROPOSED | SENT | CONFIRMED | EXPIRED | CANCELLED), slots, expiry and the interview a confirmed offer created, limited to the applications you can see",
    {
      applicationId: idInput.optional().describe("Only this application"),
      requisitionId: idInput.optional().describe("Only this requisition"),
      status: z.enum(Object.values(SLOT_OFFER_STATUS)).optional().describe("Filter by status"),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 50, max 100)"),
    },
    withToolError(async (args) => {
      const { user, scope } = authorized("GET");
      const data = await listSlotOffers({ ...args, tenantId: user.tenantId, scope });
      return text(data);
    }, "hr_interview_slot_offers_list"),
  );

  server.tool(
    "hr_interview_no_show",
    "Record that the candidate did not attend a SCHEDULED interview whose start has passed: the interview becomes NO_SHOW, a NO_SHOW lifecycle event is recorded, its calendar event is cancelled and the recruiter is prompted for a disposition.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id"),
      notes: z.string().max(1000).optional().describe("Optional note (e.g. how the candidate was contacted)"),
    },
    withToolError(async ({ interviewId, notes }) => {
      const { user, scope, actorId } = authorized("PUT");
      const data = await markNoShow({ interviewId, notes: notes ?? null, tenantId: user.tenantId, actorId, scope });
      return text(data);
    }, "hr_interview_no_show"),
  );

  server.tool(
    "hr_interview_calendar_resync",
    "Queue one interview for a fresh calendar write through the Communication module (create, update or cancel as its state needs), resetting the retry count. Use after a FAILED sync once the cause is fixed.",
    {
      interviewId: z.coerce.number().int().positive().describe("Interview id"),
    },
    withToolError(async ({ interviewId }) => {
      const { user, scope } = authorized("POST");
      const data = await requeueInterviewCalendarSync({ interviewId, tenantId: user.tenantId, scope });
      return text(data);
    }, "hr_interview_calendar_resync"),
  );
}

export default registerInterviewSchedulingTools;
