// src/mcp/tools/kiosk-resume.tools.js
//
// Recruitment Phase 6 — kiosk crash resume over MCP: reception issues a fresh
// one-time code that moves an interrupted sitting to another kiosk at the same
// site (reception.service.js issueKioskResumeCode; the kiosk exchanges it at
// POST /kiosk/v1/sessions/resume).
//
// Who may: the reception capability (RECEPTION / RECEPTIONIST roles, or a
// recruiter), PUT on hr:recruitment, as the other proctor actions. Answers 503
// HR-RECRUITMENT-ONSITE-TEST-DISABLED or HR-RECRUITMENT-KIOSK-RESUME-DISABLED
// while either flag is off (flag first, so a disabled feature answers the
// same to everyone). Never an item, a key, a score or a band.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { assertAssessmentCapability, resolveAssessmentAccess } from "../../lib/assessment-access.util.js";
import { assertKioskResumeEnabled } from "../../services/test-session.service.js";
import { issueKioskResumeCode } from "../../services/reception.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);

export function registerKioskResumeTools(server) {
    server.tool(
        "hr_test_session_resume_code_issue",
        "Resume a test sitting interrupted by a kiosk crash on another ACTIVE kiosk at the same site (or the restarted one). Returns a six-digit code ONCE (single use, valid 15 minutes, only on that kiosk); the crashed kiosk stops working for the session at once. The candidate gets the same questions and saved answers back and the clock is not changed (no time is added). At most 2 resumes per sitting; each is recorded on the integrity timeline.",
        {
            sessionId: idInput.describe("The interrupted session (IN_PROGRESS or PAUSED)"),
            workstationId: idInput.describe("The kiosk the candidate continues on"),
            reason: z.string().max(1000).optional().describe("What happened to the kiosk"),
            siteRef: z.string().min(1).max(100).optional().describe("Your site (required unless you are a recruiter)"),
        },
        withToolError(async (args) => {
            assertKioskResumeEnabled();
            const { user, permissions } = getCtx();
            assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
            const access = resolveAssessmentAccess(user);
            assertAssessmentCapability(access, "reception");
            return text(await issueKioskResumeCode({ ...args, tenantId: user.tenantId, access, actorId: access.employeeId ?? null }));
        }, "hr_test_session_resume_code_issue"),
    );
}

export default registerKioskResumeTools;
