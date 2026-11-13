import { AsyncLocalStorage } from "node:async_hooks";

// Shared request identity; REST, MCP and database scoping use one store.
export const mcpCtx = new AsyncLocalStorage();
