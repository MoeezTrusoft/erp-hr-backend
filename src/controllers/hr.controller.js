import {
  createEmployeeService,
  getAllEmployeesService,
  getEmployeeByIdService,
  updateEmployeeService,
  deleteEmployeeService,
} from "../services/hr.service.js";

// ✅ Create
export const createEmployee = async (req, res) => {
  try {
    const createdBy = req.headers['employee-id'];
    console.log("employee", createdBy);

    const newEmployee = await createEmployeeService(req.body, createdBy);
    res.status(201).json({ success: true, data: newEmployee });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ✅ Get All
export const getAllEmployees = async (req, res) => {
  try {
    const employees = await getAllEmployeesService();
    res.status(200).json({ success: true, data: employees });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ Get By ID
export const getEmployeeById = async (req, res) => {
  try {
    const employee = await getEmployeeByIdService(req.params.id);
    res.status(200).json({ success: true, data: employee });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};

// ✅ Update
export const updateEmployee = async (req, res) => {
  try {
    const updatedBy = req.headers['employee-id'];
    const updated = await updateEmployeeService(req.params.id, req.body, updatedBy);
    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ✅ Delete
export const deleteEmployee = async (req, res) => {
  try {
    const deletedBy = req.headers['employee-id'];

    const result = await deleteEmployeeService(req.params.id, deletedBy);
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};
