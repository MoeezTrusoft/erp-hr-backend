import prisma from "../config/prisma.js";

function toNode(employee) {
  return {
    id: employee.id,
    name: `${employee.first_name || ""} ${employee.last_name || ""}`.trim(),
    title: employee.job_title,
    status: employee.employement_status,
    managerId: employee.managerId,
    children: [],
  };
}

export const getOrgChart = async () => {
  const employees = await prisma.employee.findMany({
    select: {
      id: true,
      first_name: true,
      last_name: true,
      job_title: true,
      employement_status: true,
      managerId: true,
    },
    orderBy: { id: "asc" },
  });

  const map = new Map(employees.map((e) => [e.id, toNode(e)]));
  const roots = [];

  for (const e of employees) {
    const node = map.get(e.id);
    if (e.managerId && map.has(e.managerId)) {
      map.get(e.managerId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
};

export const getOrgSubtree = async (employeeId) => {
  const roots = await getOrgChart();
  const targetId = Number(employeeId);

  const stack = [...roots];
  while (stack.length) {
    const curr = stack.pop();
    if (curr.id === targetId) return curr;
    stack.push(...curr.children);
  }
  return null;
};
