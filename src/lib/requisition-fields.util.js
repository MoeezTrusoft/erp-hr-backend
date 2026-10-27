// src/lib/requisition-fields.util.js
//
// Phase 2.2 — the requisition's field vocabulary, structured job content, and the
// SUBMISSION GATE.
//
// Why this is one module rather than inline checks: the requisition is written
// from three different surfaces (requisition.service, requisitionMgmt.service,
// the legacy /api/hr hrContract.service) plus MCP. Spreading the mandatory rules
// across them is how a field becomes required on one surface and optional on
// another — which is exactly the drift the plan's Phase 4 "validate mandatory
// fields" rule would have inherited.
//
// The gate is enforced from `assertRequisitionTransition` (the state machine),
// not from each caller, so a NEW submit path cannot silently skip it: a submit
// without the requisition row is a programming error and throws.

// ── Vocabularies ─────────────────────────────────────────────────────────────
// Kept as frozen arrays rather than Prisma enums so adding a value is a one-line
// migration; each has a matching CHECK constraint in
// 20261021000900_recruitment_requisition_expansion so the database agrees with
// the service instead of trusting it.

// FR-02.02 — the keys whose presence in an update payload counts as a FIELD EDIT
// for the post-submission lock. Everything the core update path writes plus the
// whole expansion set from pickRequisitionFields. `status`, `expectedVersion`
// and `comments`/`reason` are deliberately NOT here: they are transition/transport
// concerns, not requisition content.
export const FIELD_LOCKED_KEYS = Object.freeze([
    "title",
    "description",
    "departmentId",
    "positionId",
    "employeeId",
    "openings",
    "priority",
    "requestedById",
    "location",
    "employmentType",
    "targetStartDate",
    "gradeLevelId",
    "costCenterRef",
    "costCenterLabel",
    "budgetRef",
    "budgetLabel",
    "hiringReason",
    "replacementEmployeeId",
    "recruiterId",
    "closesAt",
    "autoCloseWhenFilled",
    "jobContent",
]);

export const EMPLOYMENT_TYPES = Object.freeze([
    "FULL_TIME",
    "PART_TIME",
    "CONTRACT",
    "INTERN",
    "TEMPORARY",
]);

export const HIRING_REASONS = Object.freeze([
    "NEW_HIRE",
    "REPLACEMENT",
    "EXPANSION",
    "SEASONAL",
    "PROJECT",
    "OTHER",
]);

export const ATTACHMENT_CATEGORIES = Object.freeze([
    "JOB_DESCRIPTION",
    "BUSINESS_JUSTIFICATION",
    "BUDGET_APPROVAL",
    "HIRING_APPROVAL",
    "OTHER_INTERNAL",
]);

// Deliberately no candidate-facing value. Candidate-facing publication assets are
// managed separately from internal requisition documents (decision record §1.4),
// so an internal budget justification cannot leak into a candidate view by
// riding along on the same requisition.
export const ATTACHMENT_VISIBILITIES = Object.freeze(["INTERNAL", "HIRING_TEAM"]);

// Categories an INTERVIEWER may ever see. Everything else is recruiter/HR/approver
// only, no matter how the attachment is filed.
export const HIRING_TEAM_VISIBLE_CATEGORIES = Object.freeze(["JOB_DESCRIPTION"]);

// ── Structured job content (decision record §1.3) ────────────────────────────
//
// Versioned on purpose: the published job page and the candidate portal read this
// shape, so a later section must not reinterpret rows written today.
export const JOB_CONTENT_SCHEMA_VERSION = 1;

const JOB_CONTENT_LIST_FIELDS = Object.freeze([
    "responsibilities",
    "requirements",
    "skills",
    "benefits",
    "hiringProcess",
]);

const fieldError = (message, code, status = 422) =>
    Object.assign(new Error(message), { status, code });

// One definition of "absent" for both the normalizers and the submission gate:
// undefined, null and "" all mean unset, so `location: ""` cannot pass a required
// check that `location: null` fails.
const isBlank = (value) => value === undefined || value === null || value === "";

/**
 * Validate + normalize structured job content.
 *
 * Returns `null` for absent/empty input (a draft need not have content yet).
 * Throws 422 on a shape that cannot be published, rather than storing something
 * the candidate portal would render as blanks.
 */
