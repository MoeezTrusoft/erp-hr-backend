// src/lib/requestContext.js — NFR-03 correlation-id propagation.
//
// The correlationId middleware already binds req.correlationId, but audit
// writers deep in the service layer never see `req`. Threading a correlationId
// parameter through every service signature would be invasive and would be
// forgotten by the next caller — the same failure mode this NFR row describes
// ("propagation is only partial").
//
// So the middleware runs the REST of the request inside an AsyncLocalStorage
// context, and any writer (logAction, event builders, scheduled paths that run
// inside a request) can read the CURRENT correlation id without a parameter.
// Outside a request — cron jobs, queue workers — the store is empty and
// currentCorrelationId() returns null; callers pass their own id explicitly.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with { correlationId } (and any extra context) bound for the whole
 * async chain — awaited promises, nested calls, callbacks.
 */
export const runWithRequestContext = (context, fn) => storage.run(context, fn);

/**
 * The current request context, or null outside one. Defensive: an empty store
 * must never throw inside an audit writer.
 */
export const currentRequestContext = () => {
    try {
        return storage.getStore() ?? null;
    } catch {
        return null;
    }
};

/** Convenience: the current correlation id, or null. */
export const currentCorrelationId = () => currentRequestContext()?.correlationId ?? null;
