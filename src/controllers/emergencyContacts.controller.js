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

        const createdBy = req.headers["user-id"];
        console.log("user",createdBy);
        
    const { Contact_name, relationship, phone, email, is_primary, employee_Id } = req.body;

    const createData = {
      Contact_name,
      relationship,
      phone: phone ? phone : null,
      email,
      is_primary: is_primary === "true" || is_primary === true,
      employee_Id
    };

    const result = await createEmergencyContact(createData, createdBy);

    res.status(201).json({ success: true,  message: "Emergency Contact Created successfully",data: result });
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

    const result = await updateEmergencyContact(id, updateData,updatedBy);

    res.status(200).json({ success: true,message: "Emergency Contact Updated successfully", data: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ------------------------- DELETE -------------------------
export const remove = async (req, res) => {
  try {
    const deletedBy = req.headers["user-id"];
    const { id } = req.params;

    const result = await deleteEmergencyContact(id,deletedBy);

    res.status(200).json({ success: true, message: "Deleted successfully", data: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
