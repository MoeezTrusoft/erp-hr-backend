import { AsyncLocalStorage } from "node:async_hooks";

export const mcpCtx = new AsyncLocalStorage();

function parseHeaderJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function getCtx() {
  const ctx = mcpCtx.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function buildContextFromHeaders(req) {
  return {
    user: {
      userId: req.headers["x-user-id"],
      email: req.headers["x-user-email"],
      roles: parseHeaderJson(req.headers["x-user-roles"], []),
      isAdmin: req.headers["x-is-admin"] === "true",
      employeeId: req.headers["x-employee-id"],
    },
    permissions: parseHeaderJson(req.headers["x-user-permissions"], {}),
  };
}
