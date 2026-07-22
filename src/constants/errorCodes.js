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

    // ---- internal / unexpected (ERR-3: generic client message only) ----
    INTERNAL: { code: 'HR-5000', httpStatus: 500, message: 'Internal server error' },
};

// Fast reverse lookup: HR-nnnn code string → definition. Lets the terminal
// handler and the MCP mapper resolve a code that arrived on an AppError.
export const HR_ERROR_BY_CODE = Object.freeze(
    Object.fromEntries(Object.values(HR_ERRORS).map((d) => [d.code, d])),
);

// The single generic code every unexpected/5xx error collapses to for clients.
export const GENERIC_INTERNAL = HR_ERRORS.INTERNAL;

Object.freeze(HR_ERRORS);

export default HR_ERRORS;
