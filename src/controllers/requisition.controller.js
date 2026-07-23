import {
  createRequisition,
  getAllRequisitions,
  approveRequisition,
  postRequisition,
  deleteRequisitions,
  getByIdRequisitions,
  updateRequisition,
} from "../services/requisition.service.js";

// Verified tenant from the service-JWT claim (mapped to req.user.tenantId by the
// gateway / MCP runner); `?? null` keeps it out of the scopedWhere fail-open
// (undefined) path so a missing tenant scopes to null rows, never all tenants.
const tenantOf = (req) => req.user?.tenantId ?? null;

export const createRequisitionController = async (req, res) => {
  try {
    // The tool schema exposes `requestedById` (the hiring manager, defaults to
    // the creator) — honor it first, then fall back to the acting employee id
    // (header) or a body-supplied employeeId. Previously requestedById was
    // silently ignored, so a caller without an employee-linked account (e.g. an
    // admin) hit "Hiring manager is required" despite supplying it.
    const requestedBy =
      req.body.requestedById ||
      req.headers['employee-id'] ||
      req.headers['x-employee-id'] ||
      req.body.employeeId;
    const result = await createRequisition(req.body, requestedBy, tenantOf(req));
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getRequisitionsController = async (req, res) => {
  try {
    const result = await getAllRequisitions(tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getByIdRequisitionsController = async (req, res) => {
  try {
    const result = await getByIdRequisitions(req.params.id, tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deletRequisitionsController = async (req, res) => {
  try {
    const deletedBy = req.headers['employee-id'];
    const result = await deleteRequisitions(req.params.id, deletedBy, tenantOf(req));
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
    const result = await approveRequisition(id, status, comments, approvedBy, tenantOf(req));
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
    const result = await postRequisition(id, externalUrl, createdBy, tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedBy = req.headers['employee-id'] || req.headers['x-employee-id'];
    const result = await updateRequisition(id, req.body, updatedBy, tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
