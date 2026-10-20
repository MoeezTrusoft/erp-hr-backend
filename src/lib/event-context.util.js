// src/lib/event-context.util.js — F-37 acting context for outbox events.
//
// The `ctx` an hrEvents builder takes is { actorId, correlationId }. Callers that
// already know the actor pass it; otherwise it is read from the verified request
// identity (mcpCtx — REST and MCP share the store) so a service never has to
// trust a body field for attribution. The actor is the EMPLOYEE id only: an RBAC
// userId is a different identifier space and is never substituted (F-07).
// The correlation id comes from the request chain so an SSE refresh is traceable
// back to the HTTP/MCP call that caused it; absent one, the envelope mints its own.
import { mcpCtx, currentCorrelationId } from './requestContext.js';

const positiveId = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * @param {{ actorId?: number|string|null, correlationId?: string|null }} [ctx]
 * @returns {{ actorId: number|null, correlationId: string|undefined }}
 */
export const eventContext = (ctx = {}) => {
    let storeActor;
    try {
        storeActor = mcpCtx.getStore()?.user?.employeeId ?? null;
    } catch {
        storeActor = null;
    }
    return {
        actorId: positiveId(ctx?.actorId) ?? positiveId(storeActor),
        correlationId: ctx?.correlationId || currentCorrelationId() || undefined,
    };
};

export default eventContext;
