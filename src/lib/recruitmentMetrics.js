// src/lib/recruitmentMetrics.js
//
// Phase 12 / decision record §6 — the FROZEN canonical KPI definitions.
//
// "These are the reported numbers, so they are frozen here and must be
// versioned. If a definition changes, historical reports must remain
// interpretable." This module is that freeze: pure functions, no DB, each
// taking already-fetched rows and returning one number/structure. The service
// assembles inputs; the DEFINITIONS live only here.
//
// METRICS_VERSION pins the definitions. A future change to any definition
// bumps the version and ships the old behaviour behind the previous number —
// a report rendered under v1 stays explainable by reading v1.
//
// The decisions embedded, per row of the §6 table:
//   * Time to Fill          — final approval → accepted offer that fills the
//                             opening. Multi-opening requisitions keep
//                             per-opening fill dates; overall fill = all
//                             required openings filled.
//   * Time to First Fill    — final approval → FIRST accepted offer; reported
//                             separately, never merged into Time to Fill.
//   * Time to Hire          — application submitted → accepted offer.
//   * Time in Stage         — stage entry → exit; current stage runs to now.
//   * SLA Aging             — current time-in-stage vs the configured SLA.
//   * Stage Conversion      — advanced from A ÷ entered A; withdrawals are
//                             reported separately, not silently excluded.
//   * Drop-off              — exited without advancing ÷ entered, classified
//                             by disposition (the §4.2 reason codes).
//   * Offer Acceptance      — accepted ÷ reached-final-outcome; Declined and
//                             Expired shown separately, never hidden.
//   * Source Effectiveness  — applications / qualified / hires / conversion /
//                             median time-to-hire by source. NO opaque score
//                             — only published formulas.

export const METRICS_VERSION = 1;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Canonical, versioned definition block that travels with every payload. */
export function metricsVersionBlock() {
    return {
        version: METRICS_VERSION,
        definitions: Object.freeze({
            timeToFillDays: "Final requisition approval (last APPROVED transition) → accepted offer that fills the opening; overall fill when all required openings are filled.",
            timeToFirstFillDays: "Final requisition approval → FIRST accepted offer on the requisition (multi-opening relevance).",
            timeToHireDays: "Application submitted (appliedAt) → accepted offer (offer.respondedAt).",
            timeInStage: "Stage entry → stage exit from the immutable stage history; the current stage measures entry → now.",
            slaAging: "Current time-in-stage vs the configured SLA days for that stage.",
            stageConversion: "Applications advancing from stage A to the intended next stage ÷ applications entering A; withdrawals reported separately.",
            dropOff: "Applications exiting stage A without advancing ÷ entering A, classified by disposition reason code (§4.2).",
            offerAcceptanceRate: "ACCEPTED offers ÷ offers reaching a final outcome (SENT in-flight included in the denominator only as 'pending'; DECLINED and EXPIRED reported separately).",
            sourceEffectiveness: "Applications, qualified (≥ interview), hires, conversion rate and median time-to-hire grouped by candidate source; no composite score.",
        }),
    };
}

const round1 = (n) => Math.round(n * 10) / 10;
const daysBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / MS_PER_DAY;

