import {
  createEmployeeService,
  getAllEmployeesService,
  getEmployeeByIdService,
  updateEmployeeService,
  deleteEmployeeService,
} from "../services/hr.service.js";

// ======================== CREATE ========================
export const createEmployee = async (req, res) => {
  try {
    const createdBy = req.headers["user-id"];

    const newEmployee = await createEmployeeService(req.body, createdBy);

    return res.status(201).json({
      success: true,
      data: newEmployee,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ======================== GET ALL ========================
export const getAllEmployees = async (req, res) => {
  try {
    const employees = await getAllEmployeesService();
    return res.status(200).json({ success: true, data: employees });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ======================== GET BY ID ========================
export const getEmployeeById = async (req, res) => {
  try {
    const employee = await getEmployeeByIdService(req.params.id);
    return res.status(200).json({ success: true, data: employee });
  } catch (error) {
    return res.status(404).json({ success: false, message: error.message });
  }
};

// ======================== UPDATE ========================
export const updateEmployee = async (req, res) => {
  try {
    const updatedBy = req.headers["employee-id"];
    const updatedEmployee = await updateEmployeeService(
      req.params.id,
      req.body,
      updatedBy
    );

    return res.status(200).json({ success: true, data: updatedEmployee });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ======================== DELETE ========================
export const deleteEmployee = async (req, res) => {
  try {
    const deletedBy = req.headers["employee-id"];
    const result = await deleteEmployeeService(req.params.id, deletedBy);

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    return res.status(404).json({ success: false, message: error.message });
  }
};
