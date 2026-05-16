import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";

const prisma = new PrismaClient();

// ✅ Create Employee
// export const createEmployeeService = async (data, createdBy) => {

//   // ------------ REQUIRED FIELDS (your demand) -----------------
//   const requiredFields = ["job_title", "hire_date", "status", "positionId"];

//   for (const field of requiredFields) {
//     if (!data[field]) {
//       throw new Error(`${field} is a required field`);
//     }
//   }

//   // ------------ Validate Position ----------------------------
//   const positionExists = await prisma.position.findUnique({
//     where: { id: Number(data.positionId) },
//   });

//   if (!positionExists) {
//     throw new Error(`Position ID ${data.positionId} does not exist`);
//   }

//   // ------------ Convert incoming data properly ----------------
//   const parsedData = {
//     tenant_id: data.tenant_id ? Number(data.tenant_id) : null,
//     first_name: data.first_name || null,
//     middle_name: data.middle_name || null,
//     last_name: data.last_name || null,
//     preferred_name: data.preferred_name || null,
//     nationality_id_type: data.nationality_id_type || null,
//     employee_code: data.employee_code || null,
//     date_of_birth: data.date_of_birth ? new Date(data.date_of_birth) : null,
//     joining_date: data.joining_date ? new Date(data.joining_date) : null,
//     probation_end_date: data.probation_end_date ? new Date(data.probation_end_date) : null,
//     employee_type: data.employee_type || null,
//     remarks: data.remarks || null,
//     marital_status: data.marital_status || null,
//     nationality_id: data.nationality_id ? Number(data.nationality_id) : null,
//     current_address: data.current_address || null,
//     permenant_address: data.permenant_address || null,
//     city: data.city || null,
//     state: data.state || null,
//     province: data.province || null,
//     country: data.country || null,
//     postal_code: data.postal_code || null,
//     personal_contact: data.personal_contact ? Number(data.personal_contact) : null,
//     email: data.email || null,
//     work_email: data.work_email || null,
//     work_phone: data.work_phone ? Number(data.work_phone) : null,
//     employement_status: data.employement_status || null,
//     photo_url: data.photo_url || null,

//     gender: data.gender || null,
//     job_title: data.job_title,
//     hire_date: new Date(data.hire_date),
//     status: data.status,
//     userId: data.userId ? Number(data.userId) : null,

//     positionId: Number(data.positionId),
//     regionId: data.regionId ? Number(data.regionId) : null,

//     additional_fields: data.additional_fields || null,

//     createdById: Number(createdBy) || null
//   };

//   // ------------ Create Employee -------------------------------
//   const employee = await prisma.employee.create({
//     data: parsedData
//   });

//   // ------------ Log -------------------------------------------
//   await logAction({
//     employeeId: Number(createdBy),
//     type: "CREATE",
//     module: "Employee",
//     result: "SUCCESS",
//     notes: `Employee ${employee.id} created successfully`,
//   });

//   return employee;
// };

function calculateTenure(hireDate) {
  const now = new Date();
  const start = new Date(hireDate);

  let months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());

  if (now.getDate() < start.getDate()) {
    months -= 1;
  }

  if (months < 0) months = 0;

  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;

  return {
    months: `${years} Y, ${remainingMonths} M`,   // <-- converted to STRING
    years: `${years}`,                                         // <-- converted to STRING
    label: `${years} year(s) ${remainingMonths} month(s)`
  };
}

