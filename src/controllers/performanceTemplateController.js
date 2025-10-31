import * as templateService from "../services/performanceTemplateService.js";

export const createTemplate = async (req, res) => {
  try {
    const data = await templateService.createPerformanceTemplate(req.body);
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
    const data = await templateService.getAllPerformanceTemplates();
    res.status(200).json({
      success: true,
      message: "Performance templates retrieved successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch performance templates",
    });
  }
};

export const getTemplateById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await templateService.getPerformanceTemplateById(id);
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
    const data = await templateService.updatePerformanceTemplate(id, req.body);
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
    await templateService.deletePerformanceTemplate(id);
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