export function normalizeJobContent(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
        // Tolerate a JSON string (MCP callers send text) but reject a malformed one.
        try {
            value = JSON.parse(value);
        } catch {
            throw fieldError("jobContent must be an object or valid JSON string", "HR-RECRUITMENT-JOB-CONTENT-INVALID");
        }
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw fieldError("jobContent must be an object", "HR-RECRUITMENT-JOB-CONTENT-INVALID");
    }

    const out = { schemaVersion: JOB_CONTENT_SCHEMA_VERSION };
    if (value.summary != null && String(value.summary).trim()) {
        out.summary = String(value.summary).trim();
    }

    for (const field of JOB_CONTENT_LIST_FIELDS) {
        const raw = value[field];
        if (raw == null) continue;
        if (!Array.isArray(raw)) {
            throw fieldError(`jobContent.${field} must be an array`, "HR-RECRUITMENT-JOB-CONTENT-INVALID");
        }
        const items = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
        if (items.length) out[field] = items;
    }

    const faq = value.faq;
    if (faq != null) {
        if (!Array.isArray(faq)) {
            throw fieldError("jobContent.faq must be an array", "HR-RECRUITMENT-JOB-CONTENT-INVALID");
        }
        const entries = faq
            .map((entry) => {
                if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
                    throw fieldError(
                        "jobContent.faq entries must be {question, answer} objects",
                        "HR-RECRUITMENT-JOB-CONTENT-INVALID",
                    );
                }
                const question = String(entry.question ?? "").trim();
                const answer = String(entry.answer ?? "").trim();
                return question && answer ? { question, answer } : null;
            })
            .filter(Boolean);
        if (entries.length) out.faq = entries;
    }

    // Phase 7 — the minimum years of experience the fit score's experience
    // component compares the parsed resume against. Optional; blank means none.
    const minYears = normalizeMinYearsExperience(value.minYearsExperience);
    if (minYears !== null) out.minYearsExperience = minYears;

    return out;
}

export const MAX_MIN_YEARS_EXPERIENCE = 50;

/** jobContent.minYearsExperience: a number 0..50 (numeric strings accepted), else 422. */
function normalizeMinYearsExperience(raw) {
    if (isBlank(raw)) return null;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
    if (!Number.isFinite(n) || n < 0 || n > MAX_MIN_YEARS_EXPERIENCE) {
        throw fieldError(
            `jobContent.minYearsExperience must be a number from 0 to ${MAX_MIN_YEARS_EXPERIENCE}`,
            "HR-RECRUITMENT-JOB-CONTENT-INVALID",
        );
    }
    return Math.round(n * 10) / 10;
}

/** Normalize one of the closed vocabularies; throws 422 on an unknown value. */
export function normalizeVocabulary(value, allowed, field) {
    if (value === undefined || value === null || value === "") return null;
    const normalized = String(value).trim().toUpperCase();
    if (!allowed.includes(normalized)) {
        throw fieldError(
            `${field} must be one of: ${allowed.join(", ")}`,
            `HR-RECRUITMENT-${field.replace(/[A-Z]/g, (c) => `-${c}`).toUpperCase()}-INVALID`,
        );
    }
    return normalized;
}

const toId = (value) => (isBlank(value) ? null : Number(value));
const toText = (value) => (isBlank(value) ? null : String(value).trim());
const toDate = (value, field = "targetStartDate") => {
    if (isBlank(value)) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw fieldError(`${field} is not a valid date`, `HR-RECRUITMENT-${field.toUpperCase()}-INVALID`);
    }
    return parsed;
};
const normalizeBoolean = (value, field) => {
    if (isBlank(value)) return null;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (!["true", "false"].includes(normalized)) {
        throw fieldError(`${field} must be a boolean`, `HR-RECRUITMENT-${field.toUpperCase()}-INVALID`);
    }
    return normalized === "true";
};
const toIdOrThrow = (value, field) => {
    const id = toId(value);
    if (id === null) return null;
    if (!Number.isInteger(id) || id <= 0) {
        throw fieldError(`${field} must be a positive integer id`, `HR-RECRUITMENT-${field.toUpperCase()}-INVALID`);
    }
    return id;
};

