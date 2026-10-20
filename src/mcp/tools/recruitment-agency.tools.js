// src/mcp/tools/recruitment-agency.tools.js — Recruitment Phase 5 agencies,
// HR side (plan 6.2, flag agencyPortal, HR_RECRUITMENT_AGENCY_PORTAL).
//
//   hr_recruitment_agencies_list              GET  agencies (status, name search)
//   hr_recruitment_agency_get                 GET  one agency + active assignments
//   hr_recruitment_agency_create              POST name, contact, ownershipDays, feePercent
//   hr_recruitment_agency_update              PUT  expectedVersion; status ACTIVE | SUSPENDED
//   hr_recruitment_agency_users_list          GET  the RBAC users that log in for agencies
//   hr_recruitment_agency_user_add            POST map an RBAC user id to an agency
//   hr_recruitment_agency_user_revoke         PUT  end a login's reach at once
//   hr_requisition_agency_assign              POST open a requisition to an agency (maxSubmissions)
//   hr_requisition_agency_unassign            PUT  end the assignment
//   hr_recruitment_agency_submissions_list    GET  submissions (status, agency, requisition)
//   hr_recruitment_agency_submission_review   PUT  ACCEPT into the pipeline / REJECT with a reason
//
// Gated on hr:recruitment with the HTTP method, and on the ORG recruitment
// scope (recruiters and HR) for every tool: agency names, fees and the people
// agencies put forward are recruiting-desk material, and an AGENCY caller must
// never read another agency's rows through here. Reads work with the flag off
// (they show what exists); writes are 503 HR-RECRUITMENT-AGENCY-PORTAL-DISABLED.
// The actor is the verified employee from the MCP context, never an argument.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { buildListPayload } from "../../utils/apiContract.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import {
    addAgencyUser,
    assignRequisitionToAgency,
    createAgency,
    getAgency,
    listAgencies,
    listAgencyUsers,
    revokeAgencyUser,
    unassignRequisitionFromAgency,
    updateAgency,
} from "../../services/recruitment-agency.service.js";
import { listAgencySubmissions, reviewAgencySubmission } from "../../services/agency-submission.service.js";

const RESOURCE = "hr:recruitment";

function authorized(method) {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    const { user } = ctx;
    assertPermission(ctx.permissions || {}, method, RESOURCE, user.isAdmin);
    if (!resolveRecruitmentScope(user).unrestricted) {
        throw Object.assign(new Error("Agency administration is for recruiters and HR"), {
            status: 403,
            code: "HR-RECRUITMENT-AGENCY-FORBIDDEN",
        });
    }
    return user;
}

const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const listReply = ({ items, total, page, pageSize }, sort, order, filters) =>
    reply(buildListPayload({ items, total, page, pageSize, sort, order, filters }));

const id = (what) => z.coerce.number().int().positive().describe(`${what} id`);
const paging = {
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
};
const agencyFields = {
    contactEmail: z.string().max(254).nullable().optional().describe("Agency contact email"),
    ownershipDays: z.coerce.number().int().min(0).max(730).optional()
        .describe("Days an accepted candidate stays this agency's (default 180); another agency's submission inside it is a duplicate"),
    feePercent: z.coerce.number().min(0).max(100).nullable().optional().describe("Agency fee, percent of first-year salary"),
    notes: z.string().max(2000).nullable().optional().describe("Internal notes (never shown to the agency)"),
};

