// src/controllers/performance.respond.js — PERF-P0 shared error responder for
// the legacy performance controllers. A TYPED error (status < 500: validation
// HR-4000, not-found HR-4040, conflict HR-4090, precondition HR-4120) is
// rendered with its message + field errors so a client can act on it; anything
// untyped (Prisma, bugs) goes through respondServerError, which logs the full
// error and returns the leak-safe envelope.
import { respondPreconditionAware, respondServerError } from "../utils/httpError.js";

export const respondPerformanceError = (req, res, error, fallbackStatus = 400) => {
  if (respondPreconditionAware(res, error)) return;
  const status = error?.status || error?.statusCode;
  if (status && status < 500) {
    res.status(status).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  respondServerError(req, res, error, fallbackStatus >= 500 ? fallbackStatus : 500);
};

export const actorOf = (req) => req.headers?.["employee-id"] || req.user?.employeeId;
export const tenantOf = (req) => req.user?.tenantId;
