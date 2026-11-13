import { describe, expect, it } from "@jest/globals";
import { auditActorExtension } from "../../src/lib/auditActor.js";
import { mcpCtx } from "../../src/lib/requestContext.js";

// The extension is a plain $extends definition; a stub client hands it back so the hooks can be called.
const hooks = auditActorExtension({ $extends: (definition) => definition }).query.payrollAuditLog;
const echo = (args) => args;

describe("payroll audit actor stamping", () => {
  it("stamps the signed-in user on create", () => {
    const args = mcpCtx.run({ user: { userId: 8, tenantId: "t" } }, () => hooks.create({ args: { data: { action: "X" } }, query: echo }));
    expect(args.data).toEqual({ action: "X", actorUserId: 8 });
  });
  it("stamps every row of createMany", () => {
    const args = mcpCtx.run({ user: { userId: 8 } }, () => hooks.createMany({ args: { data: [{ action: "A" }, { action: "B" }] }, query: echo }));
    expect(args.data.map((r) => r.actorUserId)).toEqual([8, 8]);
  });
  it("keeps an actor that is already set", () => {
    const args = mcpCtx.run({ user: { userId: 8 } }, () => hooks.create({ args: { data: { action: "X", actorUserId: 3 } }, query: echo }));
    expect(args.data.actorUserId).toBe(3);
  });
  it("leaves system jobs without an actor", () => {
    expect(hooks.create({ args: { data: { action: "X" } }, query: echo }).data).toEqual({ action: "X" });
    const args = mcpCtx.run({ system: true }, () => hooks.create({ args: { data: { action: "X" } }, query: echo }));
    expect(args.data.actorUserId).toBeUndefined();
  });
});
