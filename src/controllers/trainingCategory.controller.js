import * as categoryService from "../services/trainingCategory.service.js";
import { respondServerError } from '../utils/httpError.js';

export const createCategory = async (req, res) => {
  try {
    const result = await categoryService.createCategory(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getAllCategories = async (req, res) => {
  try {
    const result = await categoryService.getAllCategories();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getCategoryById = async (req, res) => {
  try {
    const result = await categoryService.getCategoryById(req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};

export const updateCategory = async (req, res) => {
  try {
    const result = await categoryService.updateCategory(req.params.id, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    await categoryService.deleteCategory(req.params.id);
    res.status(204).json({success: true, message: "Deleted SuccessFully"});
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
