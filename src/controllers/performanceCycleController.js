import * as service from "../services/performanceCycleService.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped cycle service so tenant B cannot read/mutate tenant A's cycles.
const tenantOf = (req) => req.user?.tenantId;

export const createCycle = async (req, res) => {
  try {
         const createdBy = req.headers['employee-id'];

    const data = await service.createPerformanceCycle({ ...req.body, tenantId: tenantOf(req) }, createdBy);
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
    const data = await service.getAllPerformanceCycles(tenantOf(req));
    res.status(200).json({
      success: true,
      message: "Performance cycles retrieved successfully",
      data,
    });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getCycleById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await service.getPerformanceCycleById(id, tenantOf(req));
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
         const updatedBy = req.headers['employee-id'];

    const data = await service.updatePerformanceCycle(id, req.body, updatedBy, tenantOf(req));
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
    const deletedBy = req.headers['employee-id'];
    await service.deletePerformanceCycle(id, deletedBy, tenantOf(req));
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
