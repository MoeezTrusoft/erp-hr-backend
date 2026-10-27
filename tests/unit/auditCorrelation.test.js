// tests/unit/auditCorrelation.test.js
//
// NFR-03 — correlation ids land in audit rows:
//   * the correlationId middleware binds the id for the whole async chain
//   * logAction stamps it onto the Log row automatically (no parameter), with
//     an explicit caller value taking precedence
//   * outside a request (no context) the row is written with null — never a
//     throw, never a fabricated id
import { jest } from "@jest/globals";

const prismaLogCreate = jest.fn(async (args) => ({ id: 1, ...args.data }));
const employeeFindUnique = jest.fn(async ({ where }) => ({ id: where.id }));

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: { log: { create: prismaLogCreate }, employee: { findUnique: employeeFindUnique } },
}));

const { logAction } = await import("../../src/utils/logs.js");
const { runWithRequestContext, currentCorrelationId } = await import("../../src/lib/requestContext.js");

describe("NFR-03 — correlation id reaches audit rows", () => {
  beforeEach(() => {
    prismaLogCreate.mockClear();
    employeeFindUnique.mockClear();
  });

  test("an explicit correlationId wins over the ambient context", async () => {
    await runWithRequestContext({ correlationId: "ambient-id" }, async () => {
      await logAction({ employeeId: 7, type: "UPDATE", module: "Update Requisition", result: "SUCCESS", correlationId: "explicit-id", tenantId: "t1" });
    });
    expect(prismaLogCreate.mock.calls[0][0].data.correlationId).toBe("explicit-id");
  });

  test("inside a request context the id is stamped automatically — no parameter", async () => {
    await runWithRequestContext({ correlationId: "req-42" }, async () => {
      expect(currentCorrelationId()).toBe("req-42");
      await logAction({ employeeId: 7, type: "CREATE", module: "Create Candidate", result: "SUCCESS", tenantId: "t1" });
    });
    expect(prismaLogCreate.mock.calls[0][0].data.correlationId).toBe("req-42");
  });

  test("outside any context the row is written with null — no throw, no fabricated id", async () => {
    expect(currentCorrelationId()).toBeNull();
    await logAction({ type: "DELETE", module: "Delete Requisition", result: "SUCCESS" });
    expect(prismaLogCreate.mock.calls[0][0].data.correlationId).toBeNull();
  });

  test("the context survives awaits and nested calls (async chain intact)", async () => {
    const seen = [];
    const nested = async () => { seen.push(currentCorrelationId()); };
    await runWithRequestContext({ correlationId: "chain-id" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await nested();
    });
    expect(seen).toEqual(["chain-id"]);
  });
});
