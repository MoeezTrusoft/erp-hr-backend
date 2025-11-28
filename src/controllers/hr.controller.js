import prisma from "../config/prisma.js";
import { hrRequest } from "../services/dam.rbac.department.js";
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
  
  // for media upload in dam
    let mediaRecord = null;
        const mediaId = req.body.mediaId;

        if (mediaId) {
            const mediaRecord = await damRequest(`assets/${mediaId}`, "GET");
            console.log("media recordd", mediaRecord, mediaId);


        }


        else if (req.files && req.files.length > 0) {
            // Upload file to DAM
            mediaRecord = await uploadFileToDAM(req.files[0], "avatar");
            console.log(mediaRecord, "media record");

            if (!mediaRecord) {
                return res.status(500).json({ success: false, message: "Failed to upload media" });
            }
        }

        const finalMediaId =
            mediaRecord?.id ||
            (Array.isArray(mediaRecord) ? mediaRecord[0]?.id : undefined);

    const newEmployee = await createEmployeeService(req.body,finalMediaId, createdBy);

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

    console.log("employee", req.params.id);
    
 // Fetch user mediaId from database
        const employee_id = await prisma.employee.findUnique({
            where: { id: Number(req.params.id) },
            select: {
                employee_media_id: true,
            }, // Only select mediaId

        });
        if (!employee_id) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

    
       const employeeMediaId = employee_id.employee_media_id;
        console.log("user media id:", employeeMediaId);

        let mediaRecord = null;
        if (employeeMediaId) {
            mediaRecord = await damRequest(`assets/${employeeMediaId}`, "GET");
            if (!mediaRecord) {
                return res.status(404).json({ success: false, message: "Media Record not found" });
            }
            console.log("media record:", mediaRecord);
        }

const user = await hrRequest(`/user/by-employee/${req.params.id}`, "GET");
console.log("deapfa", user)
if (!user) {
  return res.status(404).json({ success: false, message: "User not found in RBAC" });
}

// You can now access user.Department, user.mediaId
const dept = user.Department;

    const employee = await getEmployeeByIdService(req.params.id);


    return res.status(200).json({ success: true, data: employee, user,mediaRecord });
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