export const createEmployeeService = async (data, finalMediaId, finalMediaUrl,createdBy) => {
  console.log("fsfsfsfsf",finalMediaUrl,finalMediaId);
  
  // ------------ REQUIRED FIELDS -----------------
  const requiredFields = ["job_title", "hire_date", "status", "positionId"];

  for (const field of requiredFields) {
    if (!data[field]) {
      throw new Error(`${field} is a required field`);
    } 
  }

  // ------------ Validate Position ----------------------------
  const positionExists = await prisma.position.findUnique({
    where: { id: Number(data.positionId) },
  });

  if (!positionExists) {
    throw new Error(`Position ID ${data.positionId} does not exist`);
  }

  // ------------ Validate Manager (optional) -------------------
  if (data.managerId) {
    const manager = await prisma.employee.findUnique({
      where: { id: Number(data.managerId) },
    });
    if (!manager) throw new Error(`Manager ID ${data.managerId} does not exist`);
  }

  // ------------ Validate Report-To (optional) -----------------
  if (data.reportToId) {
    const reportTo = await prisma.employee.findUnique({
      where: { id: Number(data.reportToId) },
    });
    if (!reportTo) throw new Error(`Report-To ID ${data.reportToId} does not exist`);
  }

  // ------------ Validate Business Unit (optional) -------------
  if (data.businessUnitId) {
    const bu = await prisma.businessUnit.findUnique({
      where: { id: Number(data.businessUnitId) },
    });
    if (!bu) throw new Error(`BusinessUnit ID ${data.businessUnitId} does not exist`);
  }

  // ------------ Validate Grade Level (optional) ---------------
  if (data.gradeLevelId) {
    const grade = await prisma.gradeLevel.findUnique({
      where: { id: Number(data.gradeLevelId) },
    });
    if (!grade) throw new Error(`GradeLevel ID ${data.gradeLevelId} does not exist`);
  }

  // ------------ Validate Region (optional) --------------------
  if (data.regionId) {
    const region = await prisma.region.findUnique({
      where: { id: Number(data.regionId) },
    });
    if (!region) throw new Error(`Region ID ${data.regionId} does not exist`);
  }
  // ------------ EMAIL VALIDATION ---------------------------
  if (data.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      throw new Error("Invalid personal email format");
    }
  }

  if (data.work_email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.work_email)) {
      throw new Error("Invalid work email format");
    }
  }

  // ------------ CNIC VALIDATION ---------------------------

  const validateCNIC = (cnic) => {
    const regex = /^(\d{5}-\d{7}-\d{1}|\d{13})$/;
    return regex.test(cnic);
  };

  if (data.nationality_id_no) {
    if (!validateCNIC(data.nationality_id.toString())) {
      throw new Error("Invalid CNIC format. Expected 13 digits or 5-7-1 format.");
    }
  }

  const hireDate = new Date(data.hire_date);
  const tenure = calculateTenure(hireDate);
  // ------------ Parse Incoming Data Properly --------------------
  const parsedData = {
    tenant_id: data.tenant_id ? Number(data.tenant_id) : null,
    employee_media_id: finalMediaId,
    first_name: data.first_name || null,
    middle_name: data.middle_name || null,
    last_name: data.last_name || null,
    preferred_name: data.preferred_name || null,
    nationality_id_type: data.nationality_id_type || null,
    employee_code: data.employee_code || null,

    date_of_birth: data.date_of_birth ? new Date(data.date_of_birth) : null,
    joining_date: data.joining_date ? new Date(data.joining_date) : null,
    probation_end_date: data.probation_end_date ? new Date(data.probation_end_date) : null,

    employee_type: data.employee_type || null,
    remarks: data.remarks || null,
    marital_status: data.marital_status || null,
    nationality_id: data.nationality_id ? Number(data.nationality_id) : null,
    nationality_id_no: data.nationality_id_no,

    current_address: data.current_address || null,
    permenant_address: data.permenant_address || null,
    city: data.city || null,
    state: data.state || null,
    province: data.province || null,
    country: data.country || null,
    postal_code: data.postal_code || null,

    personal_contact: data.personal_contact ? Number(data.personal_contact) : null,
    email: data.email || null,
    work_email: data.work_email || null,
    work_phone: data.work_phone ? Number(data.work_phone) : null,
    employement_status: data.employement_status || null,
    photo_url: finalMediaUrl || null,

    gender: data.gender || null,
    job_title: data.job_title,
    hire_date: new Date(data.hire_date),
    status: data.status,

    userId: data.userId ? Number(data.userId) : null,
    positionId: Number(data.positionId),

    // NEW FIELDS
    businessUnitId: data.businessUnitId ? Number(data.businessUnitId) : null,
    gradeLevelId: data.gradeLevelId ? Number(data.gradeLevelId) : null,
    managerId: data.managerId ? Number(data.managerId) : null,
    reportToId: data.reportToId ? Number(data.reportToId) : null,
    fte: data.fte ? Number(data.fte) : null,
    // Tenure saved here
    tenureMonths: tenure.months,
    // Leave Management
    regionId: data.regionId ? Number(data.regionId) : null,

    additional_fields: data.additional_fields || null,

    createdById: Number(createdBy) || null,
  };

  // ------------ Create Employee -------------------------------
  const employee = await prisma.employee.create({
    data: parsedData,
  });

  // ------------ Log Action -------------------------------------
  await logAction({
    employeeId: Number(createdBy),
    type: "CREATE",
    module: "Employee",
    result: "SUCCESS",
    notes: `Employee ${employee.id} created successfully`,
  });

  return employee;
};



