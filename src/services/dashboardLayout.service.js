import prisma from "../config/prisma.js";

export const saveDashboardLayout = async (employeeId, dashboardType, layout) => {
      const userId = Number(employeeId);

       const employeeExists = await prisma.employee.findFirst({
    where: { createdById: userId },
  });

  if (!employeeExists) {
    throw new Error(`Employee with id ${empId} does not exist`);
  }
  // 2️⃣ Upsert the dashboard layout
  const dashboard = await prisma.dashboardLayout.upsert({
    where: { dashboardType }, // works if your schema has @@unique([dashboardType])
    update: { layout },
    create: { employeeId: userId, dashboardType, layout },
  });

  return dashboard;

//   return await prisma.dashboardLayout.upsert({
//     where: {
//       employeeId_dashboardType: {
//        employeeId : empId,
//         dashboardType
//     }
//     },
//     update: {
//       layout
//     },
//     create: {
//       employeeId : empId,
//       dashboardType,
//       layout
//     }
//   });
};

// export const getDashboardLayout = async (userId, dashboardType) => {
//   return await prisma.dashboardLayout.findUnique({
//     where: {
//       userId_dashboardType: {
//         userId,
//         dashboardType
//       }
//     }
//   });
// };