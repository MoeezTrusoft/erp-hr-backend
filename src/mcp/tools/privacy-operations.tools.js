// src/mcp/tools/privacy-operations.tools.js — Recruitment Phase 5 (plan 6.9)
// privacy operations (HR side).
//
//   hr_candidate_retention_runs_list       the tenant's retention runs, newest
//                                          first (counts), with the apply switch
//   hr_candidate_retention_run_get         one run: counts, candidate ids, legal
//                                          hold suspensions, sign-off eligibility
//   hr_candidate_retention_signoff         sign off a completed dry-run from the
//                                          last 7 days; switches apply on
//   hr_candidate_retention_apply_disable   switch apply off at once
//   hr_candidate_retention_owner_set       name the tenant's data-policy owner
//   hr_candidate_request_export_generate   build the access export of an ACCESS
//                                          request and store it in DAM
//
// Auth: hr:recruitment with the HTTP method (GET / PUT / POST, never an
// action name), ORG row scope (resolveRecruitmentScope), tenant and actor from
// the verified context only. The sign-off and the apply switch also require
// the tenant's data-policy owner (an admin while none is set); naming the
// owner requires an admin. The services enforce those rules.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitment-access.util.js";
import {
    disableRetentionApply,
    getRetentionRun,
    listRetentionRuns,
    setDataPolicyOwner,
    signOffRetentionRun,
} from "../../services/retention-run.service.js";
import { generateDsrAccessExport } from "../../services/dsr-export.service.js";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return ctx;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const authorize = (method) => {
    const { user, permissions } = getCtx();
    assertPermission(permissions, method, "hr:recruitment", user.isAdmin);
    return { user, tenantId: user.tenantId, scope: resolveRecruitmentScope(user) };
};

export const PRIVACY_OPERATIONS_TOOL_NAMES = Object.freeze([
    "hr_candidate_retention_runs_list",
    "hr_candidate_retention_run_get",
    "hr_candidate_retention_signoff",
    "hr_candidate_retention_apply_disable",
    "hr_candidate_retention_owner_set",
    "hr_candidate_request_export_generate",
]);

export function registerPrivacyOperationsTools(server) {
    server.tool(
        "hr_candidate_retention_runs_list",
        "The tenant's candidate retention runs, newest first: mode (DRY_RUN | APPLY), status (COMPLETED | FAILED), asOf, counts (wouldAnonymize, anonymized, suspendedByLegalHold), reportSentAt and the sign-off. Also returns the tenant's apply switch (retentionApplyEnabled, when and by whom, the signed-off run) and the data-policy owner.",
        {
            mode: z.enum(["DRY_RUN", "APPLY"]).optional().describe("Only runs of this mode"),
            status: z.enum(["COMPLETED", "FAILED"]).optional().describe("Only runs with this status"),
            page: z.coerce.number().int().min(1).optional().describe("Page number (default 1)"),
            limit: z.coerce.number().int().min(1).max(100).optional().describe("Rows per page (1-100, default 20)"),
        },
        withToolError(async ({ mode, status, page, limit }) => {
            const { tenantId, scope } = authorize("GET");
            return ok(await listRetentionRuns({ tenantId, scope, mode, status, page, limit }));
        }, "hr_candidate_retention_runs_list"),
    );

    server.tool(
        "hr_candidate_retention_run_get",
        "One retention run: its counts, the candidate ids it would anonymize (dry-run) or anonymized (apply), capped at 500 with a truncated marker, the candidates whose erasure a legal hold suspended (candidate and hold ids), the error of a failed run, and whether it can be signed off (signoff.eligible, signoff.reason).",
        {
            runId: z.coerce.number().int().positive().describe("Retention run id (references CandidateRetentionRun)"),
        },
        withToolError(async ({ runId }) => {
            const { tenantId, scope } = authorize("GET");
            return ok(await getRetentionRun({ tenantId, scope, runId }));
        }, "hr_candidate_retention_run_get"),
    );

    server.tool(
        "hr_candidate_retention_signoff",
        "Sign off a retention dry-run report and switch retention APPLY on for this tenant. Only the tenant's data-policy owner may do this (an admin while no owner is set). The run must be a DRY_RUN that COMPLETED within the last 7 days and not already signed off; a FAILED or stale run is refused. Needs the retention flag. From the next nightly run (with the env mode at apply) the tenant's due candidates are anonymized.",
        {
            runId: z.coerce.number().int().positive().describe("The dry-run being signed off (references CandidateRetentionRun)"),
            expectedVersion: z.coerce.number().int().min(0).optional().describe("The recruitment settings version you read (409 when it changed)"),
        },
        withToolError(async ({ runId, expectedVersion }) => {
            const { user, tenantId, scope } = authorize("PUT");
            return ok(await signOffRetentionRun({ tenantId, user, scope, runId, expectedVersion }));
        }, "hr_candidate_retention_signoff"),
    );

    server.tool(
        "hr_candidate_retention_apply_disable",
        "Switch retention APPLY off for this tenant at once: the next runs are dry-runs again until a new dry-run is signed off. Only the tenant's data-policy owner (an admin while no owner is set). Audited; idempotent.",
        {
            reason: z.string().max(500).optional().describe("Why apply is being switched off (kept in the audit log)"),
        },
        withToolError(async ({ reason }) => {
            const { user, tenantId, scope } = authorize("PUT");
            return ok(await disableRetentionApply({ tenantId, user, scope, reason }));
        }, "hr_candidate_retention_apply_disable"),
    );

    server.tool(
        "hr_candidate_retention_owner_set",
        "Name the tenant's data-policy owner: the employee who receives the retention dry-run reports and alone may sign one off or switch apply off. Admins only. Audited.",
        {
            employeeId: z.coerce.number().int().positive().describe("The owner's employee id (references Employee)"),
        },
        withToolError(async ({ employeeId }) => {
            const { user, tenantId, scope } = authorize("PUT");
            return ok(await setDataPolicyOwner({ tenantId, user, scope, employeeId }));
        }, "hr_candidate_retention_owner_set"),
    );

    server.tool(
        "hr_candidate_request_export_generate",
        "Generate the access export for an open ACCESS data-subject request: one JSON file of everything held about the request's candidate (profile, applications with stage history, answers, screening, interviews and scorecard ratings, test results, offers, communications log, consents, do-not-contact, talent pools and invitations, documents as metadata), uploaded to DAM. Stamps exportMediaId and exportGeneratedAt and moves the request to IN_PROGRESS. Staff free-text notes are withheld and listed with counts for manual review; no other person's data is included. Needs the dsrPortal flag.",
        {
            requestId: z.coerce.number().int().positive().describe("Data-subject request id (references CandidateDataAccessRequest)"),
        },
        withToolError(async ({ requestId }) => {
            const { user, tenantId, scope } = authorize("POST");
            return ok(await generateDsrAccessExport({ tenantId, requestId, actorId: user.employeeId ?? null, scope }));
        }, "hr_candidate_request_export_generate"),
    );
}

export default registerPrivacyOperationsTools;
