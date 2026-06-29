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
  // 2️⃣ Upsert the dashboard layout, scoped to the tenant. findUnique-by-unique
  // can't carry tenantId, so look up + branch (create stamps the tenant).
  const existing = await prisma.dashboardLayout.findFirst({
    where: scopedWhere(tenantId, { dashboardType }),
  });

  const dashboard = existing
    ? await prisma.dashboardLayout.update({ where: { id: existing.id }, data: { layout } })
    : await prisma.dashboardLayout.create({ data: scopedData(tenantId, { employeeId: userId, dashboardType, layout }) });

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