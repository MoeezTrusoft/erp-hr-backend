import {
  enqueueCandidateCommunication,
  tokenFingerprint,
} from "./candidateCommunicationQueue.service.js";
import { portalBaseUrl } from "./recruitmentSettings.service.js";
export async function queueMailboxMessage(
  db,
  {
    tenantId,
    candidate,
    email,
    token,
    tokenPurpose,
    templateKey,
    expiresAt,
    applicationRef = null,
    jobTitle = "",
  },
) {
  const base = await portalBaseUrl(db, tenantId);
  const path =
    tokenPurpose === "DRAFT"
      ? "/draft"
      : tokenPurpose === "APPLY_VERIFICATION"
        ? "/verify"
        : "/status";
  const data = { firstName: candidate.firstName ?? "" };
  data[
    tokenPurpose === "DRAFT"
      ? "draftUrl"
      : tokenPurpose === "APPLY_VERIFICATION"
        ? "verifyUrl"
        : "statusUrl"
  ] = base + path + "#token=" + token;
  if (applicationRef != null) {
    data.applicationRef = String(applicationRef);
    data.jobTitle = jobTitle;
  }
  const tokenHash = tokenFingerprint(token);
  return enqueueCandidateCommunication(db, {
    tenantId,
    candidateId: candidate.id,
    applicationId: applicationRef == null ? null : Number(applicationRef),
    templateKey,
    dedupeKey: templateKey + ":" + tokenHash,
    context: { tokenHash, tokenPurpose },
    payload: { email, data },
    expiresAt,
  });
}
