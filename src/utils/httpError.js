// src/utils/httpError.js — ERR-3/ERR-7 · client-safe error responder.
//
// Used by controller catch-blocks that historically returned the raw caught
// error to the client (`res.status(500).json({ error: error.message })`) — a
// stack/Prisma/RLS information-disclosure leak (ERR-3). `respondServerError`
// replaces those sites: it LOGS the full error server-side once (with the
// per-request correlationId, ERR-7) and returns the generic ErrorEnvelope with
// a stable HR-nnnn code — never the raw error text.
//
// Prefer routing new handlers to the terminal error middleware via next(err);
// this helper exists so the large surface of existing local catches can be made
// leak-safe without rewriting every handler signature.
import { normalizeError, buildErrorEnvelope } from '../middlewares/error.middleware.js';
import defaultLogger from '../lib/logger.js';

/**
 * Emit a leak-safe error response for a caught error.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {unknown} err                caught error (logged in full, never leaked)
 * @param {number} [fallbackStatus=500] status when the error carries none
 */
export function respondServerError(req, res, err, fallbackStatus = 500) {
    const norm = normalizeError(err);
    // A bare caught error with no status defaults to the caller's fallback.
    if (!(err && (err.httpStatus || err.statusCode)) && !norm.details) {
        norm.httpStatus = fallbackStatus >= 500 ? norm.httpStatus : fallbackStatus;
    }
    const log = (req && req.log) || defaultLogger;
    const payload = {
        err,
        code: norm.code,
        httpStatus: norm.httpStatus,
        req: req && { method: req.method, path: req.originalUrl || req.url },
    };
    if (norm.httpStatus >= 500) log.error(payload, `${norm.code} request failed`);
    else log.warn(payload, `${norm.code} request rejected`);

    if (res.headersSent) return;
    res.status(norm.httpStatus).json(buildErrorEnvelope(norm, req?.correlationId));
}

/**
 * API-2 — controller helper for the optimistic-concurrency (412) case.
 *
 * The 5 controller-backed `hr_*_update` paths (requisition/candidate/offer/goal/
 * leave-policy) historically catch every error into a flat 400. That would
 * collapse a stale-write PreconditionFailedError (HR-4120) into a 400 and drop
 * its `currentVersion`. This helper detects that specific error and emits a
 * proper 412 body carrying `code` + `currentVersion`, which `_runner.js` then
 * re-throws so `toJsonRpcError` surfaces JSON-RPC -32009 with data.currentVersion.
 *
 * Returns true when it handled (responded to) the error; false when the caller
 * should fall back to its existing catch behavior (unchanged for every other error).
 *
 * @param {import('express').Response} res
 * @param {any} error
 * @returns {boolean}
 */
export function respondPreconditionAware(res, error) {
    const status = error?.httpStatus || error?.statusCode || error?.status;
    const isPrecondition = status === 412 || error?.code === 'HR-4120';
    if (!isPrecondition) return false;
    res.status(412).json({
        success: false,
        code: 'HR-4120',
        message: error?.message || 'Precondition failed',
        ...(error?.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
    });
    return true;
}

export default respondServerError;
