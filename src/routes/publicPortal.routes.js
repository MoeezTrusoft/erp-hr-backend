import { jobBoardFeed, jobBoardApplyRedirect } from "../services/job-board-feeds.service.js";
import {
  listOwnInterviews,
  downloadOwnInterviewCalendar,
  requestOwnInterviewReschedule,
} from "../services/candidateInterviews.service.js";
import { listOwnSlotOffers, bookOwnSlot } from "../services/interviewSlots.service.js";
import {
  listOwnOffers,
  downloadOwnOffer,
  respondToOwnOffer,
} from "../services/candidateOffer.service.js";
import {
  listOwnInvitations,
  respondToOwnInvitation,
} from "../services/talentPoolInvitation.service.js";
import { consumeRecruitmentLimit } from "../lib/recruitmentRateLimit.js";
// src/routes/publicPortal.routes.js
//
// Phase 5 / decision record §3.1 — the PUBLIC careers-portal API.
//
// Mounted OUTSIDE the /api internal-service guard (like the device intake
// router), because an anonymous visitor cannot present a gateway service-JWT —
// §3.1 makes discovery and application login-free. "Public" does not mean
// unguarded; the guards here are the ones the internet actually requires:
//
//   * TENANT PINNING — every request is scoped to ONE tenant, resolved from the
//     portal host mapping (HR_PORTAL_HOSTS, "host=tenantUuid" pairs) or the
//     X-Portal-Tenant header set by the trusted edge. Never from a
//     candidate-supplied body field; a request with no resolvable tenant is 404
//     like any unknown site, not an error that confirms the portal exists.
//   * RATE LIMITING — an in-memory fixed-window limiter, keyed by IP and route
//     class. Deliberately dependency-free: the deploy has Redis, but the portal
//     must degrade to "closed" rather than "open" if Redis is down, and a
//     per-process limiter still caps the blast radius of a credential-stuffing
//     sweep against one pod. The application endpoint gets the strictest class.
//   * UNIFORM FAILURES — unknown job, closed job and cross-tenant job all
//     return the same 404 body, so the API cannot be probed for internal ids
//     (§3.4's rule, applied to jobs as well as emails).
import express from "express";
import { mcpCtx } from "../lib/requestContext.js";
import {
  listPublicJobs,
  getPublicJob,
  submitPublicApplication,
} from "../services/publicPortal.service.js";
import { consumeEmailVerification } from "../services/candidateVerification.service.js";
import { requestStatusLink, readStatusViaLink } from "../services/candidateStatus.service.js";
import {
  saveApplicationDraft,
  updateApplicationDraft,
  loadApplicationDraft,
  submitApplicationDraft,
} from "../services/applicationDraft.service.js";
import {
  withdrawOwnApplication,
  candidatePreferences,
  saveCandidatePreferences,
  requestOwnData,
} from "../services/candidatePortalSelf.service.js";
import { uploadDraftResume } from "../services/candidatePortalDocument.service.js";
import { portalPolicy } from "../lib/portalPolicy.js";
import logger from "../lib/logger.js";

const router = express.Router();

// ── Tenant resolution ────────────────────────────────────────────────────────
//
// HR_PORTAL_HOSTS format: "careers.acme.com=uuid1,jobs.example.org=uuid2".
// Host matching is exact and lower-cased; the X-Portal-Tenant header is only
// honored from the trusted edge (the same cluster that injects internal
// secrets), which in this slice means requests that arrived through the
// gateway's rewrite — a direct external caller cannot set it and reach this
// router unless the operator exposed the port, which is a deployment error the
// limiter will make noisy anyway.
const parseHostMap = () => {
  const raw = process.env.HR_PORTAL_HOSTS || "";
  const map = new Map();
  for (const pair of raw.split(",")) {
    const [host, tenant] = pair.split("=").map((s) => s && s.trim());
    if (host && tenant) map.set(host.toLowerCase(), tenant);
  }
  return map;
};

export function resolvePortalTenant(req) {
  const host = String(req.hostname || "").toLowerCase();
  const tenant = parseHostMap().get(host);
  if (tenant) return tenant;
  // Trusted-edge override: only meaningful behind the gateway, which strips
  // this header from public traffic before proxying.
  if (process.env.HR_PORTAL_TRUST_EDGE_HEADER === "true") {
    const headerTenant = req.get("X-Portal-Tenant");
    if (headerTenant && /^[0-9a-f-]{36}$/i.test(headerTenant)) return headerTenant;
  }
  return null;
}

