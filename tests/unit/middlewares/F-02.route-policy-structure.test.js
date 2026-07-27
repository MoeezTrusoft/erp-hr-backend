// F-02 structural guard: production must not mount a domain router directly.
// Every /api domain mount goes through the centralized wrapper, which walks
// nested routers and installs the authoritative policy before controller code.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "@jest/globals";
import { createApp } from "../../../src/app.js";

describe("F-02 production route structure", () => {
  it("has no direct domain app.use('/api/...') mounts", () => {
    const source = readFileSync(new URL("../../../src/app.js", import.meta.url), "utf8");
    const directDomainMounts = source.match(/app\.use\(["']\/api\/(?!\?)/g) || [];
    expect(directDomainMounts).toEqual([]);
    expect(source).toContain("mountAuthorizedHrRouter");
  });

  it("boots only when every mounted production router is fully wrapped", () => {
    expect(() => createApp()).not.toThrow();
  });
});
