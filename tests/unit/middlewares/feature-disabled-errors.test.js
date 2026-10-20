// tests/unit/middlewares/feature-disabled-errors.test.js
//
// A rollout flag that is off answers 503 with a code ending in -DISABLED
// (HR-RECRUITMENT-SCORING-DISABLED and its siblings). The terminal handler used
// to collapse every 5xx without an HR-nnnn code to HR-5000 "Internal server
// error", so a client could not tell "this is switched off" from a crash. A
// flag-off 503 now maps to HR-5031 with its fixed safe message; every other
// 5xx is still generic (ERR-3).
import { describe, it, expect } from '@jest/globals';

import { normalizeError } from '../../../src/middlewares/error.middleware.js';
import { toJsonRpcError } from '../../../src/mcp/utils/mcpErrorMap.js';

const disabled = (code) => Object.assign(new Error(`internal detail for ${code}`), { status: 503, code });

describe("flag-off 503 errors", () => {
    it("map to HR-5031 with the safe message, never the raw one", () => {
        for (const code of [
            "HR-RECRUITMENT-SCORING-DISABLED",
            "HR-RECRUITMENT-COMMUNICATIONS-DISABLED",
            "HR-RECRUITMENT-DUPLICATES-DISABLED",
            "HR-RECRUITMENT-AI-DISABLED",
        ]) {
            const norm = normalizeError(disabled(code));
            expect(norm).toMatchObject({ httpStatus: 503, code: "HR-5031", message: "This feature is turned off" });
            expect(norm.message).not.toContain("internal detail");
        }
    });

    it("reach MCP callers as HR-5031", () => {
        expect(toJsonRpcError(disabled("HR-RECRUITMENT-SCORING-DISABLED")).data.code).toBe("HR-5031");
    });

    it("leave every other 5xx generic", () => {
        const other = Object.assign(new Error("queue write failed"), { status: 503, code: "HR-RESUME-QUEUE" });
        expect(normalizeError(other)).toMatchObject({ httpStatus: 503, code: "HR-5000", message: "Internal server error" });
        const boom = Object.assign(new Error("boom"), { status: 500, code: "HR-X-DISABLED" });
        expect(normalizeError(boom).code).toBe("HR-5000");
    });
});