/**
 * Extract + normalize the Phase 2.2 columns from a request payload.
 *
 * Shared by the REST controller, the MCP create/update tools and the legacy
 * /api/hr surface so the three cannot normalize `employmentType` differently.
 * Only keys PRESENT in `data` are returned: an absent key must leave the column
 * alone on update, whereas an explicit `null` clears it.
 */
export function pickRequisitionFields(data = {}) {
    const out = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(data, key);

    if (has("location")) out.location = toText(data.location);
    if (has("employmentType")) out.employmentType = normalizeVocabulary(data.employmentType, EMPLOYMENT_TYPES, "employmentType");
    if (has("targetStartDate")) out.targetStartDate = toDate(data.targetStartDate);
    if (has("gradeLevelId")) out.gradeLevelId = toIdOrThrow(data.gradeLevelId, "gradeLevelId");
    if (has("costCenterRef")) out.costCenterRef = toText(data.costCenterRef);
    if (has("costCenterLabel")) out.costCenterLabel = toText(data.costCenterLabel);
    if (has("budgetRef")) out.budgetRef = toText(data.budgetRef);
    if (has("budgetLabel")) out.budgetLabel = toText(data.budgetLabel);
    if (has("hiringReason")) out.hiringReason = normalizeVocabulary(data.hiringReason, HIRING_REASONS, "hiringReason");
    if (has("replacementEmployeeId")) out.replacementEmployeeId = toIdOrThrow(data.replacementEmployeeId, "replacementEmployeeId");
    if (has("recruiterId")) out.recruiterId = toIdOrThrow(data.recruiterId, "recruiterId");
    // Phase 4 / §2.5 — the application window. Normalized (and rejected early if
    // it is not a date) here like the other expansion fields; the eligibility
    // module owns the rule, this owns the shape.
    if (has("closesAt")) out.closesAt = toDate(data.closesAt, "closesAt");
    if (has("autoCloseWhenFilled")) out.autoCloseWhenFilled = normalizeBoolean(data.autoCloseWhenFilled, "autoCloseWhenFilled");
    if (has("jobContent")) out.jobContent = normalizeJobContent(data.jobContent);

    return out;
}

/**
 * FR-02.02 — the FIELD LOCK. Once a requisition leaves DRAFT (submitted into
 * the approval chain), its normal editable fields are frozen: an approver must
 * judge a fixed artifact, a posted requisition must not silently change what
 * candidates applied to, and "the requisition I approved" must stay the
 * requisition that exists. Editing returns to the REJECTED → DRAFT revision
 * path, which is a legal transition back into DRAFT — the lock is on FIELDS,
 * not on the requisition's life.
 *
 * Pure and shared by both field-writing surfaces (requisition.service and the
 * legacy hrContract path) so the lock cannot differ between URLs. `status`-only
 * payloads are not field edits and pass through: legal moves are the state
 * machine's business (assertRequisitionTransition), and a same-status PATCH is
 * a harmless no-op there.
 *
 * @param {{ status?: string|null }} _existing  the row as it is NOW (pre-merge);
 *                                              kept in the signature for caller symmetry
 * @param {object} payload                     the incoming body
 * @returns {string[]} the payload keys that are field edits
 */
export function requisitionFieldEdits(_existing = {}, payload = {}) {
    const has = (key) => Object.prototype.hasOwnProperty.call(payload || {}, key);
    return FIELD_LOCKED_KEYS.filter(has);
}

/**
 * FR-02.02 — assert a requisition's editable fields may change.
 *
 * Throws 409 HR-RECRUITMENT-REQUISITION-LOCKED when the requisition is beyond
 * DRAFT and the payload carries at least one field edit. A caller that wants to
 * also move the status passes the row AFTER merging its payload (the same shape
 * `assertRequisitionTransition`'s gate consumes), so a DRAFT → PENDING_APPROVAL
 * submit-with-fields PATCH is judged as the edit it is — allowed from DRAFT.
 */
export function assertRequisitionFieldsEditable(existing = {}, payload = {}) {
    const status = String(existing.status || "").trim().toUpperCase();
    if (status === "DRAFT" || status === "") return; // legacy tenantless rows behave as drafts
    const edits = requisitionFieldEdits(existing, payload);
    if (edits.length > 0) {
        throw Object.assign(
            new Error(
                `Requisition fields are locked after submission (status ${status}); ` +
                `reject it back to DRAFT to edit. Locked fields attempted: ${edits.join(", ")}`,
            ),
            { status: 409, code: "HR-RECRUITMENT-REQUISITION-LOCKED", fields: edits },
        );
    }
}

