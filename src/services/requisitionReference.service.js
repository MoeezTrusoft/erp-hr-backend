import prisma from "../lib/prisma.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";

const label = (e) =>
  e.employee_name ||
  [e.first_name, e.last_name].filter(Boolean).join(" ") ||
  e.employee_code;
const employeeSelect = {
  id: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  employee_code: true,
};
// Minimal, paginated reference choices; this surface never returns employee PII or salary amounts.
export async function listRequisitionReferences({
  tenantId,
  kind,
  q = "",
  page = 1,
  pageSize = 20,
  selectedId,
}) {
  const { who, scope } = await requireRecruitmentActor({ tenantId });
  const models = {
    EMPLOYEE: "employee",
    POSITION: "position",
    GRADE: "gradeLevel",
  };
  const model = models[kind];
  if (!model)
    throw Object.assign(new Error("Unknown requisition reference kind"), {
      status: 422,
      code: "HR-5906",
    });
  const employee = kind === "EMPLOYEE";
  const where = employee
    ? {
        tenant_id: tenantId,
        ...(scope.level === "MANAGED"
          ? { OR: [{ id: who.id }, { managerId: who.id }] }
          : {}),
      }
    : { tenantId };
  // Encrypted employee names cannot be substring searched in SQL. Employee code is searchable.
  const field = employee
    ? "employee_code"
    : kind === "POSITION"
      ? "title"
      : "name";
  if (q.trim()) where[field] = { contains: q.trim(), mode: "insensitive" };
  if (kind === "POSITION") where.isActive = true;
  const select = employee ? employeeSelect : { id: true, [field]: true };
  const [total, rows, selected] = await Promise.all([
    prisma[model].count({ where }),
    prisma[model].findMany({
      where,
      select,
      orderBy: { id: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    selectedId
      ? prisma[model].findFirst({
          where: { ...where, [field]: undefined, id: selectedId },
          select,
        })
      : null,
  ]);
  const choice = (r) => ({
    id: r.id,
    label: employee
      ? label(r) + (r.employee_code ? " · " + r.employee_code : "")
      : r[field],
  });
  return {
    items: rows.map(choice),
    selected: selected ? choice(selected) : null,
    total,
    page,
    pageSize,
    actorEmployeeId: who.id,
  };
}
