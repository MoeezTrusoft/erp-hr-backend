import * as svc from "../services/interview.service.js";
import { respondServerError } from '../utils/httpError.js';
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";

export const scheduleInterview = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.scheduleInterview({ ...req.body, tenantId });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listInterviews = async (req, res) => {
    try {
        const { applicationId, page, limit } = req.query;
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        // Phase 1.4 — an interviewer sees only panels they sit on; a manager only
        // their own requisitions'. Interviewer notes are masked for both outward
        // scopes inside the service.
        const result = await svc.listInterviews({
            applicationId,
            page: Number(page) || 1,
            limit: Number(limit) || 20,
            tenantId,
            scope: resolveRecruitmentScope(req.user),
        });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { respondServerError(req, res, e); }
};

export const updateInterview = async (req, res) => {
    try {
        const reviewerId = req.user?.employeeId ?? null;
        // HR-INTERVIEW-FEEDBACK-01 — forward the verified tenant so the write is
        // scoped at the app layer too. It previously relied on the ORM extension
        // alone, which left scorecards written through this path unstamped.
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.updateInterview(req.params.id, {
            ...req.body,
            reviewerId,
        }, tenantId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const submitScorecard = async (req, res) => {
    try {
        const reviewerId = req.user?.employeeId ?? null;
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.submitScorecard({ ...req.body, interviewId: req.params.id, reviewerId, tenantId });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const getScorecards = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.getScorecards(req.params.id, tenantId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
