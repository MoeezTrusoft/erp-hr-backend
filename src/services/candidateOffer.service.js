import { z } from "zod";
import { createHash } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { decryptString } from "../lib/crypto.js";
import { downloadRecruitmentPdf } from "../lib/recruitmentDamPdf.js";
import { resolveStatusLink } from "./candidateVerification.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { respondOffer } from "./offer.service.js";
const missing = () =>
  Object.assign(
    new Error("This offer is not available. Request a new status link."),
    { status: 404, code: "HR-5507" },
  );
async function owned({ tenantId, token, offerId }, action) {
  const id =
    offerId == null ? null : z.coerce.number().int().positive().parse(offerId);
  return tenantTransaction(
    prisma,
    async (db) => {
      await db.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      const subject = await resolveStatusLink({ tenantId, token, db });
      if (!subject) throw missing();
      await db.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        subject.candidateId,
        tenantId,
      );
      const live = await resolveStatusLink({ tenantId, token, db });
      if (!live || live.candidateId !== subject.candidateId) throw missing();
      await assertCommunicationsAllowed(
        {
          tenantId,
          candidateId: subject.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db },
      );
      const rows = await db.offer.findMany({
        where: {
          tenantId,
          candidateId: subject.candidateId,
          status: { not: "DRAFT" },
          ...(id ? { id } : {}),
        },
        include: { jobRequisition: { select: { title: true } } },
        take: 100,
        orderBy: { id: "desc" },
      });
      if (id && !rows.length) throw missing();
      return action(db, rows);
    },
    { tenantId },
  );
}
export function listOwnOffers(input) {
  return owned(input, async (db, offers) => {
    const items = [];
    for (const offer of offers) {
      const signature = (
        await db.$queryRawUnsafe(
          'SELECT state,"signingUrlCipher","signedAt" FROM offer_signature_requests WHERE "tenantId"=$1::uuid AND "offerId"=$2',
          input.tenantId,
          offer.id,
        )
      )[0];
      items.push({
        id: offer.id,
        title: offer.jobRequisition.title,
        status: offer.status,
        currency: offer.currency,
        salary: Number(offer.salary),
        startDate: offer.startDate,
        expiryDate: offer.expiryDate,
        signatureState: signature?.state ?? null,
        signedAt: signature?.signedAt ?? null,
        signingUrl:
          offer.status === "SENT" &&
          (!offer.expiryDate || offer.expiryDate > new Date()) &&
          signature?.state === "AWAITING"
            ? decryptString(signature.signingUrlCipher)
            : null,
        hasLetter: !!offer.offerLetterMediaId,
      });
    }
    return { items };
  });
}
export async function downloadOwnOffer(
  input,
  { download = downloadRecruitmentPdf } = {},
) {
  const resolveDocument = () =>
    owned(input, async (db, [offer]) => {
      const job = (
        await db.$queryRawUnsafe(
          'SELECT "signedMediaId","signedSha256" FROM offer_signature_requests WHERE "tenantId"=$1::uuid AND "offerId"=$2',
          input.tenantId,
          offer.id,
        )
      )[0];
      const media = job?.signedMediaId ?? offer.offerLetterMediaId;
      if (!media) throw missing();
      const original = job?.signedMediaId
        ? null
        : (
            await db.$queryRawUnsafe(
              'SELECT sha256 FROM offer_letter_versions WHERE "tenantId"=$1::uuid AND "offerId"=$2 AND "mediaId"=$3',
              input.tenantId,
              offer.id,
              media,
            )
          )[0];
      const sha256 = job?.signedMediaId ? job.signedSha256 : original?.sha256;
      if (!sha256) throw missing();
      return { mediaId: media, sha256 };
    });
  const document = await resolveDocument();
  const bytes = await download(input.tenantId, document.mediaId);
  if (createHash("sha256").update(bytes).digest("hex") !== document.sha256)
    throw missing();
  // DAM can take time: recheck privacy, token validity and document identity before disclosure.
  const current = await resolveDocument();
  if (
    current.mediaId !== document.mediaId ||
    current.sha256 !== document.sha256
  )
    throw missing();
  return bytes;
}
export async function respondToOwnOffer(input) {
  const accepted = z.boolean().parse(input.accepted);
  const subject = await resolveStatusLink(input);
  if (!subject) throw missing();
  const result = await respondOffer(
    z.coerce.number().int().positive().parse(input.offerId),
    accepted,
    input.tenantId,
    { candidateId: subject.candidateId, candidateToken: input.token },
  );
  return {
    id: result.offer.id,
    status: result.offer.status,
    replayed: result.replayed,
  };
}
