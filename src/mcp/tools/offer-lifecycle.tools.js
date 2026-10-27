// src/mcp/tools/offer-lifecycle.tools.js
//
// Recruitment Phase 3a — offer lifecycle tools: decline capture, the decline
// vocabulary, expiry extension and the grade band check.
//
// Who may do what:
//   * hr_offer_decline_record (PUT): ORG (recruiters) only. Records the
//     candidate's decline of a SENT offer with a reason code (required here;
//     the legacy REST respond path keeps it optional), an optional note and
//     the talent pool opt-in. Goes through respondOffer, so it is the same
//     transition, event and replay rule as every other response.
//   * hr_offer_decline_reasons_list (GET): any recruitment scope.
//   * hr_offer_expiry_extend (PUT): ORG only (offer-expiry.service.js rules).
//     Phase 6: with HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL on, an offer whose
//     approval stands is not refused; the offer's creator gets a new HR
//     Approval Centre request (pendingApproval: true, extensionApproval) and
//     the date applies when it is approved (offer-extension.tools.js reads and
//     withdraws it).
//   * hr_offer_band_check (GET): scopes that may see compensation (ORG,
//     FINANCE) only; band figures are payroll data and a narrower caller could
//     otherwise bisect the band.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { maskOfferForScope, resolveRecruitmentScope } from "../../lib/recruitment-access.util.js";
import { DECLINE_NOTE_MAX_LENGTH, DECLINE_REASONS, DECLINE_REASON_CODES } from "../../lib/offer-decline.util.js";
import { respondOffer } from "../../services/offer.service.js";
import { extendOfferExpiry, MAX_EXTENSION_DAYS, REOPEN_WINDOW_DAYS } from "../../services/offer-expiry.service.js";
import { checkOfferSalaryBand } from "../../services/offer-mgmt.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const idInput = z.union([z.string(), z.number()]);

const requireOrg = (scope, message, code) => {
    if (scope.unrestricted !== true) throw fail(message, 403, code);
};

export function registerOfferLifecycleTools(server) {
    server.tool(
        "hr_offer_decline_record",
        "Record that the candidate declined a SENT offer (recruiters only): a decline reason code (see hr_offer_decline_reasons_list; OTHER needs a note), an optional note, and whether the candidate agreed to stay in the talent pool. A repeat of the same decline is replayed unchanged",
        {
            id: idInput.describe("Offer id"),
            declineReasonCode: z.enum(DECLINE_REASON_CODES).describe("Why the candidate declined"),
            declineNote: z.string().max(DECLINE_NOTE_MAX_LENGTH).optional().describe(`Free-text detail (max ${DECLINE_NOTE_MAX_LENGTH}); required for OTHER; never sent in events`),
            talentPoolOptIn: z.boolean().optional().describe("True when the candidate agreed to be kept in the talent pool; added only when consent and do-not-contact allow it"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            requireOrg(scope, "Only recruiters can record an offer decline", "HR-RECRUITMENT-OFFER-DECLINE-FORBIDDEN");
            const result = await respondOffer(args.id, false, user.tenantId, {
                actorId: scope.employeeId,
                declineReasonCode: args.declineReasonCode,
                declineNote: args.declineNote,
                talentPoolOptIn: args.talentPoolOptIn,
                requireDeclineReason: true,
            });
            return text({ ...result, offer: maskOfferForScope(result.offer, scope) });
        }, "hr_offer_decline_record"),
    );

    server.tool(
        "hr_offer_decline_reasons_list",
        "List the offer decline reason codes with their labels (OTHER requires a note)",
        {},
        withToolError(async () => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            return text({
                items: DECLINE_REASONS.map((r) => ({ ...r, noteRequired: r.code === "OTHER" })),
                noteMaxLength: DECLINE_NOTE_MAX_LENGTH,
            });
        }, "hr_offer_decline_reasons_list"),
    );

    server.tool(
        "hr_offer_expiry_extend",
        `Extend an offer's expiry (recruiters only): a SENT offer gets a later expiryDate; an EXPIRED offer goes back to SENT only within ${REOPEN_WINDOW_DAYS} days of expiring while its requisition is open. The new date must be in the future and at most ${MAX_EXTENSION_DAYS} days ahead; the candidate is reminded again before it. When the offer's terms were approved in the HR Approval Centre and re-approval is enabled, the offer stays as it is and its creator's extension request goes to the Centre (pendingApproval: true, extensionApproval); the new date applies once it is approved`,
        {
            id: idInput.describe("Offer id"),
            expiryDate: z.string().min(1).describe("New expiry, ISO 8601 date or date-time"),
            expectedVersion: z.number().int().optional().describe("Optimistic-concurrency guard; the version you last read. A stale value returns -32009"),
            reason: z.string().max(1000).optional().describe("Why the extension is needed; shown to the approvers when it goes to the HR Approval Centre"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            requireOrg(scope, "Only recruiters can extend an offer", "HR-RECRUITMENT-OFFER-EXTEND-FORBIDDEN");
            const offer = await extendOfferExpiry({
                tenantId: user.tenantId,
                id: args.id,
                expiryDate: args.expiryDate,
                expectedVersion: args.expectedVersion,
                reason: args.reason,
                scope,
                actorId: scope.employeeId,
            });
            return text(maskOfferForScope(offer, scope));
        }, "hr_offer_expiry_extend"),
    );

    server.tool(
        "hr_offer_band_check",
        "Check a base salary against the grade band of a requisition before saving an offer. Returns the band and SALARY_BELOW_BAND / SALARY_ABOVE_BAND warnings; never blocks. Only for callers who may see compensation",
        {
            jobRequisitionId: idInput.describe("Requisition id whose grade band applies"),
            baseSalary: z.coerce.number().positive().describe("The base salary to check"),
            currency: z.string().optional().describe("ISO 4217 currency of the figure; a band in another currency is reported as not comparable"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            if (!scope.canSeeCompensation) {
                throw fail("The salary band check is limited to roles that may see compensation", 403, "HR-RECRUITMENT-OFFER-BAND-FORBIDDEN");
            }
            const result = await checkOfferSalaryBand({
                tenantId: user.tenantId,
                jobRequisitionId: args.jobRequisitionId,
                salary: args.baseSalary,
                currency: args.currency ?? null,
            });
            if (!result.requisitionFound) throw fail("Job requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
            return text({
                jobRequisitionId: Number(args.jobRequisitionId),
                band: result.band,
                comparable: result.comparable,
                reason: result.reason,
                withinBand: result.comparable ? result.warnings.length === 0 : null,
                warnings: result.warnings,
            });
        }, "hr_offer_band_check"),
    );
}
