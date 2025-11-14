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
    const requestedBy = req.headers['employee-id'];
    const result = await createRequisition(req.body, requestedBy);
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
    const deletedBy = req.headers['employee-id'];
    const result = await deleteRequisitions(req.params.id,deletedBy);
    res.status(200).json({ success: true, message: "deleted SuccessFully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const approveRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const approvedBy = req.headers['employee-id'];
    const { status, comments } = req.body;
    const result = await approveRequisition(id, status, comments, approvedBy);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const postRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const createdBy = req.headers['employee-id'];
    const { externalUrl } = req.body;
    const result = await postRequisition(id, externalUrl, createdBy);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
