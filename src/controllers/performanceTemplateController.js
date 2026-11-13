import * as templateService from "../services/performanceTemplateService.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped template service so tenant B cannot read/mutate tenant A's templates.
const tenantOf = (req) => req.user?.tenantId;

export const createTemplate = async (req, res) => {
  try {
         const createdBy = req.headers['employee-id'];

    const data = await templateService.createPerformanceTemplate({ ...req.body, tenantId: tenantOf(req) }, createdBy);
    res.status(201).json({
      success: true,
      message: "Performance template created successfully",
      data,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to create performance template",
    });
  }
};

export const getAllTemplates = async (req, res) => {
  try {
    const data = await templateService.getAllPerformanceTemplates(tenantOf(req));
    res.status(200).json({
      success: true,
      message: "Performance templates retrieved successfully",
      data,
    });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getTemplateById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await templateService.getPerformanceTemplateById(id, tenantOf(req));
    res.status(200).json({
      success: true,
      message: "Performance template retrieved successfully",
      data,
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      message: error.message || "Performance template not found",
    });
  }
};

export const updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
         const updatedBy = req.headers['employee-id'];

    const data = await templateService.updatePerformanceTemplate(id, req.body, updatedBy, tenantOf(req));
    res.status(200).json({
      success: true,
      message: "Performance template updated successfully",
      data,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to update performance template",
    });
  }
};

export const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
const deletedBy = req.headers['employee-id'];
    await templateService.deletePerformanceTemplate(id, deletedBy, tenantOf(req));
    res.status(200).json({
      success: true,
      message: "Performance template deleted successfully",
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to delete performance template",
    });
  }
};
