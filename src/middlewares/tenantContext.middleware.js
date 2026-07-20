// src/middlewares/tenantContext.middleware.js — establish the async-local tenant
// context for REST requests.
//
// The MCP facade already wraps each call in mcpCtx.run (mcpRouter.js); REST did
// not, so the Prisma tenant-scope + RLS extensions had no context on REST paths.
// This middleware runs AFTER internalServiceGuard has filled req.user.tenantId
// from the VERIFIED service-JWT claim, then binds that identity to mcpCtx so
// every query in the request auto-scopes (deny-by-default).
import { mcpCtx } from '../mcp/context.js';

export const establishTenantContext = (req, _res, next) => {
    const store = {
        user: req.user || null,
        permissions: req.user?.permissions ?? {},
        correlationId: req.correlationId,
    };
    return mcpCtx.run(store, next);
};
