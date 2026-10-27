import { createHash } from "node:crypto";
import {
  RECRUITMENT_MESSAGE_TEMPLATES,
  RECRUITMENT_TOKEN_TEMPLATES,
} from "@trusoft/contracts/recruitment-communications";
import { encryptString } from "../lib/crypto.js";
import { z } from "zod";
export const CommunicationContext = z
  .object({
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    tokenPurpose: z
      .enum(["APPLY_VERIFICATION", "STATUS_LINK", "DRAFT"])
      .optional(),
    invitationId: z.number().int().positive().optional(),
    reminderKind: z.enum(["DAY_BEFORE", "ONE_HOUR"]).optional(),
    interviewLifecycleId: z.number().int().nonnegative().optional(),
    slotOfferId: z.number().int().positive().optional(),
    interviewId: z.number().int().positive().optional(),
    offerId: z.number().int().positive().optional(),
    expectedApplicationVersion: z.number().int().positive().optional(),
    expectedStage: z.string().max(30).optional(),
    expectedOfferStatus: z.string().max(30).optional(),
    eventTime: z.string().optional(),
  })
  .strict();
export async function enqueueCandidateCommunication(
  db,
  {
    tenantId,
    candidateId,
    applicationId = null,
    templateKey,
    channel = "EMAIL",
    purpose = "PROCESSING",
    dedupeKey,
    sourceEventId = null,
    context = {},
    payload = null,
    scheduledAt = new Date(),
    expiresAt = null,
  },
) {
  if (!RECRUITMENT_MESSAGE_TEMPLATES[templateKey])
    throw new Error("Unknown candidate communication template");
  const parsed = CommunicationContext.parse(context);
  if (payload && !RECRUITMENT_TOKEN_TEMPLATES.includes(templateKey))
    throw new Error(
      "Only mailbox link messages may carry an encrypted payload",
    );
  if (
    RECRUITMENT_TOKEN_TEMPLATES.includes(templateKey) &&
    (!payload || !parsed.tokenHash || !parsed.tokenPurpose || !expiresAt)
  )
    throw new Error(
      "Mailbox messages require encrypted payload, token reference and expiry",
    );
  if (!dedupeKey || dedupeKey.length > 200)
    throw new Error("A bounded dedupe key is required");
  // ON CONFLICT avoids poisoning the caller transaction during concurrent retries.
  await db.candidateCommunication.createMany({
    data: [
      {
        tenantId,
        candidateId,
        applicationId,
        templateKey,
        channel,
        purpose,
        dedupeKey,
        sourceEventId,
        context: parsed,
        encryptedPayload: payload
          ? encryptString(JSON.stringify(payload))
          : null,
        scheduledAt,
        expiresAt: expiresAt ?? new Date(scheduledAt.getTime() + 7 * 86400000),
      },
    ],
    skipDuplicates: true,
  });
  return db.candidateCommunication.findUnique({
    where: { tenantId_dedupeKey: { tenantId, dedupeKey } },
  });
}
export const tokenFingerprint = (token) =>
  createHash("sha256").update(token).digest("hex");
