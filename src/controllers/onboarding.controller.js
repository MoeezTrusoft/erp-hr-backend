import * as svc from "../services/onboarding.service.js";
import { respondServerError } from "../utils/httpError.js";

// ── Checklists ──────────────────────────────────────────────────────────────

export const createChecklist = async (req, res) => {
  try {
    const result = await svc.createChecklist({
      ...req.body,
      tenantId: req.user?.tenantId,
    });
    res.status(201).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const listChecklists = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const result = await svc.listChecklists({
      page: Number(page) || 1,
      limit: Number(limit) || 20,
      tenantId: req.user?.tenantId,
    });
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const getChecklist = async (req, res) => {
  try {
    const result = await svc.getChecklist(req.params.id, req.user?.tenantId);
    if (!result)
      return res.status(404).json({ success: false, message: "Not found" });
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const getChecklistByEmployee = async (req, res) => {
  try {
    const result = await svc.getChecklistByEmployee(
      req.params.employeeId,
      req.user?.tenantId,
    );
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const updateChecklist = async (req, res) => {
  try {
    const result = await svc.updateChecklist(
      req.params.id,
      req.body,
      req.user?.tenantId,
    );
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

// ── Tasks ────────────────────────────────────────────────────────────────────

export const addTask = async (req, res) => {
  try {
    const result = await svc.addTask({
      ...req.body,
      checklistId: req.params.id,
      tenantId: req.user?.tenantId,
    });
    res.status(201).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const updateTask = async (req, res) => {
  try {
    const result = await svc.updateTask(
      req.params.taskId,
      req.body,
      req.user?.tenantId,
    );
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const deleteTask = async (req, res) => {
  try {
    await svc.deleteTask(req.params.taskId, req.user?.tenantId);
    res.status(204).end();
  } catch (e) {
    respondServerError(req, res, e);
  }
};

// ── Documents ────────────────────────────────────────────────────────────────

export const uploadDocument = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    }
    const { title } = req.body;
    const result = await svc.uploadDocument({
      checklistId: req.params.id,
      title: title || req.files[0].originalname,
      file: req.files[0],
      tenantId: req.user?.tenantId,
    });
    res.status(201).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const listDocuments = async (req, res) => {
  try {
    const result = await svc.listDocuments(req.params.id, req.user?.tenantId);
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const signDocument = async (req, res) => {
  try {
    const result = await svc.signDocument(req.params.docId, {
      tenantId: req.user?.tenantId,
    });
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

// ── Buddy ────────────────────────────────────────────────────────────────────

export const assignBuddy = async (req, res) => {
  try {
    const result = await svc.assignBuddy({
      checklistId: req.params.id,
      buddyId: req.body.buddyId,
      tenantId: req.user?.tenantId,
    });
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const getBuddy = async (req, res) => {
  try {
    const result = await svc.getBuddy(req.params.id, req.user?.tenantId);
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

// ── Surveys ──────────────────────────────────────────────────────────────────

export const submitSurvey = async (req, res) => {
  try {
    const result = await svc.submitSurvey({
      ...req.body,
      tenantId: req.user?.tenantId,
    });
    res.status(201).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};

export const getSurveys = async (req, res) => {
  try {
    const result = await svc.getSurveys(
      req.params.employeeId,
      req.user?.tenantId,
    );
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (e) {
    respondServerError(req, res, e);
  }
};
