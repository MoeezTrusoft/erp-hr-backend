// src/lib/dispositionReasons.js
//
// Phase 6 / decision record §4.2 — the tenant-configurable, versioned
// disposition reason codes.
//
// The DEFAULT taxonomy lives here as data, seeded per tenant on first use by
// the service — a migration must not invent tenants, and the seed must be
// idempotent because two recruiters hitting the same fresh tenant concurrently
// both try. The DEFAULTS array is the CONTRACT with the decision record; the
// seed copies it into DispositionReasonCode rows at version 1, where the
// tenant may then edit labels, switch OTHER's notes requirement, or deactivate
// codes they never use.
//
// A code's MEANING is stable across versions: a new version changes the label
// or the notes requirement, never the semantics. Historic dispositions keep
// resolving to the same code string, which is what makes drop-off reporting by
// reason possible at all (§4.2's point).

export const DEFAULT_DISPOSITION_REASONS = Object.freeze([
  {
    code: "MINIMUM_REQUIREMENTS_NOT_MET",
    label: "Minimum requirements not met",
    requiresNotes: false,
  },
  {
    code: "EXPERIENCE_MISMATCH",
    label: "Experience mismatch",
    requiresNotes: false,
  },
  { code: "SKILLS_MISMATCH", label: "Skills mismatch", requiresNotes: false },
  {
    code: "COMPENSATION_MISMATCH",
    label: "Compensation mismatch",
    requiresNotes: false,
  },
  {
    code: "AVAILABILITY_MISMATCH",
    label: "Availability mismatch",
    requiresNotes: false,
  },
  { code: "POSITION_FILLED", label: "Position filled", requiresNotes: false },
  {
    code: "REQUISITION_CLOSED",
    label: "Requisition closed",
    requiresNotes: false,
  },
  {
    code: "CANDIDATE_WITHDREW",
    label: "Candidate withdrew",
    requiresNotes: false,
  },
  {
    code: "UNABLE_TO_CONTACT",
    label: "Unable to contact",
    requiresNotes: false,
  },
  {
    code: "DUPLICATE_APPLICATION",
    label: "Duplicate application",
    requiresNotes: false,
  },
  // §4.2 — the one code that always demands a note: "other" without an
  // explanation is how reason taxonomies rot into uselessness.
  { code: "OTHER", label: "Other", requiresNotes: true },
]);

export const SCREENING_OUTCOMES = Object.freeze(["ADVANCE", "REJECT", "HOLD"]);

const MAX_NOTES_LENGTH = 5000;
const MAX_CRITERIA = 50;

/**
 * Validate an optional criteria array: [{ criterion, result, score?, note? }].
 *
 * FR-07 residue — a criterion may additionally carry a NUMERIC `score`: a
 * template-required screening scorecard reports numbers alongside the
 * PASS/FAIL/UNSURE verdict. The number is validated here (finite, non-negative)
 * so a stringified "7" from a form still normalizes, while garbage is refused
 * with the entry's name rather than silently stored. Whether a numeric score is
 * REQUIRED is a template question — templateCriteria is the only thing that can
 * answer it — so this function stays verdict-shaped.
 */
export function validateCriteria(criteria) {
  if (criteria === undefined || criteria === null)
    return { ok: true, errors: [], normalized: null };
  if (!Array.isArray(criteria))
    return {
      ok: false,
      errors: ["criteria must be an array"],
      normalized: null,
    };
  if (criteria.length > MAX_CRITERIA) {
    return {
      ok: false,
      errors: [`criteria allows at most ${MAX_CRITERIA} entries`],
      normalized: null,
    };
  }
  const errors = [];
  const normalized = [];
  const seen = new Set();
  for (const entry of criteria) {
    const criterion =
      typeof entry?.criterion === "string" ? entry.criterion.trim() : "";
    const result =
      typeof entry?.result === "string"
        ? entry.result.trim().toUpperCase()
        : "";
    if (!criterion) errors.push("every criterion entry needs a criterion name");
    if (seen.has(criterion)) errors.push("duplicate criterion: " + criterion);
    seen.add(criterion);
    if (!result)
      errors.push(`criterion "${criterion || "(unnamed)"}" needs a result`);
    else if (!["PASS", "FAIL", "UNSURE"].includes(result)) {
      errors.push(
        `criterion "${criterion}" result must be PASS, FAIL or UNSURE`,
      );
    }
    let score = null;
    if (
      entry?.score !== undefined &&
      entry?.score !== null &&
      entry?.score !== ""
    ) {
      const n = Number(entry.score);
      if (!Number.isFinite(n) || n < 0) {
        errors.push(
          `criterion "${criterion || "(unnamed)"}" score must be a finite number >= 0`,
        );
      } else {
        score = n;
      }
    }
    const note =
      typeof entry?.note === "string" && entry.note.trim() !== ""
        ? entry.note.trim()
        : null;
    normalized.push({
      criterion,
      result,
      ...(score !== null ? { score } : {}),
      ...(note ? { note } : {}),
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    normalized: errors.length ? null : normalized,
  };
}

/**
 * Validate a screening decision against the tenant's ACTIVE reason codes.
 * `activeCodes` is the resolved row set ({ code, requiresNotes }); the caller
 * has already seeded defaults if the tenant had none. Rules:
 *   * outcome must be in the closed vocabulary
 *   * ADVANCE carries NO reasonCode (a reason on an advance reads as a
 *     rejection in any report that joins on reasonCode)
 *   * REJECT/HOLD MUST carry an ACTIVE code — free-text reasons are what the
 *     disposition report cannot group by
 *   * a code whose requiresNotes is set demands notes (OTHER by default)
 */
export function validateScreeningDecision({
  outcome,
  reasonCode,
  notes,
  activeCodes,
}) {
  const errors = [];
  const trimmedNotes =
    typeof notes === "string" && notes.trim() !== "" ? notes.trim() : null;
  if (trimmedNotes && trimmedNotes.length > MAX_NOTES_LENGTH) {
    errors.push(`notes must be at most ${MAX_NOTES_LENGTH} characters`);
  }

  if (!SCREENING_OUTCOMES.includes(outcome)) {
    errors.push(`outcome must be one of: ${SCREENING_OUTCOMES.join(", ")}`);
    return { ok: false, errors, notes: null };
  }

  if (outcome === "ADVANCE") {
    if (reasonCode)
      errors.push("an ADVANCE screening does not take a reason code");
    return { ok: errors.length === 0, errors, notes: trimmedNotes };
  }

  if (!reasonCode) {
    errors.push(`a ${outcome} screening requires a reason code`);
    return { ok: false, errors, notes: trimmedNotes };
  }

  const match = (activeCodes ?? []).find((c) => c.code === reasonCode);
  if (!match) {
    errors.push(
      `reason code "${reasonCode}" is not an active code for this tenant`,
    );
    return { ok: false, errors, notes: trimmedNotes };
  }
  if (match.requiresNotes && !trimmedNotes) {
    errors.push(`reason code "${reasonCode}" requires notes`);
  }

  return { ok: errors.length === 0, errors, notes: trimmedNotes };
}
