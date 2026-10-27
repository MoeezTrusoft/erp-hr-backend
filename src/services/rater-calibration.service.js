// src/services/rater-calibration.service.js
//
// Recruitment Phase 3b — the rater calibration dashboard (plan 7.4.4: "each
// interviewer's leniency or severity, range of ratings, agreement with the
// panel and submission timeliness, following the rater-metrics approach used
// in main's assessment module").
//
// As in main's rater metrics (src/services/assessment/rater-metrics.js), these
// are PROCESS calibration indicators for coaching, never scores of the
// interviewer as an employee, and nothing is shown below a minimum sample.
//
// The maths (summarizeRaterCalibration, pure):
//   * ratings are put on a common 1 to 5 footing (a 1 to 4 rating r becomes
//     1 + (r - 1) x 4 / 3); YES_NO must-have checks are left out;
//   * a criterion is SHARED when at least two panelists rated it in the same
//     interview. For each shared rating: deviation = own - mean of the other
//     panelists; agreement = |own - median of the others| <= 1;
//   * leniency = mean deviation (positive lenient, negative severe; LENIENT
//     at +0.5 or more, SEVERE at -0.5 or less);
//   * range = min, max and standard deviation of the interviewer's ratings;
//   * timeliness = hours from the interview's end to the submission (never
//     negative), median and the share within 24 hours;
//   * sample size = submitted scorecards; below the minimum (default 5) the
//     metrics are withheld.
import prisma from "../lib/prisma.js";
import { withTenant } from "../lib/tenancy.js";
import { resolveAssessmentAccess } from "../lib/assessment-access.util.js";
import {
    criterionScale,
    flattenCriteria,
    formFromTemplate,
    parseRating,
    storedCriteriaOf,
} from "../lib/evaluation-form.util.js";
import { assertEvaluationFormsEnabled } from "./evaluation-summary.service.js";
import { FORM_TEMPLATE_SELECT } from "./scorecard-template.service.js";

export const CALIBRATION_MIN_SAMPLE = 5;
export const LENIENCY_BAND = 0.5;
const DEFAULT_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SCAN_CAP = 5000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const round2 = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const sd = (xs) => {
    const m = mean(xs);
    return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length) : 0;
};

/** One rating on the common 1 to 5 footing; null for YES_NO or invalid. */
export function toFivePoint(value, scale) {
    if (!scale || scale.kind !== "POINTS") return null;
    const r = parseRating(value, scale);
    if (typeof r !== "number") return null;
    return 1 + ((r - scale.min) * 4) / (scale.max - scale.min);
}

/** A card's ratings on the common footing, keyed by criterion. */
function ratingsOf(card, form) {
    const out = {};
    const scales = new Map(flattenCriteria(form).map((c) => [c.key, criterionScale(c, form)]));
    for (const [key, entry] of Object.entries(storedCriteriaOf(card))) {
        if (entry?.notAssessed) continue;
        const v = toFivePoint(entry?.rating, scales.get(key) ?? form.scale);
        if (v !== null) out[key] = v;
    }
    return out;
}

/**
 * The calibration rows.
 *
 * @param {{ id, interviewId, reviewerId, reviewer?, submittedAt, scores?, criterionScores?,
 *           interview: { scheduledAt, durationMinutes } }[]} cards  SUBMITTED scorecards
 * @param {(card) => object} formOf  the form a card was rated against
 * @param {{ minSample?: number }} [opts]
 */
