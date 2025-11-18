import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";

const prisma = new PrismaClient();

// ✅ Create Employee
export const createEmployeeService = async (data, createdBy) => {

  // ------------ REQUIRED FIELDS (your demand) -----------------
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

  // ------------ Convert incoming data properly ----------------
  const parsedData = {
    tenant_id: data.tenant_id ? Number(data.tenant_id) : null,
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
    photo_url: data.photo_url || null,

    gender: data.gender || null,
    job_title: data.job_title,
    hire_date: new Date(data.hire_date),
    status: data.status,
    userId: data.userId ? Number(data.userId) : null,

    positionId: Number(data.positionId),
    regionId: data.regionId ? Number(data.regionId) : null,

    additional_fields: data.additional_fields || null,

    createdById: Number(createdBy) || null
  };

  // ------------ Create Employee -------------------------------
  const employee = await prisma.employee.create({
    data: parsedData
  });

  // ------------ Log -------------------------------------------
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
      emergencyContact:true,
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
      emergencyContact: true,
      attendance: { orderBy: { date: "desc" } },
      leaves: { orderBy: { start_date: "desc" } },
      reviewsReceived: {
        include: {
          reviewer: true,
          feedbacks: { include: { reviewer: true } },
        },
      },
    },
  });

  if (!employee) throw new Error("Employee not found");

  return employee;
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