// ── Rate limiting (fixed window, in memory) ─────────────────────────────────
function rateLimit(routeClass) {
  return async (req, res, next) => {
    try {
      await consumeRecruitmentLimit("portal:" + req.hostname + ":" + routeClass + ":" + req.ip, {
        limit:
          routeClass === "apply" || routeClass === "feed" ? 6 : routeClass === "draft" ? 60 : 120,
        client: req.app.locals.recruitmentRateLimitClient,
      });
      next();
    } catch (e) {
      res.status(e.status ?? 503).json({
        success: false,
        message: e.status === 429 ? "Too many requests" : "Service temporarily unavailable",
      });
    }
  };
}

const guard = (routeClass, handler) => [
  rateLimit(routeClass),
  async (req, res) => {
    const tenantId = resolvePortalTenant(req);
    if (!tenantId) {
      // 404, not 401/403: a tenant-less request is "no such site".
      return res.status(404).json({ success: false, message: "Not found" });
    }
    try {
      res.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      return await mcpCtx.run({ user: { tenantId }, publicPortal: true }, () =>
        handler(req, res, tenantId),
      );
    } catch (err) {
      const status = err?.name === "ZodError" ? 400 : Number(err?.status) || 500;
      if (status >= 500)
        logger.error({ err: err?.message, route: req.path }, "public portal route failed");
      // Error bodies are uniform on purpose — see the header comment.
      return res.status(status).json({
        success: false,
        message:
          status >= 500
            ? "Something went wrong"
            : err?.name === "ZodError"
              ? "Please check the supplied information"
              : err.message,
        ...(err?.details ? { details: err.details } : {}),
      });
    }
  },
];

router.get(
  "/policy",
  ...guard("read", async (_req, res, tenantId) =>
    res.json({ success: true, data: portalPolicy(tenantId) }),
  ),
);
router.put(
  "/candidates/draft",
  ...guard("draft", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await updateApplicationDraft({
        tenantId,
        token: req.get("X-Candidate-Token"),
        body: req.body?.payload,
        expectedUpdatedAt: req.body?.expectedUpdatedAt,
      }),
    }),
  ),
);

router.get(
  "/candidates/invitations",
  ...guard("read", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await listOwnInvitations({
        tenantId,
        token: req.get("X-Candidate-Token"),
      }),
    }),
  ),
);
router.put(
  "/candidates/invitations/:id",
  express.json({ limit: "16kb" }),
  ...guard("draft", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await respondToOwnInvitation({
        tenantId,
        token: req.get("X-Candidate-Token"),
        invitationId: req.params.id,
        response: req.body?.response,
      }),
    }),
  ),
);

// ── Routes ───────────────────────────────────────────────────────────────────

