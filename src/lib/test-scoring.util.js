// src/lib/test-scoring.util.js
//
// Phase 3b — scoring one answer to one test item, the single rule shared by the
// session scorer (an attempt's result) and the nightly item statistics (was
// the answer correct). Pure: the caller passes the decrypted answer key.
//
// Item types and answer shapes (the kiosk sends the answer, the key is the
// server's):
//   SINGLE, IMAGE_SINGLE, TRUE_FALSE  answer { optionId }         key { optionIds: [id] }
//   MULTI                             answer { optionIds: [...] }  key { optionIds: [...] }
//   NUMERIC                           answer { value: number }     key { value, tolerance? }
//
// MULTI scoring follows the item's scoringRule.multi: ALL_OR_NOTHING (default)
// gives credit only for the exact set; PARTIAL gives (right picks - wrong
// picks) / correct options, never below 0. Negative marking is the blueprint's
// business (applied by the session scorer to wrong answers), not the item's.

export const ITEM_TYPES = Object.freeze(["SINGLE", "MULTI", "TRUE_FALSE", "NUMERIC", "IMAGE_SINGLE"]);

const SINGLE_TYPES = Object.freeze(["SINGLE", "IMAGE_SINGLE", "TRUE_FALSE"]);

const idList = (value) =>
    Array.isArray(value) ? [...new Set(value.map((id) => String(id)).filter(Boolean))] : [];

/**
 * Is this answer well formed for the item type? An ill-formed answer is
 * refused by the kiosk endpoint instead of being scored as wrong.
 * @param {string} type
 * @param {unknown} answer
 * @returns {boolean}
 */
export function isAnswerShapeValid(type, answer) {
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return false;
    if (SINGLE_TYPES.includes(type)) return typeof answer.optionId === "string" || Number.isInteger(answer.optionId);
    if (type === "MULTI") return Array.isArray(answer.optionIds) && answer.optionIds.length > 0 && answer.optionIds.length <= 6;
    if (type === "NUMERIC") return typeof answer.value === "number" && Number.isFinite(answer.value);
    return false;
}

/**
 * Score one answer.
 * @param {{ type: string, answerKey: object, scoringRule?: object|null }} item  answerKey already decrypted and parsed
 * @param {object|null|undefined} answer  null/undefined = not answered
 * @returns {{ answered: boolean, correct: boolean, credit: number }}  credit in [0, 1]
 */
export function scoreItemAnswer(item, answer) {
    if (answer === null || answer === undefined) return { answered: false, correct: false, credit: 0 };
    const type = item?.type;
    if (!isAnswerShapeValid(type, answer)) return { answered: true, correct: false, credit: 0 };
    const key = item?.answerKey ?? {};

    if (SINGLE_TYPES.includes(type)) {
        const correctIds = idList(key.optionIds);
        const correct = correctIds.length === 1 && correctIds[0] === String(answer.optionId);
        return { answered: true, correct, credit: correct ? 1 : 0 };
    }

    if (type === "MULTI") {
        const correctIds = new Set(idList(key.optionIds));
        const picked = idList(answer.optionIds);
        if (!correctIds.size) return { answered: true, correct: false, credit: 0 };
        const right = picked.filter((id) => correctIds.has(id)).length;
        const wrong = picked.length - right;
        const exact = wrong === 0 && right === correctIds.size;
        if (item?.scoringRule?.multi === "PARTIAL") {
            const credit = Math.max(0, (right - wrong) / correctIds.size);
            return { answered: true, correct: exact, credit: Math.round(credit * 1000) / 1000 };
        }
        return { answered: true, correct: exact, credit: exact ? 1 : 0 };
    }

    // NUMERIC
    const target = Number(key.value);
    const tolerance = Math.abs(Number(key.tolerance ?? 0)) || 0;
    if (!Number.isFinite(target)) return { answered: true, correct: false, credit: 0 };
    const correct = Math.abs(answer.value - target) <= tolerance + Number.EPSILON;
    return { answered: true, correct, credit: correct ? 1 : 0 };
}
