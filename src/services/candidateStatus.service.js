// src/services/candidateStatus.service.js
//
// Phase 5 / decision record §3.5a — the candidate's SELF-SERVICE application
// status view, delivered through a magic status link (the §3.2 token pattern,
// purpose STATUS_LINK).
//
// The contract this service enforces:
//   * possession of the link = possession of the mailbox (the link is emailed
//     to the address; requesting one for ANY address yields the SAME uniform
//     response, so the request endpoint cannot be probed for which emails
//     have applied — §3.4);
//   * the response carries ONLY the candidate-visible projection
//     (lib/candidateStatusView.js): job title, simplified status, updated-at.
//     No internal stage names, no rejection reasons, no recruiter comments,
//     no scores, no interviewer data, no ids beyond the requisition title;
//   * a link that is wrong, revoked, expired — or held by a candidate with no
//     visible applications — renders the SAME empty body on the wire.
import prisma from "../config/prisma.js";
import { projectCandidateStatusList } from "../lib/candidateStatusView.js";
import {
  issueStatusLink,
  resolveStatusLink,
} from "./candidateVerification.service.js";
import { tenantTransaction } from "../lib/rlsTenant.js";

const fail = (message, status, code, details) =>
  Object.assign(new Error(message), {
    status,
    code,
    ...(details ? { details } : {}),
  });

/**
 * Request a status link for an email address. Uniform by construction: a
 * brand-new address (never applied), an existing candidate, an archived row —
 * every path returns the same { accepted: true } and only the REAL candidate's
 * mailbox ever receives a link. Never throws on the "not found" path; the
 * errors it does throw are 500-class (genuine failures).
 */
export const requestStatusLink = async ({ tenantId, email } = {}) => {
  const address = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw fail(
      "A valid email address is required",
      400,
      "HR-PORTAL-STATUS-EMAIL-INVALID",
    );
  }

  const candidate = await prisma.candidate.findFirst({
    where: { tenantId, email: address, anonymizedAt: null, status: "active" },
    select: { id: true, firstName: true, email: true },
  });

  if(candidate) await tenantTransaction(prisma,tx=>issueStatusLink(tx,{tenantId,candidate,email:address}),{tenantId});

  // Same wire body whether or not the address exists (§3.4).
  return { accepted: true };
};

/**
 * Read the visible statuses behind a presented link. The ROUTE renders the
 * same empty body for every "nothing to show" outcome, so this returns a
 * single shape: { candidateId } when the link is live, null otherwise.
 */
export const readStatusViaLink = async ({ tenantId, token } = {}) => {
  const resolved = await resolveStatusLink({ tenantId, token });
  if (!resolved) return null;

  const applications = await prisma.application.findMany({
    where: {
      candidateId: resolved.candidateId,
      tenantId,
      // Anonymization/archival of the candidate must not resurrect their
      // history here; the candidate row is already filtered by the link
      // being live, so the applications join the visible set directly.
    },
    include: {
      jobRequisition: { select: { title: true } },
      offer: { select: { status: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  return {
    candidateId: resolved.candidateId,
    view: projectCandidateStatusList(applications),
  };
};
