import * as svc from "../services/onboarding.service.js";

// ── Checklists ──────────────────────────────────────────────────────────────

export const createChecklist = async (req, res) => {
    try {
        const createdById = req.headers["x-employee-id"] || null;
        const result = await svc.createChecklist({ ...req.body, createdById });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const listChecklists = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listChecklists({ page: Number(page) || 1, limit: Number(limit) || 20 });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};

export const getChecklist = async (req, res) => {
    try {
        const result = await svc.getChecklist(req.params.id);
        if (!result) return res.status(404).json({ success: false, message: "Not found" });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const getChecklistByEmployee = async (req, res) => {
    try {
        const result = await svc.getChecklistByEmployee(req.params.employeeId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const updateChecklist = async (req, res) => {
    try {
        const result = await svc.updateChecklist(req.params.id, req.body);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

// ── Tasks ────────────────────────────────────────────────────────────────────

export const addTask = async (req, res) => {
    try {
        const result = await svc.addTask({ ...req.body, checklistId: req.params.id });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const updateTask = async (req, res) => {
    try {
        const result = await svc.updateTask(req.params.taskId, req.body);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

export const deleteTask = async (req, res) => {
    try {
        await svc.deleteTask(req.params.taskId);
        res.status(204).end();
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
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
        const result = await svc.signDocument(req.params.docId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
};

// ── Buddy ────────────────────────────────────────────────────────────────────

export const assignBuddy = async (req, res) => {
    try {
        const result = await svc.assignBuddy({ checklistId: req.params.id, buddyId: req.body.buddyId });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
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
        const submittedById = req.headers["x-employee-id"] || null;
        const result = await svc.submitSurvey({ ...req.body, submittedById });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
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
