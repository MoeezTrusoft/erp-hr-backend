// src/lib/performance-errors.js — PERF-P0 shared typed errors for the legacy
// performance-appraisal services. A thrown error carries `status` (read by the
// MCP controller runner) and `statusCode` (read by respondServerError) so the
// same throw renders as the right HTTP / JSON-RPC status on both surfaces, with
// a stable HR-nnnn code instead of a Prisma message.

export const perfError = (message, status = 400, code = undefined, extra = {}) =>
  Object.assign(new Error(message), {
    status,
    statusCode: status,
    ...(code ? { code } : {}),
    ...extra,
  });

export const notFound = (what) => perfError(`${what} not found`, 404, "HR-4040");

export const conflict = (message) => perfError(message, 409, "HR-4090");

// Prisma unique-constraint violation (the DB-level duplicate guard).
export const isUniqueViolation = (err) => err?.code === "P2002";

// Round a float rating to two decimals for stable comparisons / display.
export const round2 = (n) => Math.round(Number(n) * 100) / 100;

export const mean = (nums) =>
  nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : null;
