// src/routes/esign-webhook.routes.js
//
// Recruitment Phase 3a — the e-signature provider's callback:
//
//     POST /webhooks/esign/:provider
//
// Mounted by app.js OUTSIDE the /api internal-service guard (a provider holds
// no service JWT) and BEFORE the global express.json() parser: the signature
// is a MAC over the exact bytes received, so this router reads the body raw.
// A body that was already parsed by the time it gets here cannot be verified
// and is refused like a bad signature.
//
//   1. VERIFY FIRST. The adapter checks that :provider is the configured one,
//      the HMAC and the timestamp window. Any failure is the same bodyless
//      401, and nothing is written.
//   2. FLAG. With esign off a verified delivery is answered 503 (nothing
//      written), so the provider retries after the flag is back on rather than
//      having a signature silently dropped.
//   3. RECORD AND APPLY (offer-esign.service.js): dedupe by event id, match the
//      envelope, apply under its tenant. The answer is 200 once the event is
//      recorded, whatever the outcome: a failure is stored on the event and
//      retried (redelivery or the retry job), and a redelivery of an applied
//      event is acknowledged without being applied again.
//   4. QUICKLY. The work gets ACK_BUDGET_MS; past that the provider gets its
//      200 and the work carries on. Only a failure to record the delivery at
//      all answers 500, so the provider tries again.
import express from "express";

import logger from "../lib/logger.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { verifyWebhook } from "../services/esign.client.js";
import { handleEsignWebhookEvent } from "../services/offer-esign.service.js";

export const ACK_BUDGET_MS = 8000;
const BODY_LIMIT = "1mb";

const unauthorized = (res) => res.status(401).json({ received: false });

export const esignWebhookRouter = express.Router();

esignWebhookRouter.post(
    "/:provider",
    // Every content type is read raw: the MAC covers the bytes, not a parse.
    express.raw({ type: () => true, limit: BODY_LIMIT }),
    async (req, res) => {
        const provider = String(req.params.provider ?? "").toLowerCase();
        const verification = verifyWebhook({ provider, headers: req.headers, rawBody: req.body, now: new Date() });
        if (!verification.ok) {
            if (verification.reason === "MALFORMED") return res.status(400).json({ received: false });
            // The reason is for our log only; the caller learns nothing.
            logger.warn({ component: "esign-webhook", provider, reason: verification.reason }, "e-signature webhook rejected");
            return unauthorized(res);
        }
        if (!isRecruitmentFlagEnabled("esign")) {
            res.setHeader("Retry-After", "3600");
            return res.status(503).json({ received: false });
        }

        const { event } = verification;
        const work = handleEsignWebhookEvent({ provider, event, now: new Date() });
        let timer;
        const budget = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ outcome: "PROCESSING" }), ACK_BUDGET_MS);
        });
        try {
            const result = await Promise.race([work, budget]);
            if (result.outcome === "PROCESSING") {
                work.catch((err) => logger.error({ component: "esign-webhook", provider, eventId: event.eventId, err: err?.message }, "e-signature webhook processing failed"));
            }
            return res.status(200).json({ received: true, outcome: result.outcome });
        } catch (err) {
            logger.error({ component: "esign-webhook", provider, eventId: event.eventId, err: err?.message }, "e-signature webhook could not be recorded");
            return res.status(500).json({ received: false });
        } finally {
            clearTimeout(timer);
        }
    },
);

export default esignWebhookRouter;