/**
 * The hiring-reason/replacement pairing rule, checked against the MERGED row.
 *
 * It deliberately does NOT live in `pickRequisitionFields`: a payload that sets
 * only `hiringReason: REPLACEMENT` is legal when the row already names a
 * replacement, and a payload that sets only `replacementEmployeeId` is legal when
 * the reason is already REPLACEMENT. Only the resulting row can answer the
 * question, so both writers call this after merging. The DB CHECK constraint
 * enforces the same rule, so a write that never comes through here still cannot
 * store a REPLACEMENT with nobody named.
 */
export function assertReplacementPairing(row = {}) {
    if (
        String(row.hiringReason || "").toUpperCase() === "REPLACEMENT" &&
        isBlank(row.replacementEmployeeId)
    ) {
        throw fieldError(
            "replacementEmployeeId is required when the hiring reason is REPLACEMENT",
            "HR-RECRUITMENT-REPLACEMENT-REQUIRED",
        );
    }
}

// ── The submission gate (decision record §1.1) ───────────────────────────────
//
// Mandatory at SUBMISSION — not at creation. Every requisition already in the
// database stays readable and editable; it simply cannot be submitted until it
// complies. Deliberately NOT grandfathered: the alternative is a rule that
// applies to new records only, which means the approval chain validates a
// different field set depending on when the row was created.
//
// "Department" and "Business Unit" both resolve to `departmentId`. This codebase
// has exactly one column (JobRequisition.departmentId) and no separate
// BusinessUnit parent, so requiring two fields would require inventing a second
// one that no consumer reads. Recorded here so the decision is visible rather
// than silently collapsed.

export const MANDATORY_SUBMISSION_FIELDS = Object.freeze([
    "title",
    "departmentId",
    "location",
    "employmentType",
    "openings",
    "requestedById",
    "hiringReason",
    "costCenterRef",
]);

const FIELD_LABELS = Object.freeze({
    title: "Job title",
    departmentId: "Department / business unit",
    location: "Location",
    employmentType: "Employment type",
    openings: "Number of openings",
    requestedById: "Hiring manager",
    hiringReason: "Hiring reason",
    costCenterRef: "Cost center / budget reference",
    replacementEmployeeId: "Replacement employee (required when the hiring reason is replacement)",
});

/**
 * Every mandatory field the requisition is still missing, in label order.
 * Pure and exported so the UI can render the same list the gate enforces.
 */
export function missingSubmissionFields(requisition) {
    if (!requisition) return [...MANDATORY_SUBMISSION_FIELDS.map((f) => ({ field: f, label: FIELD_LABELS[f] }))];

    const missing = MANDATORY_SUBMISSION_FIELDS.filter((field) => isBlank(requisition[field])).map(
        (field) => ({ field, label: FIELD_LABELS[field] }),
    );

    // Conditionally required: a replacement requisition must name who it replaces.
    // Pinned by a CHECK constraint too, so the rule holds even for a write that
    // never passes through this gate.
    if (
        String(requisition.hiringReason || "").toUpperCase() === "REPLACEMENT" &&
        isBlank(requisition.replacementEmployeeId)
    ) {
        missing.push({ field: "replacementEmployeeId", label: FIELD_LABELS.replacementEmployeeId });
    }

    return missing;
}

/**
 * Throw 422 listing every missing mandatory field when a requisition is not
 * submittable. Reports ALL of them at once rather than the first, so a recruiter
 * fixes the form in one pass instead of submitting and being told eight times.
 */
export function assertRequisitionSubmittable(requisition) {
    const missing = missingSubmissionFields(requisition);
    if (!missing.length) return;
    throw Object.assign(
        new Error(
            `Requisition cannot be submitted until these fields are set: ${missing
                .map((m) => m.label)
                .join(", ")}`,
        ),
        {
            status: 422,
            code: "HR-RECRUITMENT-REQUISITION-INCOMPLETE",
            details: { missingFields: missing.map((m) => m.field), missing },
        },
    );
}
