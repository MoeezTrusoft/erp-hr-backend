import *as positionService from "../services/position.service.js";

export const createPositionController = async (req, res) => {
  try {
    const createdBy = req.headers['employee-id'];
    const result = await positionService.createPosition(req.body, createdBy);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getPositionsController = async (req, res) => {
  try {
    const result = await positionService.getAllPositions();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getPositionByIdController = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await positionService.getPositionById(id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updatePositionController = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedBy = req.headers['employee-id'];
    const result = await positionService.updatePosition(id, req.body, updatedBy);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deletePositionController = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedBy = req.headers['employee-id'];
    const result = await positionService.deletePosition(id, deletedBy);
    res.status(200).json({ success: true, data: result, message: "Deleted successFully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
