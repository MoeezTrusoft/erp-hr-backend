// src/mcp/tools/agency-portal.tools.js — Recruitment Phase 5 agency portal,
// agency side (plan 6.2, flag agencyPortal, HR_RECRUITMENT_AGENCY_PORTAL).
//
//   hr_recruitment_agency_portal_requisitions_list  GET  open requisitions assigned to my agency
//   hr_recruitment_agency_portal_requisition_get    GET  one of them
//   hr_recruitment_agency_portal_submit             POST put a candidate forward (PENDING_REVIEW)
//   hr_recruitment_agency_portal_submissions_list   GET  my agency's submissions and their status
//
// Who may call: the AGENCY recruitment scope ONLY. Every other scope is refused
// (403 HR-RECRUITMENT-AGENCY-SCOPE-REQUIRED) — a recruiter has the HR tools,
// and an agency tool must never become a second door for anyone else. The
// agency is the caller's ACTIVE RecruitmentAgencyUser mapping (verified user id
// + tenant) to an ACTIVE agency, looked up here through withAgencyMembership;
// a caller with none sees no requisitions and cannot submit.
//
// Grant: hr:recruitment_agency (the agency logins' own resource, like hr:self
// for employees) or hr:recruitment, with the HTTP method's action. Agency roles
// should hold ONLY hr:recruitment_agency: several hr:recruitment tools are
// tenant-wide and not row-scoped (see p5-notes/C.md).
//
// Never export: nothing here returns a file, and assertNoAgencyExport refuses
// the AGENCY scope on every recruitment export.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { METHOD_ACTION, hasPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { buildListPayload } from "../../utils/apiContract.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { withAgencyMembership } from "../../lib/agency-access.util.js";
import { assertAgencyPortalEnabled } from "../../services/recruitment-agency.service.js";
import {
    assertAgencyScope,
    getAgencyRequisition,
    listAgencyRequisitions,
    listOwnAgencySubmissions,
    submitAgencyCandidate,
} from "../../services/agency-submission.service.js";

export const AGENCY_PORTAL_RESOURCE = "hr:recruitment_agency";

function assertAgencyGrant(permissions, method) {
    const action = METHOD_ACTION[method];
    if (!hasPermission(permissions, AGENCY_PORTAL_RESOURCE, action) && !hasPermission(permissions, "hr:recruitment", action)) {
        throw Object.assign(new Error(`Insufficient permissions: ${AGENCY_PORTAL_RESOURCE}:${action}`), { status: 403, code: "HR-4030" });
    }
}

/** Gate, flag, scope: the verified agency caller and its resolved scope. */
export async function agencyCaller(method) {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    assertAgencyGrant(ctx.permissions || {}, method);
    assertAgencyPortalEnabled();
    // Refuse a non-agency scope before any lookup.
    assertAgencyScope(resolveRecruitmentScope(ctx.user));
    const user = await withAgencyMembership(ctx.user);
    return { user, scope: resolveRecruitmentScope(user) };
}

const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const paging = {
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
};
const requisitionIdInput = z.coerce.number().int().positive().describe("Requisition id");

export function registerAgencyPortalTools(server) {
    server.tool(
        "hr_recruitment_agency_portal_requisitions_list",
        "Recruitment agency users only: the open requisitions assigned to your agency (title, description, location, employment type, closing date, your submission cap and count)",
        { q: z.string().max(200).optional().describe("Title contains"), ...paging },
        withToolError(async (args) => {
            const { user, scope } = await agencyCaller("GET");
            const data = await listAgencyRequisitions({ ...args, tenantId: user.tenantId, scope });
            return reply(buildListPayload({ ...data, sort: "createdAt", order: "desc", filters: { q: args.q ?? null } }));
        }, "hr_recruitment_agency_portal_requisitions_list"),
    );

    server.tool(
        "hr_recruitment_agency_portal_requisition_get",
        "Recruitment agency users only: one open requisition assigned to your agency",
        { requisitionId: requisitionIdInput },
        withToolError(async ({ requisitionId }) => {
            const { user, scope } = await agencyCaller("GET");
            return reply({ success: true, data: await getAgencyRequisition({ tenantId: user.tenantId, scope, requisitionId }) });
        }, "hr_recruitment_agency_portal_requisition_get"),
    );

    server.tool(
        "hr_recruitment_agency_portal_submit",
        "Recruitment agency users only: put a candidate forward for an open requisition assigned to your agency. The recruiter reviews it; the submission counts against the requisition's cap for your agency.",
        {
            requisitionId: requisitionIdInput,
            firstName: z.string().min(1).max(100),
            lastName: z.string().min(1).max(100),
            email: z.string().min(3).max(254),
            phone: z.string().max(40).optional(),
            resumeMediaId: z.coerce.number().int().positive().optional().describe("DAM media id of the resume"),
            note: z.string().min(1).max(2000).describe("Why this candidate fits"),
        },
        withToolError(async (input) => {
            const { user, scope } = await agencyCaller("POST");
            const data = await submitAgencyCandidate({ tenantId: user.tenantId, scope, userId: user.userId, input });
            return reply({ success: true, data });
        }, "hr_recruitment_agency_portal_submit"),
    );

    server.tool(
        "hr_recruitment_agency_portal_submissions_list",
        "Recruitment agency users only: your agency's submissions with their status (PENDING_REVIEW, ACCEPTED, REJECTED, WITHDRAWN)",
        {
            status: z.enum(["PENDING_REVIEW", "ACCEPTED", "REJECTED", "WITHDRAWN"]).optional(),
            requisitionId: requisitionIdInput.optional(),
            ...paging,
        },
        withToolError(async (args) => {
            const { user, scope } = await agencyCaller("GET");
            const data = await listOwnAgencySubmissions({ ...args, tenantId: user.tenantId, scope });
            return reply(buildListPayload({
                ...data,
                sort: "createdAt",
                order: "desc",
                filters: { status: args.status ?? null, requisitionId: args.requisitionId ?? null },
            }));
        }, "hr_recruitment_agency_portal_submissions_list"),
    );
}

export default registerAgencyPortalTools;
