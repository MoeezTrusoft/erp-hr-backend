// src/services/onboardingMgmt.service.js — onboarding list screen (search /
// filter / sort / pagination over OnboardingChecklist). Tenant-scoped.
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";

const employeeName = (e) =>
  e?.employee_name || [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() || null;

const ONBOARDING_SORTS = ["startDate", "targetDate", "status", "title", "completedAt"];

const buildWhere = (query, tenantId, q) => {
  const status = query.status || null;
  return {
    where: {
      AND: [
        scopedWhere(tenantId, {}),
        q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { employee: { is: { employee_name: { contains: q, mode: "insensitive" } } } },
                { employee: { is: { first_name: { contains: q, mode: "insensitive" } } } },
                { employee: { is: { last_name: { contains: q, mode: "insensitive" } } } },
              ],
            }
          : {},
        status ? { status } : {},
      ],
    },
    filters: { status },
  };
};

const shapeRow = (c) => {
  const tasks = c.tasks || [];
  const done = tasks.filter((t) => t.completed).length;
  return {
    id: c.id,
    employeeId: c.employeeId,
    employeeName: employeeName(c.employee),
    title: c.title,
    startDate: c.startDate,
    targetDate: c.targetDate ?? null,
    status: c.status,
    completedAt: c.completedAt ?? null,
    tasksTotal: tasks.length,
    tasksDone: done,
    progress: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    buddy: c.buddy ? employeeName(c.buddy.buddy) : null,
    notes: c.notes ?? null,
  };
};

export const listOnboarding = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "startDate" });
  const { where, filters } = buildWhere(query, tenantId, list.q);
  const orderBy = { [ONBOARDING_SORTS.includes(list.sort) ? list.sort : "startDate"]: list.order };

  const [items, total] = await Promise.all([
    prisma.onboardingChecklist.findMany({
      where,
      orderBy,
      skip: list.skip,
      take: list.pageSize,
      include: {
        employee: { select: { id: true, employee_name: true, first_name: true, last_name: true } },
        tasks: { select: { completed: true } },
        buddy: { include: { buddy: { select: { employee_name: true, first_name: true, last_name: true } } } },
      },
    }),
    prisma.onboardingChecklist.count({ where }),
  ]);

  return buildListPayload({ ...list, total, filters, items: items.map(shapeRow) });
};
