// src/utils/AppError.js — ERR-1 · single typed application error.
//
// AppError carries a machine-stable {code, httpStatus, details, isOperational}
// so the terminal error middleware can render one consistent ErrorEnvelope and
// the MCP facade can map the SAME code to a JSON-RPC error.data.code (ERR-5).
//
// Backwards-compatible: the legacy `new AppError(message, statusCode)` signature
// (used by ~30 service call sites) still works — statusCode maps to httpStatus,
// `code` defaults to a range-appropriate HR-nnnn, and `.statusCode`/`.status`
// remain readable. Prefer the static factories (AppError.notFound(), etc.) or
// `AppError.from(HR_ERRORS.X, details)` at new call sites.
import { HR_ERRORS } from '../constants/errorCodes.js';

function defaultCodeFor(statusCode) {
    switch (statusCode) {
        case 400: return HR_ERRORS.BAD_REQUEST.code;
        case 401: return HR_ERRORS.UNAUTHORIZED.code;
        case 403: return HR_ERRORS.FORBIDDEN.code;
        case 404: return HR_ERRORS.NOT_FOUND.code;
        case 409: return HR_ERRORS.CONFLICT.code;
        case 412: return HR_ERRORS.PRECONDITION_FAILED.code;
        case 428: return HR_ERRORS.PRECONDITION_REQUIRED.code;
        default: return HR_ERRORS.INTERNAL.code;
    }
}

class AppError extends Error {
    /**
     * @param {string} message  human-safe message (4xx only — 5xx is genericized
     *                          by the terminal handler regardless of this text).
     * @param {number} [statusCode=500]
     * @param {{ code?: string, details?: any, isOperational?: boolean }} [opts]
     */
    constructor(message, statusCode = 500, opts = {}) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.httpStatus = statusCode;
        this.code = opts.code || defaultCodeFor(statusCode);
        this.details = opts.details;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        // Operational = an expected, client-actionable error (not a bug). 4xx are
        // operational by default; explicit override wins.
        this.isOperational = opts.isOperational ?? `${statusCode}`.startsWith('4');

        Error.captureStackTrace(this, this.constructor);
    }

    /**
     * Build an AppError from a registry entry (constants/errorCodes.js).
     * @param {{code:string,httpStatus:number,message:string}} def
     * @param {{ message?: string, details?: any }} [over]
     */
    static from(def, over = {}) {
        return new AppError(over.message || def.message, def.httpStatus, {
            code: def.code,
            details: over.details,
            isOperational: def.httpStatus < 500,
        });
    }

    static badRequest(message, details) {
        return AppError.from(HR_ERRORS.BAD_REQUEST, { message, details });
    }

    static notFound(message, details) {
        return AppError.from(HR_ERRORS.NOT_FOUND, { message, details });
    }

    static forbidden(message, details) {
        return AppError.from(HR_ERRORS.FORBIDDEN, { message, details });
    }

    static conflict(message, details) {
        return AppError.from(HR_ERRORS.CONFLICT, { message, details });
    }
}

export { AppError };
export default AppError;
