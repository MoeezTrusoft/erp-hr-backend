import {
  createEmergencyContact,
  getAllEmergencyContacts,
  getEmergencyContactById,
  updateEmergencyContact,
  deleteEmergencyContact
} from "../services/emergencyContacts.service.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped emergency-contact service so tenant B cannot read/mutate tenant A's
// emergency contacts.
const tenantOf = (req) => req.user?.tenantId;

// ------------------------- CREATE -------------------------
export const create = async (req, res) => {
  try {

        const createdBy = req.headers["user-id"];

    const { Contact_name, relationship, phone, email, is_primary, employee_Id } = req.body;

    const createData = {
      Contact_name,
      relationship,
      phone: phone ? phone : null,
      email,
      is_primary: is_primary === "true" || is_primary === true,
      employee_Id,
      tenantId: tenantOf(req)
    };

    const result = await createEmergencyContact(createData, createdBy);

    res.status(201).json({ success: true,  message: "Emergency Contact Created successfully",data: result });
  } catch (err) {
    respondServerError(req, res, err);
  }
};

// ------------------------- GET ALL -------------------------
export const getAll = async (req, res) => {
  try {
    const result = await getAllEmergencyContacts(tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    respondServerError(req, res, err);
  }
};

// ------------------------- GET BY ID -------------------------
export const getById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await getEmergencyContactById(id, tenantOf(req));
    if (!result) return res.status(404).json({ message: "Emergency contact not found" });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    respondServerError(req, res, err);
  }
};

// ------------------------- UPDATE -------------------------
export const update = async (req, res) => {
  try {
    const updatedBy = req.headers["user-id"];
    const { id } = req.params;

    const { Contact_name, relationship, phone, email, is_primary } = req.body;

    const updateData = {
      Contact_name,
      relationship,
      phone: phone ? phone : undefined,
      email,
      is_primary: is_primary === "true" || is_primary === true,
    };

    const result = await updateEmergencyContact(id, updateData, updatedBy, tenantOf(req));

    res.status(200).json({ success: true,message: "Emergency Contact Updated successfully", data: result });
  } catch (err) {
    respondServerError(req, res, err);
  }
};

// ------------------------- DELETE -------------------------
export const remove = async (req, res) => {
  try {
    const deletedBy = req.headers["user-id"];
    const { id } = req.params;

    const result = await deleteEmergencyContact(id, deletedBy, tenantOf(req));

    res.status(200).json({ success: true, message: "Deleted successfully", data: result });
  } catch (err) {
    respondServerError(req, res, err);
  }
};
