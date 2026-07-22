// src/middlewares/error.middleware.js — ERR-1/2/3/4 · terminal error handler.
//
// The SINGLE terminal error middleware for the HR service. Mounted LAST in
// createApp() (after every route). Any error that reaches it — a thrown
// AppError, a ZodError from a boundary parse, a Prisma error, or an unexpected
// bug — is:
//   * logged ONCE server-side with the full error + stack + correlationId
//     (ERR-7 observability) using the per-request child logger (req.log),
//   * rendered into the ONE canonical ErrorEnvelope (ERR-2):
//       { error: { code:'HR-nnnn', message, details?, correlationId } }
//   * with 5xx bodies carrying a GENERIC message + HR-5000 only — never the raw
//     error.message / Prisma / RLS / stack detail (ERR-3 CRITICAL).
//
// 4xx (operational) messages are client-safe and preserved; validation errors
// (ZodError) map issues[] → details[] under HR-1000.
import { ZodError } from 'zod';

import { AppError } from '../utils/AppError.js';
import { HR_ERRORS, GENERIC_INTERNAL } from '../constants/errorCodes.js';
import defaultLogger from '../lib/logger.js';

// Map a bare 4xx status (no HR-nnnn on the error) to a registry code.
function defaultCodeForStatus(httpStatus) {
    switch (httpStatus) {
        case 400: return HR_ERRORS.BAD_REQUEST.code;
        case 401: return HR_ERRORS.UNAUTHORIZED.code;
        case 403: return HR_ERRORS.FORBIDDEN.code;
        case 404: return HR_ERRORS.NOT_FOUND.code;
        case 409: return HR_ERRORS.CONFLICT.code;
        case 412: return HR_ERRORS.PRECONDITION_FAILED.code;
        case 428: return HR_ERRORS.PRECONDITION_REQUIRED.code;
        default: return HR_ERRORS.BAD_REQUEST.code;
    }
}

/**
 * Normalize any thrown value into { httpStatus, code, message, details,
 * isOperational }. 5xx messages are genericized here (ERR-3).
 */
export function normalizeError(err) {
    // Zod validation → one details entry per issue, client-safe (HR-1000).
    if (err instanceof ZodError) {
        return {
            httpStatus: HR_ERRORS.VALIDATION.httpStatus,
            code: HR_ERRORS.VALIDATION.code,
            message: HR_ERRORS.VALIDATION.message,
            details: err.issues.map((i) => ({
                path: Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''),
                code: i.code,
                message: i.message,
            })),
            isOperational: true,
        };
    }

    // A typed AppError, or ANY error carrying a numeric HTTP status (a legacy
    // service error such as `Object.assign(new Error(msg), { status: 403 })` or
    // the benefit.service `err(code, message, statusCode)` helper). Trust the
    // status + a client-safe message for 4xx; genericize the message for 5xx
    // (ERR-3) while preserving a valid HR-nnnn code when present.
    const status = err?.httpStatus || err?.statusCode || err?.status;
    const numericStatus = Number.isInteger(status) ? status : null;
    if (err instanceof AppError || numericStatus) {
        const httpStatus = numericStatus || 500;
        const hasHrCode = typeof err?.code === 'string' && /^HR-\d{4}$/.test(err.code);
        if (httpStatus >= 500) {
            return {
                httpStatus,
                code: hasHrCode ? err.code : GENERIC_INTERNAL.code,
                message: GENERIC_INTERNAL.message,
                details: undefined,
                isOperational: false,
            };
        }
        return {
            httpStatus,
            code: hasHrCode ? err.code : defaultCodeForStatus(httpStatus),
            message: err.message || HR_ERRORS.BAD_REQUEST.message,
            details: err.details,
            isOperational: err.isOperational ?? true,
        };
    }

    // Unknown / unexpected → generic 500 (ERR-3: never leak err.message).
    return {
        httpStatus: GENERIC_INTERNAL.httpStatus,
        code: GENERIC_INTERNAL.code,
        message: GENERIC_INTERNAL.message,
        details: undefined,
        isOperational: false,
    };
}

/**
 * Build the canonical ErrorEnvelope body for a normalized error.
 * @returns {{ error: { code:string, message:string, details?:any, correlationId?:string } }}
 */
export function buildErrorEnvelope(norm, correlationId) {
    const error = { code: norm.code, message: norm.message };
    if (norm.details !== undefined) error.details = norm.details;
    if (correlationId) error.correlationId = correlationId;
    return { error };
}

/**
 * Express terminal error middleware (must keep the 4-arg signature so Express
 * routes it as the error handler).
 */
export function errorHandler(err, req, res, next) {
    const norm = normalizeError(err);
    const correlationId = req?.correlationId;
    const log = (req && req.log) || defaultLogger;

    // Log the FULL error server-side exactly once. Non-operational/5xx at error
    // level (operator-actionable), expected 4xx at warn (not operator-actionable).
    const logPayload = {
        err,
        code: norm.code,
        httpStatus: norm.httpStatus,
        req: req && { method: req.method, path: req.originalUrl || req.url },
    };
    if (norm.httpStatus >= 500) {
        log.error(logPayload, `${norm.code} request failed`);
    } else {
        log.warn(logPayload, `${norm.code} request rejected`);
    }

    if (res.headersSent) {
        return next(err);
    }
    res.status(norm.httpStatus).json(buildErrorEnvelope(norm, correlationId));
}

/**
 * Wrap an async route handler so a thrown/rejected error reaches the terminal
 * handler via next(err). (Express 5 already forwards async rejections, but this
 * makes the intent explicit and is safe to use on new handlers.)
 */
export function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export default errorHandler;
