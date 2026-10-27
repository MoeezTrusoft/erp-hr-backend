// src/constants/errorCodes.js — ERR-6 · central HR-nnnn error-code registry.
//
// Single source of truth for HR's machine-stable error codes and their default
// HTTP status + a client-safe message. Throw sites and the terminal error
// middleware reference these constants instead of scattering inline 'HR-nnnn'
// string literals (which risk collision/drift and defeat a build-time
// completeness check).
//
// Ranges (loosely, matching what already exists in the codebase):
//   HR-1xxx  validation / bad request (client-safe messages)
//   HR-2xxx  money / payroll arithmetic (internal invariants)
//   HR-4xxx  authorization / not-found / conflict / tenancy-deny
//   HR-5xxx  internal / unexpected (client message is ALWAYS generic — ERR-3)
//
// `message` here is the CLIENT-SAFE default. For 5xx codes it is deliberately
// generic (never the raw error) so no Prisma/RLS/internal detail leaks (ERR-3).

/**
 * @typedef {Object} ErrorCodeDef
 * @property {string} code       machine-stable HR-nnnn code
 * @property {number} httpStatus default HTTP status
 * @property {string} message    client-safe default message
 */

/** @type {Record<string, ErrorCodeDef>} */
export const HR_ERRORS = {
    // ---- validation (client-safe) ----
    VALIDATION: { code: 'HR-1000', httpStatus: 400, message: 'Validation failed' },
    BAD_REQUEST: { code: 'HR-1001', httpStatus: 400, message: 'Bad request' },

    // ---- authorization / resource ----
    UNAUTHORIZED: { code: 'HR-4010', httpStatus: 401, message: 'Unauthorized' },
    FORBIDDEN: { code: 'HR-4030', httpStatus: 403, message: 'Forbidden' },
    NOT_FOUND: { code: 'HR-4040', httpStatus: 404, message: 'Resource not found' },
    CONFLICT: { code: 'HR-4090', httpStatus: 409, message: 'Conflict' },
    PRECONDITION_FAILED: { code: 'HR-4120', httpStatus: 412, message: 'Precondition failed' },
    PRECONDITION_REQUIRED: { code: 'HR-4280', httpStatus: 428, message: 'Precondition required' },
    PAYROLL_PERIOD: { code: 'HR-4301', httpStatus: 400, message: 'Invalid payroll period' },
    PAYROLL_READINESS: { code: 'HR-4302', httpStatus: 409, message: 'Complete payroll setup before processing' },
    PAYROLL_LOAN_CHANGED: { code: 'HR-4303', httpStatus: 409, message: 'Loan balance changed; reconcile payroll before finalization' },

    // ---- internal / unexpected (ERR-3: generic client message only) ----
    INTERNAL: { code: 'HR-5000', httpStatus: 500, message: 'Internal server error' },
    // A capability switched off by its rollout flag (a 503 whose code ends in
    // -DISABLED, e.g. HR-RECRUITMENT-SCORING-DISABLED). Operational and safe to
    // name, so clients can show "turned off" instead of a generic failure.
    FEATURE_DISABLED: { code: 'HR-5031', httpStatus: 503, message: 'This feature is turned off' },
    // A service this request depends on (DAM, the AI plane, the calendar, the
    // e-signature provider) could not be reached or did not answer in time.
    // Operational and retryable: the message is generic and fixed, the domain
    // code (one of DEPENDENCY_UNAVAILABLE_CODES) rides in details.code.
    DEPENDENCY_UNAVAILABLE: {
        code: 'HR-5032',
        httpStatus: 503,
        message: 'A service this request depends on is temporarily unavailable; please try again',
    },
};

// The client-facing domain codes that mean "a dependency was unavailable",
// reported as HR-5032 (with the domain code in details.code) when they are
// thrown with a 5xx status, or with no status at all. Any other 5xx stays
// HR-5000 with no detail (ERR-3). A 4xx with one of these codes (e.g. the 409
// HR-RECRUITMENT-SLOT-UNAVAILABLE "pick another slot") is an ordinary 4xx.
export const DEPENDENCY_UNAVAILABLE_CODES = Object.freeze([
    'HR-AI-PLANE-UNAVAILABLE',
    'HR-ONBOARDING-DAM-UNAVAILABLE',
    'HR-RECRUITMENT-AI-UNAVAILABLE',
    'HR-RECRUITMENT-CALENDAR-TIMEOUT',
    'HR-RECRUITMENT-CALENDAR-UNAVAILABLE',
    'HR-RECRUITMENT-DSR-EXPORT-UPLOAD-FAILED',
    'HR-RECRUITMENT-ESIGN-PROVIDER-UNAVAILABLE',
    'HR-RECRUITMENT-EVALUATION-UPLOAD-FAILED',
    'HR-RECRUITMENT-OFFER-LETTER-DOCUMENT-UNAVAILABLE',
    'HR-RECRUITMENT-OFFER-LETTER-UPLOAD-FAILED',
    'HR-RESUME-DAM-FETCH',
    // Phase 7 (D17): the AI plane answered with a failure. The parse retries
    // it on its own schedule; the client can try again too.
    'HR-RESUME-PLANE-FAILED',
    'HR-RECRUITMENT-AI-DRAFT-FAILED',
    'HR-RECRUITMENT-AI-OUTPUT-INVALID',
    // The resume queue's store (Redis / the ledger) refused the enqueue.
    'HR-RECRUITMENT-PARSE-QUEUE-FAILED',
    'HR-RESUME-PLANE-PENDING',
]);

const DEPENDENCY_CODE_SET = new Set(DEPENDENCY_UNAVAILABLE_CODES);

/**
 * True for a domain code that names an unavailable dependency: one listed
 * above, or any HR-*-UNAVAILABLE code (new dependency codes follow that
 * naming). Only meaningful together with a 5xx (or missing) status.
 * @param {unknown} code
 */
export function isDependencyUnavailableCode(code) {
    if (typeof code !== 'string' || !/^HR-[A-Z][A-Z0-9-]{1,80}$/.test(code)) return false;
    return DEPENDENCY_CODE_SET.has(code) || /-UNAVAILABLE$/.test(code);
}

// Fast reverse lookup: HR-nnnn code string → definition. Lets the terminal
// handler and the MCP mapper resolve a code that arrived on an AppError.
export const HR_ERROR_BY_CODE = Object.freeze(
    Object.fromEntries(Object.values(HR_ERRORS).map((d) => [d.code, d])),
);

// The single generic code every unexpected/5xx error collapses to for clients.
export const GENERIC_INTERNAL = HR_ERRORS.INTERNAL;

Object.freeze(HR_ERRORS);

export default HR_ERRORS;
