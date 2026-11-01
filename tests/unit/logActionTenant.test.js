// The Log table rejects a null company. 111 call sites omit tenantId (issues 323, 324, 327): logAction now falls back to the
// verified company of the current context, then the actor's own company. The caller's value always wins.
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const TRUSOFT = "40314ef4-0a81-4390-b631-b3ad3f21f523";
const LIVE = "066dd015-2820-47b5-b2fc-1e9704f0f420";
const created = [];
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: {
    employee: { findUnique: async ({ where }) => (where.id === 558 ? { id: 558, tenant_id: TRUSOFT } : null) },
    log: { create: async ({ data }) => { created.push(data); } },
  },
}));
const { logAction } = await import("../../src/utils/logs.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");

const base = { employeeId: 558, type: "UPDATE", module: "Employee", result: "SUCCESS" };
beforeEach(() => { created.length = 0; });

describe("logAction company", () => {
  it("keeps the company the caller passes", async () => {
    await mcpCtx.run({ user: { tenantId: LIVE } }, () => logAction({ ...base, tenantId: TRUSOFT }));
    expect(created[0].tenantId).toBe(TRUSOFT);
  });
  it("uses the verified company of the current context when the caller omits it", async () => {
    await mcpCtx.run({ system: true, user: { tenantId: LIVE } }, () => logAction(base));
    expect(created[0].tenantId).toBe(LIVE);
  });
  it("falls back to the actor's company outside any context", async () => {
    await logAction(base);
    expect(created[0].tenantId).toBe(TRUSOFT);
  });
  it("ignores a malformed company and never writes a non-UUID", async () => {
    await mcpCtx.run({ user: { tenantId: "not-a-uuid" } }, () => logAction({ ...base, employeeId: 1, tenantId: "x" }));
    expect(created[0].tenantId).toBeNull();
  });
});