const median = (nums) => {
    if (!nums.length) return null;
    const s = [...nums].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// ── Time to Fill / Time to First Fill ────────────────────────────────────────

/**
 * The FINAL APPROVAL timestamp of a requisition = the last APPROVED transition
 * (the §2.5 chain may approve in steps; the fill clock starts at the last).
 * Falls back to the first transition into POSTED when no APPROVED transition
 * exists (legacy rows predating the transition log), then null.
 * @param {{ fromStatus: string, toStatus: string, createdAt: Date|string }[]} transitions
 */
export function finalApprovalAt(transitions = []) {
    const approved = transitions
        .filter((t) => t.toStatus === "APPROVED")
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (approved.length) return new Date(approved[approved.length - 1].createdAt);
    const posted = transitions
        .filter((t) => t.toStatus === "POSTED")
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return posted.length ? new Date(posted[0].createdAt) : null;
}

/**
 * Accepted offers on a requisition, ordered by acceptance time.
 * @param {{ status: string, respondedAt: Date|null }[]} offers
 */
export function acceptedOfferTimes(offers = []) {
    return offers
        .filter((o) => o.status === "ACCEPTED" && o.respondedAt)
        .map((o) => new Date(o.respondedAt))
        .sort((a, b) => a - b);
}

/**
 * Time to Fill for ONE requisition (§6 row 1). Overall fill = required
 * openings filled; per-opening fill dates are preserved for the drill-down.
 *
 * @returns {{ startAt: Date|null, overallFillAt: Date|null,
 *             timeToFillDays: number|null, timeToFirstFillDays: number|null,
 *             openings: number, filled: number, perOpeningFillDates: Date[] }}
 */
export function timeToFillForRequisition(transitions, offers, openings = 1) {
    const startAt = finalApprovalAt(transitions);
    const acceptTimes = acceptedOfferTimes(offers);
    const required = Math.max(1, Number(openings) || 1);
    const overallFillAt = acceptTimes.length >= required ? acceptTimes[required - 1] : null;

    return {
        startAt,
        overallFillAt,
        timeToFillDays: startAt && overallFillAt ? round1(daysBetween(startAt, overallFillAt)) : null,
        timeToFirstFillDays: startAt && acceptTimes.length ? round1(daysBetween(startAt, acceptTimes[0])) : null,
        openings: required,
        filled: acceptTimes.length,
        perOpeningFillDates: acceptTimes.slice(0, required),
    };
}

/**
 * Tenant-level Time to Fill: mean over requisitions that FILLED, plus the
 * first-fill mean kept SEPARATE (§6 rows 1–2: never merged).
 * @param {ReturnType<timeToFillForRequisition>[]} perRequisition
 */
export function aggregateTimeToFill(perRequisition = []) {
    const fills = perRequisition.filter((r) => r.timeToFillDays !== null).map((r) => r.timeToFillDays);
    const firsts = perRequisition.filter((r) => r.timeToFirstFillDays !== null).map((r) => r.timeToFirstFillDays);
    return {
        // Mean over filled requisitions (a median is also true to the frozen
        // definition; the mean is the reported headline, median on source).
        meanTimeToFillDays: fills.length ? round1(fills.reduce((s, v) => s + v, 0) / fills.length) : null,
        meanTimeToFirstFillDays: firsts.length ? round1(firsts.reduce((s, v) => s + v, 0) / firsts.length) : null,
        requisitionsFilled: fills.length,
        requisitionsWithFirstFill: firsts.length,
    };
}

// ── Time to Hire ─────────────────────────────────────────────────────────────

/**
 * §6 row 3 — per hire: appliedAt → accepted offer. Returns null for hires
 * without an accepted offer (a manual-stage hire predating offers) — those are
 * excluded from the mean rather than counted as zero.
 * @param {{ appliedAt: Date|string, offer: { status: string, respondedAt: Date|null }|null }} application
 */
export function timeToHireForApplication(application) {
    const accepted = application?.offer?.status === "ACCEPTED" && application.offer.respondedAt;
    if (!accepted || !application.appliedAt) return null;
    return round1(daysBetween(application.appliedAt, application.offer.respondedAt));
}

/** Mean over the applications that yield a value. */
export function aggregateTimeToHire(values = []) {
    const valid = values.filter((v) => v !== null);
    return {
        meanTimeToHireDays: valid.length ? round1(valid.reduce((s, v) => s + v, 0) / valid.length) : null,
        medianTimeToHireDays: median(valid),
        hiresMeasured: valid.length,
    };
}

// ── Time in Stage / SLA aging ────────────────────────────────────────────────

/**
 * §6 row 4 — durations in days per stage for ONE application, from the
 * immutable stage history. Entry = the transition that moved INTO the stage;
 * exit = the transition out. The current stage measures entry → now.
 * Stage names are the Application.stage vocabulary (lower-case).
 * @param {{ fromStage: string, toStage: string, createdAt: Date|string }[]} history
 * @param {string} currentStage
 * @param {Date|string} appliedAt  entry into the FIRST stage when no history row exists
 * @returns {{ stage: string, daysInStage: number, isCurrent: boolean }[]}
 */
export function timeInStageForApplication(history = [], currentStage, appliedAt, now = new Date()) {
    // Model: the first history row's fromStage was entered at appliedAt; each
    // row's toStage is entered at that row's createdAt. An application with no
    // history has only its current stage, entered at appliedAt.
    const events = [...history]
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map((h) => ({ from: h.fromStage, to: h.toStage, at: new Date(h.createdAt) }));

    const stageEntries = [];
    if (events.length) {
        if (appliedAt) stageEntries.push({ stage: events[0].from, at: new Date(appliedAt) });
        for (const ev of events) stageEntries.push({ stage: ev.to, at: ev.at });
    } else if (currentStage && appliedAt) {
        stageEntries.push({ stage: currentStage, at: new Date(appliedAt) });
    }

    const out = [];
    for (let i = 0; i < stageEntries.length; i += 1) {
        const cur = stageEntries[i];
        const next = stageEntries[i + 1];
        const isCurrent = !next && cur.stage === currentStage;
        const end = next ? next.at : now;
        out.push({ stage: cur.stage, daysInStage: round1(daysBetween(cur.at, end)), isCurrent });
    }
    return out;
}

/**
 * §6 row 5 — SLA aging for the current stage. `slaByStage` maps stage → days.
 * @returns {{ stage: string, daysInStage: number, slaDays: number|null,
 *             agingDays: number|null, breached: boolean } | null}
 */
export function slaAging(currentStage, daysInStage, slaByStage = {}) {
    if (!currentStage || daysInStage === null || daysInStage === undefined) return null;
    const slaDays = slaByStage[currentStage] ?? slaByStage["*"] ?? null;
    if (slaDays === null || slaDays === undefined) {
        return { stage: currentStage, daysInStage, slaDays: null, agingDays: null, breached: false };
    }
    return {
        stage: currentStage,
        daysInStage,
        slaDays,
        agingDays: round1(Math.max(0, daysInStage - slaDays)),
        breached: daysInStage > slaDays,
    };
}

// ── Stage Conversion / Drop-off ──────────────────────────────────────────────

/**
 * §6 rows 6–7 — funnel arithmetic over stage entries/exits.
 *
 * Entered[A]  = applications whose stage history (or appliedAt) has them in A.
 * Advanced[A] = entered A and later entered the intended next stage.
 * Withdrew[A] = entered A and exited to `withdrawn` (reported separately, NOT
 *               folded into conversion or drop-off).
 * Dropped[A]  = entered A and exited to a non-advancing stage (rejected,
 *               on_hold), classified by the application's disposition.
 *
 * The STAGE_ORDER is the canonical advancement path; anything not on it is a
 * terminal/exit state.
 */
export const STAGE_ORDER = ["applied", "screening", "interview", "offer", "hired"];
export const WITHDRAWN_STAGE = "withdrawn";
export const EXIT_STAGES = ["rejected", "on_hold", WITHDRAWN_STAGE];

/**
 * @param {Array<{
 *   applicationId: number,
 *   currentStage: string,
 *   appliedAt: Date|string,
 *   history: { fromStage: string, toStage: string, createdAt: Date|string }[],
 *   dispositionReasonCode: string|null,
 * }[]>} applications  one record per application (history = its stage rows)
 * @returns {{ stage: string, entered: number, advanced: number, withdrew: number,
 *             dropped: number, conversionPct: number|null, dropOffPct: number|null,
 *             dropOffByDisposition: Record<string, number> }[]}
 */
export function stageFunnel(applications = []) {
    const perStage = STAGE_ORDER.map((stage) => ({
        stage,
        entered: 0,
        advanced: 0,
        withdrew: 0,
        dropped: 0,
        dropOffByDisposition: {},
    }));
    const idx = new Map(STAGE_ORDER.map((s, i) => [s, i]));

    for (const app of applications) {
        // The stages this application entered: appliedAt enters the first
        // history row's fromStage; each row's toStage is entered at its own
        // createdAt. No history → just the current stage at appliedAt.
        const events = [...app.history].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        const enteredStages = new Set();
        if (events.length) {
            enteredStages.add(events[0].fromStage);
            for (const ev of events) enteredStages.add(ev.toStage);
        } else if (app.currentStage && app.appliedAt) {
            enteredStages.add(app.currentStage);
        }

        // Exits: from each entered stage, where did it go next? First exit
        // recorded per stage (a stage re-entry keeps the original exit).
        const exitByStage = new Map();
        for (const ev of events) {
            if (idx.has(ev.fromStage) && !exitByStage.has(ev.fromStage)) exitByStage.set(ev.fromStage, ev.toStage);
        }

        for (const stage of enteredStages) {
            const i = idx.get(stage);
            if (i === undefined) continue;
            perStage[i].entered += 1;

            if (i < STAGE_ORDER.length - 1) {
                const next = STAGE_ORDER[i + 1];
                if (enteredStages.has(next)) {
                    perStage[i].advanced += 1;
                    continue;
                }
            } else {
                // `hired` is terminal success — nothing to advance to.
                continue;
            }

            const exitTo = exitByStage.get(stage) ?? (enteredStages.has(WITHDRAWN_STAGE) ? WITHDRAWN_STAGE : null);
            if (exitTo === WITHDRAWN_STAGE) {
                perStage[i].withdrew += 1;
            } else if (exitTo && EXIT_STAGES.includes(exitTo)) {
                perStage[i].dropped += 1;
                const code = app.dispositionReasonCode || "UNCODED";
                perStage[i].dropOffByDisposition[code] = (perStage[i].dropOffByDisposition[code] ?? 0) + 1;
            }
            // Still sitting in this stage (no exit yet): counted as entered,
            // not advanced/dropped — conversion denominators stay honest.
        }
    }

    return perStage.map((s) => ({
        ...s,
        dropOffByDisposition: Object.fromEntries(
            Object.entries(s.dropOffByDisposition).sort(([a], [b]) => a.localeCompare(b)),
        ),
        conversionPct: s.entered ? Math.round((s.advanced / s.entered) * 100) : null,
        dropOffPct: s.entered ? Math.round((s.dropped / s.entered) * 100) : null,
    }));
}

// ── Offer Acceptance ─────────────────────────────────────────────────────────

/**
 * §6 row 8 — accepted ÷ offers reaching a final candidate response/outcome.
 * SENT (in-flight) is shown as pending, never counted as a refusal; DECLINED
 * and EXPIRED are reported separately, never hidden inside a composite.
 * @param {{ status: string }[]} offers
 */
export function offerAcceptance(offers = []) {
    const counts = { ACCEPTED: 0, DECLINED: 0, EXPIRED: 0, SENT: 0 };
    for (const o of offers) {
        if (counts[o.status] !== undefined) counts[o.status] += 1;
    }
    const finalOutcomes = counts.ACCEPTED + counts.DECLINED + counts.EXPIRED;
    return {
        ...counts,
        finalOutcomes,
        acceptanceRatePct: finalOutcomes ? Math.round((counts.ACCEPTED / finalOutcomes) * 100) : null,
        declineRatePct: finalOutcomes ? Math.round((counts.DECLINED / finalOutcomes) * 100) : null,
        expiryRatePct: finalOutcomes ? Math.round((counts.EXPIRED / finalOutcomes) * 100) : null,
        pending: counts.SENT,
    };
}

// ── Source Effectiveness ─────────────────────────────────────────────────────

/**
 * §6 row 9 — per source: applications, qualified (entered interview), hires,
 * conversion, median time-to-hire. NO composite "quality score" — the decision
 * forbids an opaque number; every figure here is a published formula.
 * @param {Array<{
 *   source: string, applicationId: number, enteredInterview: boolean, isHire: boolean,
 *   timeToHireDays: number|null,
 * }[]>} rows  one per application
 */
export function sourceEffectiveness(rows = []) {
    const bySource = new Map();
    for (const r of rows) {
        const source = r.source || "Unknown";
        if (!bySource.has(source)) {
            bySource.set(source, { source, applications: 0, qualified: 0, hires: 0, tthValues: [] });
        }
        const e = bySource.get(source);
        e.applications += 1;
        if (r.enteredInterview) e.qualified += 1;
        if (r.isHire) e.hires += 1;
        if (r.timeToHireDays !== null && r.timeToHireDays !== undefined) e.tthValues.push(r.timeToHireDays);
    }
    return [...bySource.values()]
        .map((e) => ({
            source: e.source,
            applications: e.applications,
            qualified: e.qualified,
            hires: e.hires,
            qualificationRatePct: e.applications ? Math.round((e.qualified / e.applications) * 100) : null,
            hireRatePct: e.applications ? Math.round((e.hires / e.applications) * 100) : null,
            medianTimeToHireDays: median(e.tthValues),
        }))
        .sort((a, b) => b.applications - a.applications);
}
