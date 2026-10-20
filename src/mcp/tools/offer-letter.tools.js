// src/mcp/tools/offer-letter.tools.js
//
// Recruitment Phase 3a — offer letter templates, rendered letter versions and
// the e-signature send/void.
//
// Who may do what (hr:recruitment, HTTP-method actions):
//   * templates list (GET): ORG, MANAGED, FINANCE; others get an empty list.
//   * template save / deactivate (PUT): ORG only.
//   * render (POST): only scopes that may see compensation (ORG, FINANCE),
//     since the letter prints the salary. flag offerLetters.
//   * versions list (GET): any scope that can reach the offer; no media ids or
//     hashes for scopes that may not see compensation.
//   * e-sign send (POST) / void (PUT): ORG only. flag esign, and a configured
//     provider (ESIGN_PROVIDER).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import {
    deactivateOfferLetterTemplate,
    listOfferLetterTemplates,
    listOfferLetterVersions,
    renderOfferLetterVersion,
    saveOfferLetterTemplate,
} from "../../services/offer-letter.service.js";
import { sendOfferForSignature, voidOfferSignature } from "../../services/offer-esign.service.js";
import { MERGE_FIELDS } from "../../lib/offer-letter-template.util.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);
const FIELD_LIST = MERGE_FIELDS.map((f) => `{{${f}}}`).join(", ");

export function registerOfferLetterTools(server) {
    server.tool(
        "hr_offer_letter_templates_list",
        "List the tenant's offer letter templates (every version; inUse marks the newest active version of each key, the one a render uses) plus the built-in STANDARD default (version 0) and the allowed merge fields",
        {
            key: z.string().max(40).optional().describe("Only this template key, e.g. STANDARD"),
            includeInactive: z.boolean().optional().describe("Include deactivated versions (default true)"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            const data = await listOfferLetterTemplates({
                tenantId: user.tenantId,
                scope: resolveRecruitmentScope(user),
                key: args.key ?? null,
                includeInactive: args.includeInactive ?? true,
            });
            return text(data);
        }, "hr_offer_letter_templates_list"),
    );

    server.tool(
        "hr_offer_letter_template_save",
        `Save an offer letter template (recruiters only): creates the next immutable version of the key, active and in use. Plain text, paragraphs separated by a blank line, at most 50 KB. Allowed merge fields: ${FIELD_LIST}`,
        {
            key: z.string().min(1).max(40).describe("Template key, e.g. STANDARD, CONTRACT, INTERNSHIP (matched to the offer type)"),
            name: z.string().min(1).max(200).describe("Display name"),
            subject: z.string().max(300).optional().describe("Letter subject line; may use merge fields"),
            body: z.string().min(1).describe("Letter body with {{merge.fields}}"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            const data = await saveOfferLetterTemplate({
                tenantId: user.tenantId,
                scope,
                actorId: scope.employeeId,
                key: args.key,
                name: args.name,
                subject: args.subject ?? null,
                body: args.body,
            });
            return text(data);
        }, "hr_offer_letter_template_save"),
    );

    server.tool(
        "hr_offer_letter_template_deactivate",
        "Deactivate one offer letter template version (recruiters only); the newest remaining active version of its key, else the built-in default, is used from then on",
        { id: idInput.describe("Template version id") },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const data = await deactivateOfferLetterTemplate({
                tenantId: user.tenantId,
                scope: resolveRecruitmentScope(user),
                id: args.id,
            });
            return text(data);
        }, "hr_offer_letter_template_deactivate"),
    );

    server.tool(
        "hr_offer_letter_render",
        "Render an offer's letter from the newest active template for its offer type (or templateKey) into a PDF in DAM as a new letter version, and make it the offer's letter; preview: true returns the text and missing-field warnings without storing anything. Needs compensation access; refused for ACCEPTED, DECLINED, EXPIRED or WITHDRAWN offers and while a letter is out for signature",
        {
            offerId: idInput.describe("Offer id"),
            templateKey: z.string().max(40).optional().describe("Template key to use instead of the one matching the offer type"),
            preview: z.boolean().optional().describe("Render the text only; store nothing"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            const data = await renderOfferLetterVersion({
                tenantId: user.tenantId,
                scope,
                offerId: args.offerId,
                templateKey: args.templateKey ?? null,
                preview: args.preview === true,
                actorId: scope.employeeId,
            });
            return text(data);
        }, "hr_offer_letter_render"),
    );

    server.tool(
        "hr_offer_letter_versions_list",
        "List an offer's rendered letter versions, newest first, with template, signature status and DAM media ids (media ids and hashes are withheld from scopes that may not see compensation)",
        { offerId: idInput.describe("Offer id") },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
            const data = await listOfferLetterVersions({
                tenantId: user.tenantId,
                scope: resolveRecruitmentScope(user),
                offerId: args.offerId,
            });
            return text(data);
        }, "hr_offer_letter_versions_list"),
    );

    server.tool(
        "hr_offer_esign_send",
        "Send a SENT offer's newest rendered letter to the candidate for e-signature (recruiters only). A signed letter accepts the offer and starts the hire handoff, so the employee category is fixed here. Refused for candidates on the do-not-contact register or without consent",
        {
            offerId: idInput.describe("Offer id"),
            employeeCategory: z
                .enum(["MANAGEMENT", "EMPLOYEE", "INTERNEE"])
                .optional()
                .describe("Category the hired employee's code is allocated from; required unless the offer already has one"),
            message: z.string().max(1000).optional().describe("Optional note shown to the candidate with the signature request"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            const data = await sendOfferForSignature({
                tenantId: user.tenantId,
                scope,
                offerId: args.offerId,
                employeeCategory: args.employeeCategory ?? null,
                message: args.message ?? null,
                actorId: scope.employeeId,
            });
            return text(data);
        }, "hr_offer_esign_send"),
    );

    server.tool(
        "hr_offer_esign_void",
        "Void the e-signature request of an offer's letter that is out for signature (recruiters only), with a reason; render a new letter version to send again",
        {
            offerId: idInput.describe("Offer id"),
            reason: z.string().min(1).max(500).describe("Why the signature request is withdrawn"),
        },
        withToolError(async (args) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const scope = resolveRecruitmentScope(user);
            const data = await voidOfferSignature({
                tenantId: user.tenantId,
                scope,
                offerId: args.offerId,
                reason: args.reason,
                actorId: scope.employeeId,
            });
            return text(data);
        }, "hr_offer_esign_void"),
    );
}
