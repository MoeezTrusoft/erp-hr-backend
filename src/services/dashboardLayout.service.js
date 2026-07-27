import prisma from "../config/prisma.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via a trailing `tenantId`;
// the dashboard layout is read/created within the tenant fail-closed so a tenant
// never overwrites or reads another tenant's saved layout. The parent Employee
// is checked via its snake_case `tenant_id` column (REQ-007).

export const saveDashboardLayout = async (employeeId, dashboardType, layout, tenantId) => {
      const userId = Number(employeeId);

       const employeeExists = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { createdById: userId }),
  });

  if (!employeeExists) {
    throw new Error(`Employee with id ${userId} does not exist`);
  }
  // F-DB-03: the natural key is tenant + employee + dashboard type. The
  // database-backed upsert removes the old read/branch race and never lets one
  // employee overwrite another employee's layout in the same tenant.
  return prisma.dashboardLayout.upsert({
    where: {
      tenantId_employeeId_dashboardType: {
        tenantId,
        employeeId: userId,
        dashboardType,
      },
    },
    update: { layout },
    create: scopedData(tenantId, { employeeId: userId, dashboardType, layout }),
  });

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
