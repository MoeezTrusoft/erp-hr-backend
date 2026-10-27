// src/controllers/aiAdvisory.controller.js
//
// Phase 13 / decision record §7 — REST surface for the ADVISORY AI features.
// Mounted under /api/recruitment, so routeAuthorization resolves the resource
// from the path (hr.recruitment) and the action from the HTTP method — one
// policy model, nothing to drift. §7.3b visibility: these are recruiter/
// hiring-manager reads; interviewer packet surfaces never route here, and the
// report carries no ranking or overall score to anchor anyone.
//
// §7.3 in one line: nothing in this controller advances, rejects, offers or
// hires — every handler is a read that returns evidence.

import { matchCandidateToRequisitionAdvisory } from "../services/candidate-match.service.js";
import { reconcileParsedSkillsPreview } from "../services/skillTaxonomy.service.js";

export async function matchCandidateHandler(req, res, next) {
    try {
        const { candidateId, requisitionId } = req.params;
        const data = await matchCandidateToRequisitionAdvisory({
            candidateId,
            requisitionId,
            tenantId: req.user?.tenantId ?? null,
            withAiSummary: req.query.ai === "true",
            actorId: req.user?.id ?? null,
        });
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

export async function reconcileSkillsHandler(req, res, next) {
    try {
        const data = await reconcileParsedSkillsPreview({
            candidateId: req.params.candidateId,
            tenantId: req.user?.tenantId ?? null,
        });
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}
