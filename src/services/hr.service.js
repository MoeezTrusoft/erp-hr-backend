import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ✅ Create Employee
export const createEmployeeService = async (data) => {
  const { first_name, last_name, gender, job_title, hire_date, status, positionId } = data;
  console.log(data);

  if (!job_title || !hire_date || !status || !positionId) {
    throw new Error("job_title, hire_date, and status are required fields");
  }

  const employee = await prisma.employee.create({
    data: {
      first_name,
      last_name,
      gender,
      job_title,
      hire_date: new Date(hire_date),
      status,
      positionId,
    },
  });

  return employee;
};

// ✅ Get All Employees
export const getAllEmployeesService = async () => {
  const employees = await prisma.employee.findMany({
    orderBy: { created_at: "desc" },
    include: {
      Position:true,
      attendance: {
        orderBy: { date: "desc" },
      },
      leaves: {
        orderBy: { start_date: "desc" },
      },
    },
  });
  return employees;
};

// ✅ Get Employee By ID
export const getEmployeeByIdService = async (id) => {
  const employee = await prisma.employee.findUnique({
  where: { id: parseInt(id) },
  include: {
    Position: true,
    attendance: {
      orderBy: { date: "desc" },
    },
    leaves: {
      orderBy: { start_date: "desc" },
    },
    reviewsReceived: {
      include: {
        reviewer: true,
        feedbacks: {
          include: {
            reviewer: true,
          },
        },
      },
      orderBy: { updated_at: "desc" },
    },
  },
});
  if (!employee) throw new Error("Employee not found");
  return employee;
};

// ✅ Update Employee
export const updateEmployeeService = async (id, data) => {
  const employee = await prisma.employee.findUnique({
    where: { id: parseInt(id) },
  });
  if (!employee) throw new Error("Employee not found");

  const updatedEmployee = await prisma.employee.update({
    where: { id: parseInt(id) },
    data: {
      first_name: data.first_name ?? employee.first_name,
      last_name: data.last_name ?? employee.last_name,
      gender: data.gender ?? employee.gender,
      job_title: data.job_title ?? employee.job_title,
      hire_date: data.hire_date ? new Date(data.hire_date) : employee.hire_date,
      status: data.status ?? employee.status,
      userId: data.userId ?? employee.userId,
      positionId: data.positionId ?? employee.positionId
    },
  });

  return updatedEmployee;
};

// ✅ Delete Employee
export const deleteEmployeeService = async (id) => {
  const employee = await prisma.employee.findUnique({
    where: { id: parseInt(id) },
  });
  if (!employee) throw new Error("Employee not found");

  await prisma.attendance.deleteMany({
    where: { id },
  });

  await prisma.leave.deleteMany({
    where: { id },
  });


  await prisma.employee.delete({ where: { id: parseInt(id) } });
  return { message: "Employee deleted successfully" };
};