export function summarizeRaterCalibration(cards = [], formOf = () => formFromTemplate({ criteria: [] }), { minSample = CALIBRATION_MIN_SAMPLE } = {}) {
    const byInterview = new Map();
    for (const card of cards) {
        const list = byInterview.get(card.interviewId) ?? [];
        list.push({ card, ratings: ratingsOf(card, formOf(card)) });
        byInterview.set(card.interviewId, list);
    }

    const raters = new Map();
    const rater = (card) => {
        if (!raters.has(card.reviewerId)) {
            raters.set(card.reviewerId, { reviewerId: card.reviewerId, reviewer: card.reviewer ?? null, sampleSize: 0, ratings: [], deviations: [], agreements: [], delays: [] });
        }
        return raters.get(card.reviewerId);
    };

    for (const panel of byInterview.values()) {
        for (const { card, ratings } of panel) {
            const r = rater(card);
            r.sampleSize += 1;
            r.ratings.push(...Object.values(ratings));
            const end = card.interview?.scheduledAt
                ? new Date(card.interview.scheduledAt).getTime() + (Number(card.interview.durationMinutes) || 60) * 60 * 1000
                : null;
            if (end !== null && card.submittedAt) r.delays.push(Math.max(0, new Date(card.submittedAt).getTime() - end) / HOUR_MS);
            for (const [key, own] of Object.entries(ratings)) {
                const others = panel.filter((p) => p.card.reviewerId !== card.reviewerId && typeof p.ratings[key] === "number").map((p) => p.ratings[key]);
                if (!others.length) continue;
                r.deviations.push(own - mean(others));
                r.agreements.push(Math.abs(own - median(others)) <= 1 ? 1 : 0);
            }
        }
    }

    return [...raters.values()]
        .map((r) => {
            const sufficient = r.sampleSize >= minSample;
            const leniency = sufficient && r.deviations.length ? round2(mean(r.deviations)) : null;
            return {
                reviewerId: r.reviewerId,
                reviewer: r.reviewer,
                sampleSize: r.sampleSize,
                sufficientSample: sufficient,
                meanRating: sufficient ? round2(mean(r.ratings)) : null,
                leniency,
                tendency: leniency === null ? null : leniency >= LENIENCY_BAND ? "LENIENT" : leniency <= -LENIENCY_BAND ? "SEVERE" : "BALANCED",
                range: sufficient && r.ratings.length
                    ? { min: round2(Math.min(...r.ratings)), max: round2(Math.max(...r.ratings)), sd: round2(sd(r.ratings)) }
                    : null,
                agreement: sufficient && r.agreements.length ? round2(mean(r.agreements)) : null,
                sharedComparisons: r.deviations.length,
                timeliness: sufficient && r.delays.length
                    ? { medianHours: round2(median(r.delays)), within24hShare: round2(mean(r.delays.map((d) => (d <= 24 ? 1 : 0)))) }
                    : null,
            };
        })
        .sort((a, b) => b.sampleSize - a.sampleSize || a.reviewerId - b.reviewerId);
}

const personName = (emp) => {
    if (!emp) return null;
    const joined = [emp.first_name, emp.last_name].filter(Boolean).join(" ").trim();
    return emp.employee_name || joined || null;
};

/**
 * hr_rater_calibration_get — HR and recruiters only. Window by submission
 * time (default the last 180 days); optional requisition and interviewer.
 */
export async function getRaterCalibration(user, { from, to, requisitionId, interviewerId, minSample, now = new Date() } = {}) {
    assertEvaluationFormsEnabled();
    const access = resolveAssessmentAccess(user);
    if (!access.recruiter && !access.admin) {
        throw fail("Rater calibration is for HR and recruiters", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    }
    const tenantId = user.tenantId;
    const until = to ? new Date(to) : new Date(now);
    const since = from ? new Date(from) : new Date(until.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since > until) {
        throw fail("from and to must be dates with from before to", 400, "HR-RECRUITMENT-CALIBRATION-WINDOW-INVALID");
    }
    const where = withTenant(tenantId, { submittedAt: { gte: since, lte: until } });
    const reqId = Number(requisitionId);
    if (Number.isInteger(reqId) && reqId > 0) where.interview = { application: { jobRequisitionId: reqId } };
    const cards = await prisma.interviewScorecard.findMany({
        where,
        select: {
            id: true,
            interviewId: true,
            reviewerId: true,
            submittedAt: true,
            scores: true,
            criterionScores: true,
            templateId: true,
            reviewer: { select: { id: true, employee_name: true, first_name: true, last_name: true } },
            interview: { select: { scheduledAt: true, durationMinutes: true, formTemplateId: true } },
        },
        orderBy: { submittedAt: "desc" },
        take: SCAN_CAP,
    });
    const templateIds = [...new Set(cards.map((c) => c.templateId ?? c.interview?.formTemplateId).filter(Boolean))];
    const templates = templateIds.length
        ? await prisma.scorecardTemplate.findMany({ where: withTenant(tenantId, { id: { in: templateIds } }), select: FORM_TEMPLATE_SELECT })
        : [];
    const forms = new Map(templates.map((t) => [t.id, formFromTemplate(t)]));
    // A caller may raise the minimum sample, never lower it below five.
    const sample = Math.max(CALIBRATION_MIN_SAMPLE, Number.isInteger(Number(minSample)) ? Number(minSample) : 0);
    const legacy = formFromTemplate({ criteria: [] });
    const rows = summarizeRaterCalibration(
        cards.map((c) => ({ ...c, reviewer: personName(c.reviewer) })),
        (card) => forms.get(card.templateId ?? card.interview?.formTemplateId) ?? legacy,
        { minSample: sample },
    );
    const iid = Number(interviewerId);
    return {
        window: { from: since, to: until },
        minSample: sample,
        scanned: cards.length,
        raters: Number.isInteger(iid) && iid > 0 ? rows.filter((r) => r.reviewerId === iid) : rows,
        interpretation: "Process calibration indicators for coaching; never scores of the interviewer as an employee.",
    };
}
