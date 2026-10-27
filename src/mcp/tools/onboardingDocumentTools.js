import { z } from "zod";
import { mcpCtx } from "../context.js";
import { withToolError } from "../utils/toolError.js";
import {
  listOnboardingDocuments,
  uploadOnboardingDocument,
  downloadOnboardingDocument,
  reviewOnboardingDocument,
} from "../../services/onboardingDocuments.service.js";
import {
  requestOnboardingSignature,
  cancelOnboardingSignature,
  openOnboardingSignature,
} from "../../services/onboardingSignatures.service.js";
export function registerOnboardingDocumentTools(server) {
  const id = z.number().int().positive();
  const entries = [
    [
      "hr_onboarding_portal_documents_list",
      "List private onboarding document status for the employee or authorized HR",
      { checklistId: id.optional() },
      listOnboardingDocuments,
    ],
    [
      "hr_onboarding_document_upload",
      "Upload a private PDF or Word document with a stable retry key; admission waits for malware scanning",
      {
        checklistId: id.optional(),
        title: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100).optional(),
        requiresSign: z.boolean().optional(),
        requestKey: z.string().regex(/^[a-zA-Z0-9:_-]{16,120}$/),
        contentBase64: z.string().min(4).max(6990508),
      },
      uploadOnboardingDocument,
    ],
    [
      "hr_onboarding_document_download",
      "Download verified private original or signed onboarding evidence",
      { documentId: id, signed: z.boolean().optional() },
      downloadOnboardingDocument,
    ],
    [
      "hr_onboarding_document_review",
      "Record HR review against the current immutable document version",
      {
        documentId: id,
        expectedVersion: z.number().int().nonnegative(),
        reviewState: z.enum(["VERIFIED", "REJECTED"]),
        note: z.string().trim().min(1).max(2000).optional(),
      },
      reviewOnboardingDocument,
    ],
    [
      "hr_onboarding_document_signature_request",
      "After HR review and confirmation of the current employee mailbox, request one company LibreSign invitation",
      {
        documentId: id,
        expectedVersion: z.number().int().positive(),
        confirmedEmail: z.string().email().max(320),
        recipientConfirmed: z.literal(true),
      },
      requestOnboardingSignature,
    ],
    [
      "hr_onboarding_document_signature_cancel",
      "Cancel an incomplete employee signature request with an audit reason",
      { documentId: id, reason: z.string().trim().min(1).max(2000) },
      cancelOnboardingSignature,
    ],
    [
      "hr_onboarding_document_signature_open",
      "Open the verified employee’s own private signing session; never cache this response",
      { documentId: id },
      openOnboardingSignature,
    ],
  ];
  for (const [name, description, schema, operation] of entries)
    server.tool(
      name,
      description,
      schema,
      withToolError(
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await operation(args, mcpCtx.getStore()?.user?.tenantId),
              ),
            },
          ],
        }),
        name,
      ),
    );
}