router.get(
  "/job-boards/:channel.xml",
  ...guard("feed", async (req, res, tenantId) => {
    const xml = await jobBoardFeed({ tenantId, channel: String(req.params.channel).toUpperCase() });
    res.set({
      "Content-Type": "application/xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    return res.send(xml);
  }),
);

// The feeds use direct landing URLs as required by current provider rules.
// This explicit redirect is also available to existing channel campaign links.
router.get(
  "/job-boards/:channel/jobs/:id/apply",
  ...guard("read", async (req, res, tenantId) => {
    const target = await jobBoardApplyRedirect({
      tenantId,
      requisitionId: req.params.id,
      channel: String(req.params.channel).toUpperCase(),
    });
    return res.redirect(302, target);
  }),
);

// GET /public/jobs?q= — open, eligible jobs for this portal's tenant.
router.get(
  "/jobs",
  ...guard("read", async (req, res, tenantId) => {
    const jobs = await listPublicJobs({
      tenantId,
      prisma: (await import("../config/prisma.js")).default,
      q: req.query.q ?? null,
    });
    return res.json({ success: true, data: jobs });
  }),
);

// GET /public/jobs/:id — one job's public detail.
router.get(
  "/jobs/:id",
  ...guard("read", async (req, res, tenantId) => {
    const job = await getPublicJob({
      tenantId,
      prisma: (await import("../config/prisma.js")).default,
      id: req.params.id,
    });
    // Unknown id, closed job and cross-tenant id are all the same 404.
    if (!job) return res.status(404).json({ success: false, message: "Position not found" });
    return res.json({ success: true, data: job });
  }),
);

// POST /public/jobs/:id/apply — anonymous application intake.
router.post(
  "/jobs/:id/apply",
  express.json({ limit: "256kb" }),
  ...guard("apply", async (req, res, tenantId) => {
    const result = await submitPublicApplication({
      tenantId,
      requisitionId: req.params.id,
      body: req.body,
    });
    return res.status(202).json({ success: true, data: { received: true } });
  }),
);

// GET /public/candidates/verify-email?token= — §3.2 magic-link consumption.
// Anonymous BY DESIGN (the token IS the credential) and rate-limited like a
// read: a brute-force sweep hits the fixed window before it hits the token
// space (256-bit), and every failure returns the SAME uniform 400 — the
// endpoint cannot reveal which emails exist or which links are live (§3.4).
router.get(
  "/candidates/verify-email",
  ...guard("read", async (req, res, tenantId) => {
    try {
      const result = await consumeEmailVerification({
        tenantId,
        token: req.get("X-Candidate-Token") || req.query.token,
      });
      return res.json({ success: true, data: result });
    } catch (err) {
      // Uniform failure body — never leak the failure class to the wire.
      const status = Number(err?.status) || 400;
      return res.status(status).json({
        success: false,
        message: "This verification link is not valid",
      });
    }
  }),
);

// POST /public/candidates/status-link — §3.5a: request (or re-request) the
// status-tracking link. Uniform response for known and unknown addresses:
// only the REAL candidate's mailbox ever receives a link, so the endpoint
// cannot be probed for which emails have applied (§3.4).
router.post(
  "/candidates/status-link",
  express.json({ limit: "16kb" }),
  ...guard("apply", async (req, res, tenantId) => {
    try {
      const result = await requestStatusLink({
        tenantId,
        email: req.body?.email,
      });
      return res.json({ success: true, data: result });
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status >= 500) logger.error({ err: err?.message }, "status link request failed");
      return res.status(status).json({
        success: false,
        message: status >= 500 ? "Something went wrong" : err.message,
      });
    }
  }),
);

// POST /public/candidates/draft — FR-04.07 save-and-return: upsert the
// candidate's draft for one requisition and email the resume link. Auth is the
// EMAIL ITSELF (the link is the credential, like every candidate surface);
// the response is uniform and the real link goes only to the real mailbox.
router.post(
  "/candidates/draft",
  express.json({ limit: "256kb" }),
  ...guard("apply", async (req, res, tenantId) => {
    try {
      const result = await saveApplicationDraft({
        tenantId,
        requisitionId: req.body?.requisitionId,
        email: req.body?.email,
        firstName: req.body?.firstName,
        body: req.body,
      });
      return res.json({ success: true, data: result });
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status >= 500) logger.error({ err: err?.message }, "draft save failed");
      return res.status(status).json({
        success: false,
        message: status >= 500 ? "Something went wrong" : err.message,
      });
    }
  }),
);

// GET /public/candidates/draft?token= — load the saved draft behind the
// emailed link. Unknown/expired/submitted tokens and anonymized owners all
// render the SAME uniform body (§3.4): the endpoint cannot be probed.
router.get(
  "/candidates/draft",
  ...guard("read", async (req, res, tenantId) => {
    const NOT_FOUND = {
      success: false,
      message: "This draft link is not valid",
    };
    try {
      const draft = await loadApplicationDraft({
        tenantId,
        token: req.get("X-Candidate-Token") || req.query.token,
      });
      if (!draft) return res.status(404).json(NOT_FOUND);
      return res.json({ success: true, data: draft });
    } catch (err) {
      logger.error({ err: err?.message }, "draft load failed");
      return res.status(404).json(NOT_FOUND);
    }
  }),
);

// POST /public/candidates/draft/submit — submit the draft as a real
// application THROUGH the intake gates. Failures are uniform (the same body
// as a bad link) so a stale draft reveals nothing.
router.post(
  "/candidates/draft/submit",
  express.json({ limit: "16kb" }),
  ...guard("apply", async (req, res, tenantId) => {
    const NOT_FOUND = {
      success: false,
      message: "This draft link is not valid",
    };
    try {
      const result = await submitApplicationDraft({
        tenantId,
        token: req.get("X-Candidate-Token") || req.body?.token,
      });
      return res.status(202).json({ success: true, data: { received: true } });
    } catch (err) {
      const status = Number(err?.status) || 400;
      if (status >= 500) logger.error({ err: err?.message }, "draft submit failed");
      // Question/eligibility refusals carry their message (actionable
      // for the candidate); anything else is the uniform link body.
      const actionable = [400, 409].includes(status) && err?.code !== "HR-PORTAL-DRAFT-INVALID";
      return res.status(status).json({
        success: false,
        message: actionable ? err.message : "This draft link is not valid",
        ...(actionable && err?.details ? { details: err.details } : {}),
      });
    }
  }),
);

