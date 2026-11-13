// src/controllers/resume.controller.js — REST surface for AI resume parsing.
// Mirrors the MCP resume tools. Deny-by-default authorization via the
// gateway-resolved entitlement blob (req.user.permissions), same as the payroll
// guard. All heavy AI work is delegated to resumeParsing.service.js (lazy deps).
import { hasPermission } from "../mcp/utils/assertPermission.js";
import { sendSuccess, sendError } from "../utils/response.js";
import {
  parseResumePreview,
  ingestEmployeeResume,
  ingestCandidateResume,
} from "../services/resumeParsing.service.js";

const fail = (res, err) =>
  sendError(res, err?.message || "Resume operation failed", err?.status || 500, [
    { code: err?.code || "HR-RESUME", message: err?.message || "Resume operation failed" },
  ]);

const deny = (res) =>
  sendError(res, "Forbidden", 403, [{ code: "HR-RESUME-FORBIDDEN", message: "Insufficient permission" }]);

// POST /api/resume/parse-preview   { resumeMediaId }
export const previewResume = async (req, res) => {
  try {
    if (!hasPermission(req.user?.permissions, "hr:employee", "VIEW")) return deny(res);
    const mediaId = req.body?.resumeMediaId ?? req.query?.resumeMediaId ?? req.params?.mediaId;
    if (!mediaId) return sendError(res, "resumeMediaId is required", 400);
    const data = await parseResumePreview(mediaId);
    return sendSuccess(res, data, "Resume parsed");
  } catch (err) {
    return fail(res, err);
  }
};

// POST /api/resume/employees/:employeeId/ingest   { resumeMediaId }
export const ingestForEmployee = async (req, res) => {
  try {
    if (!hasPermission(req.user?.permissions, "hr:employee", "CREATE")) return deny(res);
    const employeeId = req.params.employeeId || req.body?.employeeId;
    const resumeMediaId = req.body?.resumeMediaId;
    if (!employeeId || !resumeMediaId) return sendError(res, "employeeId and resumeMediaId are required", 400);
    const data = await ingestEmployeeResume({
      employeeId,
      mediaId: resumeMediaId,
      tenantId: req.user?.tenantId ?? null,
      actorId: req.user?.employeeId || req.user?.userId,
    });
    return sendSuccess(res, data, "Resume ingested into employee");
  } catch (err) {
    return fail(res, err);
  }
};

// POST /api/resume/candidates/:candidateId/ingest   { resumeMediaId? }
export const ingestForCandidate = async (req, res) => {
  try {
    if (!hasPermission(req.user?.permissions, "hr:recruitment", "CREATE")) return deny(res);
    const candidateId = req.params.candidateId || req.body?.candidateId;
    if (!candidateId) return sendError(res, "candidateId is required", 400);
    const data = await ingestCandidateResume({
      candidateId,
      mediaId: req.body?.resumeMediaId, // optional → falls back to candidate.resumeMediaId
      tenantId: req.user?.tenantId ?? null,
    });
    return sendSuccess(res, data, "Resume ingested into candidate");
  } catch (err) {
    return fail(res, err);
  }
};
