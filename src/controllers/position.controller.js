import *as positionService from "../services/position.service.js";

export const createPositionController = async (req, res) => {
  try {
    const result = await positionService.createPosition(req.body);
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
    const result = await positionService.updatePosition(id, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deletePositionController = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await positionService.deletePosition(id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