// GET /public/candidates/status?token= — §3.5a: the candidate-visible view.
// A wrong, revoked or expired link — and a link-holder with no visible
// applications — all render the SAME empty body (§3.4 no-oracle); the
// candidate-visible projection (lib/candidateStatusView.js) never exposes
// internal stages, rejection reasons, comments or scores (§3.5a).
router.get(
  "/candidates/status",
  ...guard("read", async (req, res, tenantId) => {
    const EMPTY = { success: true, data: { applications: [] } };
    try {
      const result = await readStatusViaLink({
        tenantId,
        token: req.get("X-Candidate-Token") || req.query.token,
      });
      if (!result) return res.json(EMPTY);
      return res.json({ success: true, data: result.view });
    } catch (err) {
      // A read failure must not distinguish itself from "nothing here".
      logger.error({ err: err?.message }, "status link read failed");
      return res.json(EMPTY);
    }
  }),
);

router.post(
  "/candidates/applications/:id/withdraw",
  ...guard("apply", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await withdrawOwnApplication({
        tenantId,
        token: req.get("X-Candidate-Token"),
        applicationId: req.params.id,
      }),
    }),
  ),
);
router.get(
  "/candidates/preferences",
  ...guard("read", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await candidatePreferences({
        tenantId,
        token: req.get("X-Candidate-Token"),
      }),
    }),
  ),
);
router.put(
  "/candidates/preferences",
  ...guard("apply", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await saveCandidatePreferences({
        tenantId,
        token: req.get("X-Candidate-Token"),
        preferences: req.body?.preferences,
        policyVersion: req.body?.policyVersion,
      }),
    }),
  ),
);
router.post(
  "/candidates/privacy",
  ...guard("apply", async (req, res, tenantId) =>
    res.status(202).json({
      success: true,
      data: await requestOwnData({
        tenantId,
        token: req.get("X-Candidate-Token"),
        type: req.body?.type,
        notes: req.body?.notes,
      }),
    }),
  ),
);
router.post(
  "/candidates/verify-email",
  ...guard("apply", async (req, res, tenantId) => {
    const result = await consumeEmailVerification({
      tenantId,
      token: req.get("X-Candidate-Token"),
    });
    return res.json({ success: true, data: { verified: result.verified } });
  }),
);
router.post(
  "/candidates/draft/resume",
  ...guard("apply", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await uploadDraftResume({
        tenantId,
        token: req.get("X-Candidate-Token"),
        body: req.body,
      }),
    }),
  ),
);
router.get(
  "/candidates/offers",
  ...guard("read", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await listOwnOffers({
        tenantId,
        token: req.get("X-Candidate-Token"),
      }),
    }),
  ),
);
router.get(
  "/candidates/offers/:id/letter",
  ...guard("read", async (req, res, tenantId) => {
    const bytes = await downloadOwnOffer({
      tenantId,
      token: req.get("X-Candidate-Token"),
      offerId: req.params.id,
    });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="offer-letter.pdf"',
      "X-Content-Type-Options": "nosniff",
    });
    res.send(bytes);
  }),
);
router.put(
  "/candidates/offers/:id/respond",
  express.json({ limit: "16kb" }),
  ...guard("apply", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await respondToOwnOffer({
        tenantId,
        token: req.get("X-Candidate-Token"),
        offerId: req.params.id,
        accepted: req.body?.accepted,
      }),
    }),
  ),
);
router.get(
  "/candidates/interview-slots",
  ...guard("read", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await listOwnSlotOffers({
        tenantId,
        token: req.get("X-Candidate-Token"),
      }),
    }),
  ),
);
router.post(
  "/candidates/interview-slots/:id/book",
  express.json({ limit: "16kb" }),
  ...guard("apply", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await bookOwnSlot({
        tenantId,
        token: req.get("X-Candidate-Token"),
        id: req.params.id,
        scheduledAt: req.body?.scheduledAt,
      }),
    }),
  ),
);
router.get(
  "/candidates/interviews",
  ...guard("read", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await listOwnInterviews({
        tenantId,
        token: req.get("X-Candidate-Token"),
      }),
    }),
  ),
);
router.get(
  "/candidates/interviews/:id/calendar",
  ...guard("read", async (req, res, tenantId) => {
    const calendar = await downloadOwnInterviewCalendar({
      tenantId,
      token: req.get("X-Candidate-Token"),
      interviewId: req.params.id,
    });
    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="interview.ics"',
      "X-Content-Type-Options": "nosniff",
    });
    res.send(calendar);
  }),
);
router.post(
  "/candidates/interviews/:id/reschedule",
  express.json({ limit: "16kb" }),
  ...guard("apply", async (req, res, tenantId) =>
    res.json({
      success: true,
      data: await requestOwnInterviewReschedule({
        tenantId,
        token: req.get("X-Candidate-Token"),
        interviewId: req.params.id,
        notes: req.body?.notes,
        requestedFor: req.body?.requestedFor,
      }),
    }),
  ),
);
export default router;
