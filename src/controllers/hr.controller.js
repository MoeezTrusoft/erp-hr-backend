import { uploadFileToDAM, damRequest } from "../services/dam.rbac.department.js";
import {
  createEmployeeService,
  getAllEmployeesService,
  getEmployeeByIdService,
  updateEmployeeService,
  deleteEmployeeService,
  createEmployeeMediaRecordService,
  getEmployeeMediaIdService,
} from "../services/hr.service.js";

// ======================== CREATE ========================
export const createEmployee = async (req, res) => {
  try {
    const createdBy = req.headers["user-id"];

    // for media upload in dam
    let mediaRecord = null;
    const mediaId = req.body.mediaId;

    if (mediaId) {
      mediaRecord = await damRequest(`assets/${mediaId}`, "GET");
    }


    else if (req.files && req.files.length > 0) {
      // Upload file to DAM
      mediaRecord = await uploadFileToDAM(req.files[0], "avatar");

      if (!mediaRecord) {
        return res.status(500).json({ success: false, message: "Failed to upload media" });
      }
    }

    const record =
      mediaRecord?.items?.[0] ||       // case: DAM returns items[]
      (Array.isArray(mediaRecord) ? mediaRecord[0] : mediaRecord);

    // Extract ID
    const finalMediaId = record?.id;

    // Extract URL
    const finalMediaUrl =
      record?.file_url ||
      record?.url ||
      record?.download_url ||
      record?.cdn_url ||
      null;


    const newEmployee = await createEmployeeService(req.body, finalMediaId, finalMediaUrl, createdBy);

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

//========================= Upload Documents =================

export const uploadEmployeeDocuments = async (req, res) => {
  const createdBy = req.headers["user-id"];

  try {
    const {
      employeeId,
      title,
      category,
      version,
      visibility = true,
      effective_date,
      expiry_date,
      notes,
      mediaId,
    } = req.body;

    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: "employeeId is required",
      });
    }

    let mediaRecord = null;

    // ✅ Case 1: Existing mediaId
    if (mediaId) {
      mediaRecord = await damRequest(`assets/${mediaId}`, "GET");
    }

    // ✅ Case 2: Upload new file
    else if (req.files && req.files.length > 0) {
      mediaRecord = await uploadFileToDAM(
        req.files[0],
        "employee-document",
        employeeId
      );

      if (!mediaRecord) {
        return res.status(500).json({
          success: false,
          message: "Failed to upload document",
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "No mediaId or file provided",
      });
    }

    // ✅ Normalize DAM response
    const record =
      mediaRecord?.items?.[0] ||
      mediaRecord?.[0] ||
      mediaRecord ||
      null;

    if (!record?.id) {
      return res.status(500).json({
        success: false,
        message: "Invalid DAM response",
      });
    }
    

    const finalMediaId = record.id;

    // ✅ Save into EmployeeMedia table
    const savedMedia = await createEmployeeMediaRecordService({
      title: title || record?.title || null,
      category,
      version,
      visibility,
      effective_date,
      expiry_date,
      notes,
      employeeId,
      mediaId: finalMediaId,
    });

    return res.status(201).json({
      success: true,
      message: "Employee document uploaded successfully",
      data: savedMedia,
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
    // Fetch user mediaId from database
    const employee_id = await getEmployeeMediaIdService(req.params.id);
    if (!employee_id) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }


    const employeeMediaId = employee_id.employee_media_id;

    let mediaRecord = null;
    if (employeeMediaId) {
      mediaRecord = await damRequest(`assets/${employeeMediaId}`, "GET");
      if (!mediaRecord) {
        return res.status(404).json({ success: false, message: "Media Record not found" });
      }
    }

    // const user = await damRequest(`/user/by-employee/${req.params.id}`, "GET");
    // if (!user) {
    //   return res.status(404).json({ success: false, message: "User not found in RBAC" });
    // }

    // // You can now access user.Department, user.mediaId
    // const dept = user.Department;

    const employee = await getEmployeeByIdService(req.params.id);

    return res.status(200).json({ success: true, data: employee, mediaRecord });
    // return res.status(200).json({ success: true, data: employee, user,mediaRecord });
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
