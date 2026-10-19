import { AsyncLocalStorage } from "node:async_hooks";

// Shared request identity; REST, MCP and database scoping use one store.
export const mcpCtx = new AsyncLocalStorage();

// NFR-03 correlation-id propagation. The correlationId middleware runs the rest
// of the request inside this context so audit writers deep in the service layer
// can read the current correlation id without a parameter. It is a separate
// store from mcpCtx on purpose: it carries no identity, only tracing, and it is
// bound for REST requests before any identity is established. Outside a request
// (cron jobs, queue workers) both stores are empty and callers pass their own id.
const correlationStorage = new AsyncLocalStorage();

/** Run `fn` with { correlationId } bound for the whole async chain. */
export const runWithRequestContext = (context, fn) =>
  correlationStorage.run(context, fn);

/** The current correlation context, or null outside one. Never throws. */
export const currentRequestContext = () => {
  try {
    return correlationStorage.getStore() ?? null;
  } catch {
    return null;
  }
};

/**
 * The current correlation id: the REST correlation context first, then the
 * MCP context (whose correlationId comes from the edge header), else null.
 */
export const currentCorrelationId = () => {
  const fromRequest = currentRequestContext()?.correlationId;
  if (fromRequest) return fromRequest;
  try {
    return mcpCtx.getStore()?.correlationId ?? null;
  } catch {
    return null;
  }
};
