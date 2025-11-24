import {
  createEmergencyContact,
  getAllEmergencyContacts,
  getEmergencyContactById,
  updateEmergencyContact,
  deleteEmergencyContact
} from "../services/emergencyContacts.service.js";

// ------------------------- CREATE -------------------------
export const create = async (req, res) => {
  try {
    const { Contact_name, relationship, phone, email, is_primary, employee_Id } = req.body;

    // Validations
    if (!employee_Id) return res.status(400).json({ message: "employee_Id is required" });


    const createData = {
      Contact_name,
      relationship,
      phone: phone ? phone : null,
      email,
      is_primary: is_primary === "true" || is_primary === true,
      employee_Id
    };

    const result = await createEmergencyContact(createData, req.user?.id);

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ------------------------- GET ALL -------------------------
export const getAll = async (req, res) => {
  try {
    const result = await getAllEmergencyContacts();
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ------------------------- GET BY ID -------------------------
export const getById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await getEmergencyContactById(id);
    if (!result) return res.status(404).json({ message: "Emergency contact not found" });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ------------------------- UPDATE -------------------------
export const update = async (req, res) => {
  try {
    const { id } = req.params;

    const { Contact_name, relationship, phone, email, is_primary } = req.body;

    const updateData = {
      Contact_name,
      relationship,
      phone: phone ? phone : undefined,
      email,
      is_primary: is_primary === "true" || is_primary === true,
    };

    const result = await updateEmergencyContact(id, updateData);

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ------------------------- DELETE -------------------------
export const remove = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await deleteEmergencyContact(id);

    res.status(200).json({ success: true, message: "Deleted successfully", data: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
