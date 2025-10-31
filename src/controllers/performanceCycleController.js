import * as service from "../services/performanceCycleService.js";

export const createCycle = async (req, res) => {
  try {
    const data = await service.createPerformanceCycle(req.body);
    res.status(201).json({
      success: true,
      message: "Performance cycle created successfully",
      data,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to create performance cycle",
    });
  }
};

export const getAllCycles = async (req, res) => {
  try {
    const data = await service.getAllPerformanceCycles();
    res.status(200).json({
      success: true,
      message: "Performance cycles retrieved successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch performance cycles",
    });
  }
};

export const getCycleById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await service.getPerformanceCycleById(id);
    res.status(200).json({
      success: true,
      message: "Performance cycle retrieved successfully",
      data,
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      message: error.message || "Performance cycle not found",
    });
  }
};

export const updateCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await service.updatePerformanceCycle(id, req.body);
    res.status(200).json({
      success: true,
      message: "Performance cycle updated successfully",
      data,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to update performance cycle",
    });
  }
};

export const deleteCycle = async (req, res) => {
  try {
    const { id } = req.params;
    await service.deletePerformanceCycle(id);
    res.status(200).json({
      success: true,
      message: "Performance cycle deleted successfully",
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to delete performance cycle",
    });
  }
};
