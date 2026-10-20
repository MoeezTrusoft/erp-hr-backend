// tests/unit/mcp/mcp-error-domain-code.test.js
//
// A domain code (HR-RECRUITMENT-*) collapses to its HR-nnnn class on the MCP
// path; a client-facing one also rides along as details.code so a screen can
// tell, say, "assessment required" from any other 409. 5xx stays generic.
import { describe, it, expect } from "@jest/globals";

import { toJsonRpcError } from "../../../src/mcp/utils/mcpErrorMap.js";

const err = (status, code, extra = {}) => Object.assign(new Error("The on-site assessment must be passed"), { status, code, ...extra });

describe("toJsonRpcError domain codes", () => {
    it("adds the domain code to details for a 4xx", () => {
        const out = toJsonRpcError(err(409, "HR-RECRUITMENT-ASSESSMENT-REQUIRED", { details: { assessmentStatus: "FAILED" } }));
        expect(out.data.details).toEqual({ assessmentStatus: "FAILED", code: "HR-RECRUITMENT-ASSESSMENT-REQUIRED" });
        expect(out.data.code).toMatch(/^HR-\d{4}$/);
    });

    it("creates details when there were none and never overwrites a details.code", () => {
        expect(toJsonRpcError(err(409, "HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL")).data.details).toEqual({ code: "HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL" });
        const kept = toJsonRpcError(err(409, "HR-RECRUITMENT-X", { details: { code: "HR-RECRUITMENT-BLUEPRINT-POOL-SHALLOW" } }));
        expect(kept.data.details.code).toBe("HR-RECRUITMENT-BLUEPRINT-POOL-SHALLOW");
    });

    it("leaves string or list details, HR-nnnn codes and 5xx alone", () => {
        expect(toJsonRpcError(err(409, "HR-RECRUITMENT-SCHEDULE-COMPLETED", { details: "HR-RECRUITMENT-SCHEDULE-COMPLETED" })).data.details).toBe("HR-RECRUITMENT-SCHEDULE-COMPLETED");
        expect(toJsonRpcError(err(409, "HR-4200")).data.details).toBeUndefined();
        expect(toJsonRpcError(err(500, "HR-RECRUITMENT-INTERNAL")).data.details).toBeUndefined();
    });
});
