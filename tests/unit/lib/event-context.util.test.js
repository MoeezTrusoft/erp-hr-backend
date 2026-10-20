// tests/unit/lib/event-context.util.test.js — F-37 acting context for outbox events.
import { describe, it, expect } from "@jest/globals";

import { eventContext } from "../../../src/lib/event-context.util.js";
import { mcpCtx, runWithRequestContext } from "../../../src/lib/requestContext.js";

describe("eventContext", () => {
    it("prefers the caller's actor and correlation id", () => {
        expect(eventContext({ actorId: "12", correlationId: "corr-1" })).toEqual({ actorId: 12, correlationId: "corr-1" });
    });

    it("falls back to the VERIFIED employee id and the request correlation id", () => {
        const ctx = runWithRequestContext({ correlationId: "corr-req" }, () =>
            mcpCtx.run({ user: { employeeId: 7, userId: 99 } }, () => eventContext()),
        );
        expect(ctx).toEqual({ actorId: 7, correlationId: "corr-req" });
    });

    it("never substitutes the RBAC userId for a missing employee id (F-07)", () => {
        const ctx = mcpCtx.run({ user: { userId: 99 } }, () => eventContext({ actorId: null }));
        expect(ctx.actorId).toBeNull();
    });

    it("outside any request: no actor, and no correlation id (the envelope mints one)", () => {
        expect(eventContext()).toEqual({ actorId: null, correlationId: undefined });
    });
});
