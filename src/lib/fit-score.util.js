// src/lib/fit-score.util.js
//
// Recruitment Phase 2 (§6.4) — the deterministic application FIT SCORE.
//
// Pure and deterministic: no DB, no clock, no randomness, no model call. The
// same inputs always give the same score, the same components and the same
// inputsHash, so a rescore with nothing changed is detectable and skipped.
//
// FEATURES ARE ONLY skills, years of experience and the screening-answer
// total. Name, email, gender, age, date of birth, nationality, photo, address
// and every free-text field are not inputs here, and the input object is
// destructured to the eight named keys below, so nothing else can reach the
// formula even when a caller passes more. Explanations name requisition skill
// names and numbers only, never candidate details.
//
// The formula (model "fit-v1"):
//   component            weight   value (0..1)
//   required coverage      50     matched required / required
//   preferred coverage     20     matched preferred / preferred
//   experience             15     min(1, candidate years / minimum years)
//   screening answers      15     answerScore / answerMaxScore
// A component with no data (no preferred skills, no minimum, no parsed years,
// no scored questions) is NOT ASSESSED: it is dropped and the remaining
// weights are renormalised, so missing data is never counted as zero.
// score = 100 * sum(weight * value) / sum(weight of assessed components).
//
// A knocked-out application is still scored (the components explain it), but
// its score is capped below FAIR so its band is WEAK and it ranks under every
// application that passed; the proposal step never proposes it.
//
// Skill matching goes through the controlled taxonomy (lib/skillNormalization
// .js): both sides resolve to canonical Skill ids through the alias index, so
// "JS" and "JavaScript" are one skill. A name the taxonomy does not know is
// compared by its normalised key (trimmed, lowercased, single-spaced): an
// exact comparison, never a fuzzy one.
import { createHash } from "node:crypto";

import { aliasKey, resolveSkill } from "./skill-normalization.util.js";

export const FIT_MODEL_VERSION = "fit-v1";

export const FIT_WEIGHTS = Object.freeze({
    requiredSkills: 50,
    preferredSkills: 20,
    experience: 15,
    screeningAnswers: 15,
});

// Band floors, highest first. Below the last floor is WEAK.
export const FIT_BANDS = Object.freeze([
    { band: "STRONG", min: 80 },
    { band: "GOOD", min: 65 },
    { band: "FAIR", min: 50 },
]);

// The highest score a knocked-out application can carry (just under FAIR).
export const KNOCKOUT_SCORE_CAP = 49.9;

// Explanations list at most this many skill names, then "+N more".
const NAMES_IN_EXPLANATION = 8;

const round1 = (n) => Math.round(n * 10) / 10;
// Component values are stored to 4 decimals so the JSON stays readable.
const round4 = (n) => Math.round(n * 10000) / 10000;

/** The band for a 0-100 score. */
export function fitBand(score) {
    for (const { band, min } of FIT_BANDS) {
        if (score >= min) return band;
    }
    return "WEAK";
}

const finiteOrNull = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * The comparison key for one skill name: the canonical Skill id when the
 * taxonomy resolves it, else the normalised name. Null for a blank name.
 */
function skillKey(aliasIndex, name) {
    const key = aliasKey(name);
    if (!key) return null;
    const resolved = aliasIndex ? resolveSkill(aliasIndex, name) : { skillId: null };
    return resolved.skillId ? `skill:${resolved.skillId}` : `name:${key}`;
}

/** Requirement names → [{ key, name }], deduplicated by key, first name kept. */
function requirementList(aliasIndex, names, exclude = new Set()) {
    const seen = new Set(exclude);
    const out = [];
    for (const raw of Array.isArray(names) ? names : []) {
        const name = String(raw ?? "").trim();
        const key = skillKey(aliasIndex, name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, name });
    }
    return out;
}

function candidateKeys(aliasIndex, skills) {
    const keys = new Set();
    for (const item of Array.isArray(skills) ? skills : []) {
        const key = skillKey(aliasIndex, typeof item === "string" ? item : item?.name);
        if (key) keys.add(key);
    }
    return keys;
}

const nameList = (names) => {
    const shown = names.slice(0, NAMES_IN_EXPLANATION).join(", ");
    const more = names.length - NAMES_IN_EXPLANATION;
    return more > 0 ? `${shown} +${more} more` : shown;
};

function coverageComponent(key, label, weight, requirements, have) {
    if (!requirements.length) {
        return { key, weight, value: null, assessed: false, explanation: `Not assessed: the requisition lists no ${label.toLowerCase()}` };
    }
    const matched = requirements.filter((r) => have.has(r.key)).map((r) => r.name);
    const missing = requirements.filter((r) => !have.has(r.key)).map((r) => r.name);
    const parts = [`${label}: ${matched.length} of ${requirements.length} matched`];
    if (matched.length) parts[0] += ` (${nameList(matched)})`;
    if (missing.length) parts.push(`missing: ${nameList(missing)}`);
    return { key, weight, value: round4(matched.length / requirements.length), assessed: true, explanation: parts.join("; ") };
}