export function registerRecruitmentAgencyTools(server) {
    server.tool(
        "hr_recruitment_agencies_list",
        "List the recruitment agencies the company works with (recruiters and HR only), optionally by status or name",
        {
            status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
            q: z.string().max(200).optional().describe("Name contains"),
            ...paging,
        },
        withToolError(async (args) => {
            const user = authorized("GET");
            const data = await listAgencies({ ...args, tenantId: user.tenantId });
            return listReply(data, "name", "asc", { status: args.status ?? null, q: args.q ?? null });
        }, "hr_recruitment_agencies_list"),
    );

    server.tool(
        "hr_recruitment_agency_get",
        "Get one recruitment agency with its active requisition assignments and active login count (recruiters and HR only)",
        { id: id("Agency") },
        withToolError(async ({ id: agencyId }) => {
            const user = authorized("GET");
            return reply({ success: true, data: await getAgency({ tenantId: user.tenantId, id: agencyId }) });
        }, "hr_recruitment_agency_get"),
    );

    server.tool(
        "hr_recruitment_agency_create",
        "Register a recruitment agency (recruiters and HR only). Unavailable (503) while agencies are switched off.",
        { name: z.string().min(1).max(200).describe("Agency name, unique in the company"), ...agencyFields },
        withToolError(async (input) => {
            const user = authorized("POST");
            const data = await createAgency({ tenantId: user.tenantId, actorId: user.employeeId ?? null, input });
            return reply({ success: true, data });
        }, "hr_recruitment_agency_create"),
    );

    server.tool(
        "hr_recruitment_agency_update",
        "Update a recruitment agency at the version you read (recruiters and HR only): name, contact, ownershipDays, feePercent, notes, or status ACTIVE / SUSPENDED (a suspended agency's logins see nothing). A stale expectedVersion is a 409.",
        {
            id: id("Agency"),
            expectedVersion: z.coerce.number().int().min(0).describe("The agency version you read"),
            name: z.string().min(1).max(200).optional(),
            status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
            ...agencyFields,
        },
        withToolError(async ({ id: agencyId, expectedVersion, ...input }) => {
            const user = authorized("PUT");
            const data = await updateAgency({ tenantId: user.tenantId, id: agencyId, expectedVersion, input });
            return reply({ success: true, data });
        }, "hr_recruitment_agency_update"),
    );

    server.tool(
        "hr_recruitment_agency_users_list",
        "List the RBAC users that log in for recruitment agencies (recruiters and HR only)",
        {
            agencyId: id("Agency").optional(),
            status: z.enum(["ACTIVE", "REVOKED"]).optional(),
        },
        withToolError(async (args) => {
            const user = authorized("GET");
            const data = await listAgencyUsers({ ...args, tenantId: user.tenantId });
            return reply({ success: true, data: data.items, total: data.total });
        }, "hr_recruitment_agency_users_list"),
    );

    server.tool(
        "hr_recruitment_agency_user_add",
        "Let an RBAC user (holding the AGENCY role) log in for an agency (recruiters and HR only). A user belongs to one agency; re-adding a revoked user reactivates it.",
        {
            agencyId: id("Agency"),
            userId: z.string().min(1).max(100).describe("The RBAC user id of the agency login"),
            email: z.string().max(254).optional().describe("The login's email, for display"),
        },
        withToolError(async (args) => {
            const user = authorized("POST");
            return reply({ success: true, data: await addAgencyUser({ ...args, tenantId: user.tenantId }) });
        }, "hr_recruitment_agency_user_add"),
    );

    server.tool(
        "hr_recruitment_agency_user_revoke",
        "Revoke an agency login (recruiters and HR only); from its next request it sees nothing",
        { id: id("Agency user") },
        withToolError(async ({ id: rowId }) => {
            const user = authorized("PUT");
            return reply({ success: true, data: await revokeAgencyUser({ tenantId: user.tenantId, id: rowId }) });
        }, "hr_recruitment_agency_user_revoke"),
    );

    server.tool(
        "hr_requisition_agency_assign",
        "Assign an open requisition (approved or posted, inside its closing date) to an active agency so it can submit candidates, optionally capped by maxSubmissions (recruiters and HR only)",
        {
            requisitionId: id("Requisition"),
            agencyId: id("Agency"),
            maxSubmissions: z.coerce.number().int().positive().max(1000).optional().describe("Most submissions the agency may make for it"),
            notes: z.string().max(2000).optional().describe("Internal notes (never shown to the agency)"),
        },
        withToolError(async (args) => {
            const user = authorized("POST");
            const data = await assignRequisitionToAgency({ ...args, tenantId: user.tenantId, actorId: user.employeeId ?? null });
            return reply({ success: true, data });
        }, "hr_requisition_agency_assign"),
    );

    server.tool(
        "hr_requisition_agency_unassign",
        "End an agency's assignment to a requisition (recruiters and HR only); pending submissions stay reviewable",
        { requisitionId: id("Requisition"), agencyId: id("Agency") },
        withToolError(async (args) => {
            const user = authorized("PUT");
            return reply({ success: true, data: await unassignRequisitionFromAgency({ ...args, tenantId: user.tenantId }) });
        }, "hr_requisition_agency_unassign"),
    );

    server.tool(
        "hr_recruitment_agency_submissions_list",
        "List candidate submissions from agencies (recruiters and HR only), filtered by status, agency or requisition",
        {
            status: z.enum(["PENDING_REVIEW", "ACCEPTED", "REJECTED", "DUPLICATE", "WITHDRAWN"]).optional(),
            agencyId: id("Agency").optional(),
            requisitionId: id("Requisition").optional(),
            ...paging,
        },
        withToolError(async (args) => {
            const user = authorized("GET");
            const data = await listAgencySubmissions({ ...args, tenantId: user.tenantId });
            return listReply(data, "createdAt", "desc", {
                status: args.status ?? null,
                agencyId: args.agencyId ?? null,
                requisitionId: args.requisitionId ?? null,
            });
        }, "hr_recruitment_agency_submissions_list"),
    );

    server.tool(
        "hr_recruitment_agency_submission_review",
        "Review an agency submission (recruiters and HR only). ACCEPT matches or creates the candidate and creates the application (source AGENCY) with the agency's ownership for its ownershipDays; a candidate owned by another agency inside its window, or already in process for the requisition, is recorded as DUPLICATE with the reason. REJECT needs a reason (the agency sees only a neutral one).",
        {
            id: id("Submission"),
            decision: z.enum(["ACCEPT", "REJECT"]),
            reason: z.string().max(1000).optional().describe("REJECT: why (internal)"),
        },
        withToolError(async ({ id: submissionId, decision, reason }) => {
            const user = authorized("PUT");
            const data = await reviewAgencySubmission({
                tenantId: user.tenantId,
                actorId: user.employeeId ?? null,
                id: submissionId,
                decision,
                reason,
            });
            return reply({ success: true, data });
        }, "hr_recruitment_agency_submission_review"),
    );
}

export default registerRecruitmentAgencyTools;
