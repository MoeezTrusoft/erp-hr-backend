import * as svc from "../services/onboarding.service.js";
import { respondServerError } from '../utils/httpError.js';
import { hasPermission } from "../lib/assertPermission.js";

// F-37 — onboarding WRITES run under the VERIFIED tenant (req.user.tenantId, set
// from the signed service-JWT claim — never a header), like the recruitment
// controllers. The acting employee rides along as the outbox event's actor.
const tenantOf = (req) => req.user?.tenantId ?? null;
const actorCtx = (req) => ({ actorId: req.user?.employeeId ?? null });
const tenantRequired = (res) => res.status(400).json({ success: false, message: "Tenant context is required" });
const writeError = (res, e) => res.status(e.status || 400).json({ success: false, message: e.message, code: e.code });
// Recruitment Phase 6 — checklist reads carry the hire's home address only for
// a caller who may read employee records (the verified permission set, never a
// client flag); everyone else gets the work location alone.
const readOptions = (req) => ({ includeHomeAddress: hasPermission(req.user?.permissions, "hr:employee", "VIEW") });

// ── Checklists ──────────────────────────────────────────────────────────────

export const createChecklist = async (req, res) => {
    try {
        const tenantId = tenantOf(req);
        if (!tenantId) return tenantRequired(res);
        const result = await svc.createChecklist({ ...req.body, tenantId }, actorCtx(req));
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) {
        writeError(res, e);
    }
};

export const listChecklists = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listChecklists({ page: Number(page) || 1, limit: Number(limit) || 20, ...readOptions(req) });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        respondServerError(req, res, e);
    }
};

export const getChecklist = async (req, res) => {
    try {
        const result = await svc.getChecklist(req.params.id, undefined, readOptions(req));
        if (!result) return res.status(404).json({ success: false, message: "Not found" });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const getChecklistByEmployee = async (req, res) => {
    try {
        const result = await svc.getChecklistByEmployee(req.params.employeeId, undefined, readOptions(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const updateChecklist = async (req, res) => {
    try {
        const tenantId = tenantOf(req);
        if (!tenantId) return tenantRequired(res);
        const result = await svc.updateChecklist(req.params.id, req.body, tenantId, actorCtx(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        writeError(res, e);
    }
};

// ── Tasks ────────────────────────────────────────────────────────────────────

export const addTask = async (req, res) => {
    try {
        const tenantId = tenantOf(req);
        if (!tenantId) return tenantRequired(res);
        const result = await svc.addTask({ ...req.body, checklistId: req.params.id, tenantId }, actorCtx(req));
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) {
        writeError(res, e);
    }
};

export const updateTask = async (req, res) => {
    try {
        const tenantId = tenantOf(req);
        if (!tenantId) return tenantRequired(res);
        const result = await svc.updateTask(req.params.taskId, req.body, tenantId, actorCtx(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        writeError(res, e);
    }
};

export const deleteTask = async (req, res) => {
    try {
        const tenantId = tenantOf(req);
        if (!tenantId) return tenantRequired(res);
        await svc.deleteTask(req.params.taskId, tenantId, actorCtx(req));
        res.status(204).end();
    } catch (e) {
        writeError(res, e);
    }
};

// ── Documents ────────────────────────────────────────────────────────────────

export const uploadDocument = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }
        const { title } = req.body;
        const result = await svc.uploadDocument({
            checklistId: req.params.id,
            title: title || req.files[0].originalname,
            file: req.files[0],
        });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const listDocuments = async (req, res) => {
    try {
        const result = await svc.listDocuments(req.params.id);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const signDocument = async (req, res) => {
    try {
        const result = await svc.signDocument(req.params.docId, { signedBy: req.body?.signedBy });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

// ── Buddy ────────────────────────────────────────────────────────────────────

export const assignBuddy = async (req, res) => {
    try {
        const tenantId = tenantOf(req);
        if (!tenantId) return tenantRequired(res);
        const result = await svc.assignBuddy({ checklistId: req.params.id, buddyId: req.body.buddyId, tenantId }, actorCtx(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        writeError(res, e);
    }
};

export const getBuddy = async (req, res) => {
    try {
        const result = await svc.getBuddy(req.params.id);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

// ── Surveys ──────────────────────────────────────────────────────────────────

export const submitSurvey = async (req, res) => {
    try {
        const tenantId = tenantOf(req);
        if (!tenantId) return tenantRequired(res);
        const result = await svc.submitSurvey({ ...req.body, tenantId }, actorCtx(req));
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) {
        writeError(res, e);
    }
};

export const getSurveys = async (req, res) => {
    try {
        const result = await svc.getSurveys(req.params.employeeId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};