function experienceComponent(candidateYears, minYears) {
    const weight = FIT_WEIGHTS.experience;
    if (minYears === null) {
        return { key: "experience", weight, value: null, assessed: false, explanation: "Not assessed: the requisition sets no minimum experience" };
    }
    if (candidateYears === null) {
        return { key: "experience", weight, value: null, assessed: false, explanation: "Not assessed: no years of experience in the parsed resume" };
    }
    const value = minYears === 0 ? 1 : Math.min(1, candidateYears / minYears);
    return {
        key: "experience",
        weight,
        value: round4(value),
        assessed: true,
        explanation: `${round1(candidateYears)} years of experience against a ${round1(minYears)}-year minimum`,
    };
}

function answersComponent(answerScore, answerMaxScore) {
    const weight = FIT_WEIGHTS.screeningAnswers;
    if (answerMaxScore === null || answerMaxScore <= 0 || answerScore === null) {
        return { key: "screeningAnswers", weight, value: null, assessed: false, explanation: "Not assessed: no scored screening questions answered" };
    }
    const value = Math.max(0, Math.min(1, answerScore / answerMaxScore));
    return { key: "screeningAnswers", weight, value: round4(value), assessed: true, explanation: `Screening answers: ${answerScore} of ${answerMaxScore} points` };
}

/** sha256 over the normalised inputs (the comparison keys, sorted). */
function hashInputs(normalised) {
    return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}

/**
 * Compute one application's fit score.
 *
 * @param {object} inputs
 * @param {string[]} inputs.requiredSkills   requisition required skill names
 * @param {string[]} inputs.preferredSkills  requisition preferred skill names
 * @param {Array<string|{name:string}>} inputs.candidateSkills  the candidate's skills
 * @param {number|null} inputs.candidateYears  years of experience, null = unknown
 * @param {number|null} inputs.minYears        requisition minimum, null = none set
 * @param {boolean} inputs.knockedOut          a knockout question disqualified it
 * @param {number|null} inputs.answerScore     deterministic answer total
 * @param {number|null} inputs.answerMaxScore  its ceiling, null/0 = unscored
 * @param {object} [options]
 * @param {Map} [options.aliasIndex]  from buildAliasIndex (skill-normalization.util.js)
 * @returns {{score:number, band:string, components:object[], modelVersion:string, inputsHash:string, assessed:boolean}}
 */
export function computeFitScore(
    { requiredSkills, preferredSkills, candidateSkills, candidateYears, minYears, knockedOut, answerScore, answerMaxScore } = {},
    { aliasIndex = null } = {},
) {
    const required = requirementList(aliasIndex, requiredSkills);
    // A skill listed as both required and preferred counts once, as required.
    const preferred = requirementList(aliasIndex, preferredSkills, new Set(required.map((r) => r.key)));
    const have = candidateKeys(aliasIndex, candidateSkills);
    const years = finiteOrNull(candidateYears);
    const minimum = finiteOrNull(minYears);
    const points = answerScore === null || answerScore === undefined ? null : Number.isFinite(Number(answerScore)) ? Number(answerScore) : null;
    const ceiling = finiteOrNull(answerMaxScore);
    const knocked = knockedOut === true;

    const components = [
        coverageComponent("requiredSkills", "Required skills", FIT_WEIGHTS.requiredSkills, required, have),
        coverageComponent("preferredSkills", "Preferred skills", FIT_WEIGHTS.preferredSkills, preferred, have),
        experienceComponent(years, minimum),
        answersComponent(points, ceiling),
    ];

    const assessedComponents = components.filter((c) => c.assessed);
    const totalWeight = assessedComponents.reduce((sum, c) => sum + c.weight, 0);
    const raw = totalWeight > 0
        ? round1((100 * assessedComponents.reduce((sum, c) => sum + c.weight * c.value, 0)) / totalWeight)
        : 0;
    const score = knocked ? Math.min(raw, KNOCKOUT_SCORE_CAP) : raw;

    components.push({
        key: "knockout",
        weight: 0,
        value: knocked ? 0 : 1,
        assessed: true,
        explanation: knocked
            ? `Failed a knockout question: score capped below FAIR (uncapped ${raw})`
            : "Passed every knockout question",
    });

    const inputsHash = hashInputs({
        modelVersion: FIT_MODEL_VERSION,
        required: required.map((r) => [r.key, r.name]).sort(),
        preferred: preferred.map((r) => [r.key, r.name]).sort(),
        candidate: [...have].sort(),
        candidateYears: years,
        minYears: minimum,
        knockedOut: knocked,
        answerScore: points,
        answerMaxScore: ceiling,
    });

    return {
        score,
        band: fitBand(score),
        components,
        modelVersion: FIT_MODEL_VERSION,
        inputsHash,
        // False when no weighted component had data: the score is 0 by
        // default, not by evidence, and the proposal step skips it.
        assessed: totalWeight > 0,
    };
}

/** True when a stored components array has at least one assessed weighted component. */
export const componentsAssessed = (components) =>
    Array.isArray(components) && components.some((c) => c?.assessed === true && Number(c?.weight) > 0);

export default computeFitScore;
