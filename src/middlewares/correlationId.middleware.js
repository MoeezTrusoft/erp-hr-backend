// src/middlewares/correlationId.middleware.js — A.5 · x-correlation-id propagation.
//
// Every inbound request gets a correlation id that is traceable end-to-end:
//   * read the inbound `x-correlation-id` header; if absent (or blank), MINT a
//     uuid,
//   * store it on req.correlationId,
//   * bind a per-request child logger (logger.child({ correlationId })) on
//     req.log so this request's structured logs all carry the same id,
//   * echo the id back on the response `x-correlation-id` header,
//   * (outbound) forwardCorrelationHeader() merges the same id into any header
//     bag used for a call to another service so the chain is unbroken.
//
// The correlation id is the SAME value an event PRODUCER sets on
// EventEnvelope.correlationId (see src/services/employeeOutbox.service.js), so
// a business action is traceable from the HTTP edge through to the emitted
// fabric event. Distinct from req.requestId (apiContract.js): requestId is this
// hop's id, correlationId is the cross-service chain id.
import { randomUUID } from 'node:crypto';

import defaultLogger from '../lib/logger.js';

export const CORRELATION_HEADER = 'x-correlation-id';

// Header values arrive lowercased on req.headers; tolerate arrays defensively
// (a duplicated header yields a string[] in node). Only the first non-blank
// value is honored; anything else mints a fresh id.
function readInbound(headers) {
    const raw = headers?.[CORRELATION_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) return value.trim();
    return null;
}

/**
 * Express middleware: attach req.correlationId + req.log (child logger) and
 * echo `x-correlation-id` on the response.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {{ logger?: object }} [deps]  injectable logger for tests.
 */
export function attachCorrelationId(req, res, next, { logger = defaultLogger } = {}) {
    const correlationId = readInbound(req.headers) || randomUUID();
    req.correlationId = correlationId;
    // Bind the per-request child logger so every log line for this request
    // carries the correlationId without each call site repeating it.
    req.log = typeof logger?.child === 'function'
        ? logger.child({ correlationId })
        : logger;
    res.setHeader(CORRELATION_HEADER, correlationId);
    next();
}

/**
 * Build an outbound header bag that forwards the current request's correlation
 * id to a peer service. Returns a FRESH object (never mutates the input) so the
 * caller's defaults are preserved while the `x-correlation-id` is threaded in.
 * A no-op for the correlation key when req has no correlationId.
 *
 * @param {{ correlationId?: string }} req
 * @param {object} [headers]  existing outbound headers (e.g. auth).
 * @returns {object} headers + x-correlation-id when available.
 */
export function forwardCorrelationHeader(req, headers = {}) {
    const out = { ...headers };
    if (req?.correlationId) {
        out[CORRELATION_HEADER] = req.correlationId;
    }
    return out;
}

export default attachCorrelationId;
