// tests/unit/zodMajorGate.test.js — WBS A.1 (Fleet Zod Unification)
//
// Steering: WBS A.1 step 2 — the fleet unifies on the @trusoft/contracts
// anchor, which is zod 4.4.3 (contracts v0.6.0). This gate locks this repo's
// installed zod on a single major so a future drift back to 3 (or any other
// major) fails CI, and proves the contracts boundary still parses correctly
// from this repo against the LOCAL v0.6.0 package (file:../contracts link).
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEnvelope, Permission } from "@trusoft/contracts";

const require = createRequire(import.meta.url);

// The zod major the fleet anchors on (the @trusoft/contracts dependency).
const ANCHOR_ZOD_MAJOR = 4;

function installedZodMajor() {
  // Resolve the zod actually installed in THIS repo's node_modules and read
  // its real version from package.json (version-agnostic).
  const pkgPath = require.resolve("zod/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return { version: pkg.version, major: Number(pkg.version.split(".")[0]) };
}

function contractsZodMajor() {
  // Resolve the zod that the linked @trusoft/contracts package itself loads
  // — the OTHER side of the cross-package ZodType boundary. It must share the
  // same major as this repo or schemas would not interoperate.
  const contractsDir = require.resolve("@trusoft/contracts");
  const pkgPath = require.resolve("zod/package.json", { paths: [contractsDir] });
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return { version: pkg.version, major: Number(pkg.version.split(".")[0]) };
}

describe("WBS A.1 — zod major gate (fleet unification on contracts anchor)", () => {
  it("installs zod major === 4 (matches the @trusoft/contracts anchor)", () => {
    const { version, major } = installedZodMajor();
    // RED if a future change drifts this repo off the anchor major.
    expect(major).toBe(ANCHOR_ZOD_MAJOR);
    // Belt-and-braces: the resolved line must be a real 4.x, never a stray 0/NaN.
    expect(version.startsWith("4.")).toBe(true);
  });

  it("the linked @trusoft/contracts loads zod of the same major (boundary interop)", () => {
    // Both sides of the cross-package boundary must be zod 4 for ZodType
    // instances to interoperate; the LOCAL v0.6.0 link loads zod 4.4.3.
    expect(contractsZodMajor().major).toBe(ANCHOR_ZOD_MAJOR);
  });

  it("the @trusoft/contracts boundary is intact (EventEnvelope.parse round-trips)", () => {
    // A schema imported from contracts must .parse() a valid input and reject
    // an invalid one from THIS repo — confirming the cross-package ZodType
    // boundary survives against the local v0.6.0 package.
    const validEvent = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "hr.employee.lifecycle.v1",
      occurredAt: "2026-06-24T00:00:00.000Z",
      tenantId: "33333333-3333-4333-8333-333333333333",
      actor: { type: "service", id: "erp-hr-backend" },
      correlationId: "22222222-2222-4222-8222-222222222222",
      version: 1,
      payload: { employeeId: "emp-1", change: "created" },
    };
    const parsed = EventEnvelope.parse(validEvent);
    expect(parsed.name).toBe("hr.employee.lifecycle.v1");
    expect(parsed.actor.id).toBe("erp-hr-backend");

    // Invalid: bad uuid + wrong actor shape + missing required fields must throw.
    expect(() =>
      EventEnvelope.parse({
        name: "hr.employee.lifecycle.v1",
        id: "not-a-uuid",
        actor: "erp-hr-backend",
      })
    ).toThrow();
  });

  it("contracts Permission schema parses a valid permission and rejects garbage", () => {
    // Permission is the dotted module.resource.action primitive (ARCH-01 App. F).
    const perm = "hr.employee.read";
    expect(() => Permission.parse(perm)).not.toThrow();
    expect(Permission.safeParse(123).success).toBe(false);
    expect(Permission.safeParse("").success).toBe(false);
    // Legacy colon form is NOT a valid Permission (ingress shim territory only).
    expect(Permission.safeParse("hr:employee:read").success).toBe(false);
  });
});