// ✅ Get All Employees
export const getAllEmployeesService = async () => {
  return prisma.employee.findMany({
    orderBy: { created_at: "desc" },
    include: {
      Position: true,
      emergencyContact: true,
      attendance: { orderBy: { date: "desc" } },
      leaves: { orderBy: { start_date: "desc" } },
    },
  });
};
// ✅ Get Employee By ID
export const getEmployeeByIdService = async (id) => {
  const employee = await prisma.employee.findUnique({
    where: { id: Number(id) },
    include: {
      Position: true,
      businessUnit: true,
      gradeLevel: true,
      region: true,
      manager: {
        select: { id: true, employee_name: true, job_title: true, email: true }
      },
      reportTo: {
        select: { id: true, employee_name: true, job_title: true, email: true }
      },
      teamMembers: { select: { id: true, employee_name: true, job_title: true } },
      reports: { select: { id: true, employee_name: true, job_title: true } },
      emergencyContact: true,
      attendance: { orderBy: { date: 'desc' }, take: 30 },
      leaves: { orderBy: { start_date: 'desc' } },
      leaveRequests: true,
      approvedLeaveRequests: true,
      leaveBalances: true,
      leavePoliciesCreated: true,
      leavePoliciesUpdated: true,
      leaveRequestsCreated: true,
      leaveRequestsUpdated: true,
      approvalWorkflowsCreated: true,
      approvalWorkflowsUpdated: true,
      holidayCalendarsCreated: true,
      holidayCalendarsUpdated: true,
      holidaysCreated: true,
      holidaysUpdated: true,
      leaveBalancesUpdated: true,
      leaveRequestApprovals: true,
      employeeHolidayCalendars: true,
      reviewsReceived: {
        include: {
          reviewer: { select: { id: true, employee_name: true, job_title: true } },
          feedbacks: {
            include: { reviewer: { select: { id: true, employee_name: true } } }
          }
        }
      },
      reviewsGiven: true,
      feedbackGiven: true,
      feedBackBy: true,
      ReviewReminder: true,
      calibratedBy: true,
      goalCreatedBy: true,
      approvedBy: true,
      goalProgress: true,
      TrainingEnrollment: {
        include: {
          course: true,
          employee: true
        }
      },
      requisitionsRequested: true,
      requisitionsApproved: true,
      approvals: true,
      JobRequisition: true,
      payrollPayslips: true,
      employmentTerms: true,
      payrollAssignments: {
        include: { earningType: true, deductionType: true }
      },
      bankDetails: true,
      PayrollAuditLog: true,
      TimeEntry: true,
      Timesheet: true,
      TimeApproval: true,
      WorkSchedule: true,
      actionBy: true,
      logs: { orderBy: { created_at: 'desc' }, take: 50 },
      regionsCreated: true,
      regionsUpdated: true
    }
  });

  if (!employee) throw new Error('Employee not found');

  return employee;
};

export const getEmployeeMediaIdService = async (id) => {
  const employee = await prisma.employee.findUnique({
    where: { id: Number(id) },
    select: { employee_media_id: true },
  });
  return employee;
};

export const createEmployeeMediaRecordService = async ({
  title,
  category,
  version,
  visibility = true,
  effective_date,
  expiry_date,
  notes,
  employeeId,
  mediaId,
}) => {
  return prisma.employeeMedia.create({
    data: {
      title: title || null,
      category: category || null,
      version: version || null,
      visibility,
      effective_date: effective_date || null,
      expiry_date: expiry_date || null,
      notes: notes || null,
      employee_id: Number(employeeId),
      media_id: Number(mediaId),
    },
    include: {
      employee: true,
    },
  });
};




// ✅ Update Employee
export const updateEmployeeService = async (id, data, updatedBy) => {
  const exists = await prisma.employee.findUnique({
    where: { id: Number(id) },
  });

  if (!exists) throw new Error("Employee not found");

  if (data.positionId) {
    const pos = await prisma.position.findUnique({
      where: { id: Number(data.positionId) },
    });
    if (!pos) throw new Error(`Position ID ${data.positionId} does not exist`);
  }

  const updated = await prisma.employee.update({
    where: { id: Number(id) },
    data: {
      ...data,
      hire_date: data.hire_date ? new Date(data.hire_date) : exists.hire_date,
      updatedById: Number(updatedBy),
      positionId: data.positionId ? Number(data.positionId) : exists.positionId,
    },
  });

  await logAction({
    employeeId: Number(updatedBy),
    type: "UPDATE",
    module: "Employee",
    result: "SUCCESS",
    notes: `Employee ${id} updated successfully`,
  });

  return updated;
};

// ✅ Delete Employee
export const deleteEmployeeService = async (id, deletedBy) => {
  const exists = await prisma.employee.findUnique({
    where: { id: Number(id) },
  });

  if (!exists) throw new Error("Employee not found");

  // Clean dependent data
  await prisma.attendance.deleteMany({ where: { employeeId: Number(id) } });
  await prisma.leave.deleteMany({ where: { employeeId: Number(id) } });

  await prisma.employee.delete({ where: { id: Number(id) } });

  await logAction({
    employeeId: Number(deletedBy),
    type: "DELETE",
    module: "Employee",
    result: "SUCCESS",
    notes: `Employee ${id} deleted successfully`,
  });

  return { message: "Employee deleted successfully" };
};
