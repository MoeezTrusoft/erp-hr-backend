// src/mcp/tools/recruitment-document-download.tools.js
//
// Recruitment Phase 7 (B7) — open recruitment documents stored in DAM. Each
// tool returns the file inline as base64 with its MIME type and file name
// (at most 15 MB), the same shape as hr_self_onboarding_document_download.
//
// Who may open what (hr:recruitment GET first; the record's own service then
// decides, and anything the caller may not open reads as not found):
//   * hr_recruitment_offer_letter_download: scopes that may see compensation
//     (ORG, FINANCE) on an offer their offer read reaches; the letter prints
//     the salary, so a hiring manager (MANAGED) is refused (403).
//   * hr_recruitment_interview_packet_document_download: recruiters (ORG) and
//     the interview's panelists (their own packet view).
//   * hr_recruitment_test_item_picture_download: assessment authors (own and
//     published items), reviewers and recruiters. Flag onsiteTest.
// A DAM outage answers HR-5032 (details.code HR-RECRUITMENT-DOCUMENT-
// UNAVAILABLE, retryable).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitment-access.util.js";
import { resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import { downloadOfferLetter } from "../../services/offer-letter.service.js";
import { downloadPacketDocument } from "../../services/interview-packet.service.js";
import { downloadTestItemPicture } from "../../services/test-item.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);

function reader() {
    const { user, permissions } = getCtx();
    assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
    return user;
}

export function registerRecruitmentDocumentDownloadTools(server) {
    server.tool(
        "hr_recruitment_offer_letter_download",
        "Open an offer's letter PDF (recruiters and finance only: the letter shows the salary). Without versionId it is the offer's current letter; versionId picks a rendered version of this offer, and signed=true its signed copy (or the newest version's). Returns the file as base64 with its MIME type and file name (at most 15 MB).",
        {
            offerId: idInput.describe("Offer id"),
            versionId: idInput.optional().describe("A letter version id of this offer (from hr_offer_letter_versions_list)"),
            signed: z.boolean().optional().describe("The signed copy instead of the rendered letter"),
        },
        withToolError(async ({ offerId, versionId, signed }) => {
            const user = reader();
            return text(await downloadOfferLetter({
                tenantId: user.tenantId,
                scope: resolveRecruitmentScope(user),
                offerId,
                versionId: versionId ?? null,
                signed: signed === true,
            }));
        }, "hr_recruitment_offer_letter_download"),
    );

    server.tool(
        "hr_recruitment_interview_packet_document_download",
        "Open one document of an interview's packet: recruiters from the full packet, a panelist from their own packet view (hr_interview_packet_view). Pick it by itemId, or by mediaId for the resume (which has no packet row). Returns the file as base64 with its MIME type and file name (at most 15 MB).",
        {
            interviewId: idInput.describe("Interview id"),
            itemId: idInput.optional().describe("Packet item id"),
            mediaId: idInput.optional().describe("The document's mediaId from the packet view (use for the resume)"),
        },
        withToolError(async ({ interviewId, itemId, mediaId }) => {
            const user = reader();
            const scope = resolveRecruitmentScope(user);
            return text(await downloadPacketDocument({
                interviewId,
                itemId: itemId ?? null,
                mediaId: mediaId ?? null,
                tenantId: user.tenantId,
                scope,
                viewerEmployeeId: scope.employeeId ?? null,
            }));
        }, "hr_recruitment_interview_packet_document_download"),
    );

    server.tool(
        "hr_recruitment_test_item_picture_download",
        "Open the picture of a test item (assessment authors for their own and published items, reviewers and recruiters). Returns the image as base64 with its MIME type and file name (at most 15 MB).",
        { itemId: idInput.describe("Test item id") },
        withToolError(async ({ itemId }) => {
            const user = reader();
            return text(await downloadTestItemPicture({
                tenantId: user.tenantId,
                access: resolveAssessmentAccess(user),
                itemId,
            }));
        }, "hr_recruitment_test_item_picture_download"),
    );
}

export default registerRecruitmentDocumentDownloadTools;
