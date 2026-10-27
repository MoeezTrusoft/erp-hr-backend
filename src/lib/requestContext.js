import { AsyncLocalStorage } from "node:async_hooks";

// REST, MCP, audit and tenant scoping share the same async request identity.
export const mcpCtx = new AsyncLocalStorage();
export const runWithRequestContext = (context, fn) => mcpCtx.run({ ...mcpCtx.getStore(), ...context }, fn);
export const currentRequestContext = () => mcpCtx.getStore() ?? null;
export const currentCorrelationId = () => currentRequestContext()?.correlationId ?? null;
