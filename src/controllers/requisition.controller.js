import {
  createRequisition,
  getAllRequisitions,
  approveRequisition,
  postRequisition,
  deleteRequisitions,
  getByIdRequisitions,
} from "../services/requisition.service.js";

export const createRequisitionController = async (req, res) => {
  try {
    const result = await createRequisition(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getRequisitionsController = async (req, res) => {
  try {
    const result = await getAllRequisitions();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getByIdRequisitionsController = async (req, res) => {
  try {
    const result = await getByIdRequisitions(req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deletRequisitionsController = async (req, res) => {
  try {
    const result = await deleteRequisitions(req.params.id);
    res.status(200).json({ success: true, message: "deleted SuccessFully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const approveRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const { approverId, status, comments } = req.body;
    const result = await approveRequisition(id, approverId, status, comments);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const postRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const { externalUrl } = req.body;
    const result = await postRequisition(id, externalUrl);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
