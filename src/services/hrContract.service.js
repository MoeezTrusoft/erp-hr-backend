import prisma from "../config/prisma.js";
import { buildListPayload, parseListQuery, toInt } from "../utils/apiContract.js";

const employeeName = (employee) =>
  employee?.employee_name ||
  [employee?.first_name, employee?.middle_name, employee?.last_name].filter(Boolean).join(" ") ||
  employee?.preferred_name ||
  `Employee ${employee?.id}`;

const compactEmployeeSelect = {
  id: true,
  employee_code: true,
  employee_name: true,
  first_name: true,
  middle_name: true,
  last_name: true,
  preferred_name: true,
  email: true,
  work_email: true,
  work_phone: true,
  personal_contact: true,
  job_title: true,
  status: true,
  employement_status: true,
  photo_url: true,
  hire_date: true,
  joining_date: true,
  created_at: true,
  updated_at: true,
  Position: { select: { id: true, title: true, jobCode: true, isActive: true } },
  manager: { select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true } },
  businessUnit: { select: { id: true, name: true } },
  gradeLevel: { select: { id: true, name: true } },
  region: { select: { id: true, name: true } },
};

const employeeDirectoryRow = (employee) => ({
  id: employee.id,
  code: employee.employee_code,
  name: employeeName(employee),
  email: employee.work_email || employee.email,
  phone: employee.work_phone || employee.personal_contact,
  role: employee.job_title || employee.Position?.title,
  position: employee.Position
    ? { id: employee.Position.id, title: employee.Position.title, code: employee.Position.jobCode }
    : null,
  department: employee.businessUnit?.name || null,
  grade: employee.gradeLevel?.name || null,
  location: employee.region?.name || null,
  manager: employee.manager
    ? { id: employee.manager.id, name: employeeName(employee.manager), role: employee.manager.job_title }
    : null,
  status: employee.status || employee.employement_status || "Active",
  avatarUrl: employee.photo_url,
  hireDate: employee.hire_date || employee.joining_date,
  updatedAt: employee.updated_at,
});

const positionRow = (position) => ({
  id: position.id,
  title: position.title,
  description: position.description,
  code: position.jobCode,
  status: position.isActive ? "Active" : "Inactive",
  isActive: position.isActive,
  filledCount: position._count?.employees || 0,
  openCount: Math.max((position._count?.JobRequisition || 0) - (position._count?.employees || 0), 0),
  requisitionCount: position._count?.JobRequisition || 0,
  createdAt: position.createdAt,
  updatedAt: position.updatedAt,
});

const requisitionRow = (requisition) => ({
  id: requisition.id,
  code: `REQ-${String(requisition.id).padStart(4, "0")}`,
  title: requisition.title,
  description: requisition.description,
  departmentId: requisition.departmentId,
  department: requisition.departmentId ? `Department ${requisition.departmentId}` : null,
  manager: requisition.requestedBy ? employeeName(requisition.requestedBy) : null,
  priority: requisition.priority || "Medium",
  positionId: requisition.positionId,
  position: requisition.position
    ? { id: requisition.position.id, title: requisition.position.title, code: requisition.position.jobCode }
    : null,
  requestedBy: requisition.requestedBy
    ? { id: requisition.requestedBy.id, name: employeeName(requisition.requestedBy) }
    : null,
  approvedBy: requisition.approvedBy
    ? { id: requisition.approvedBy.id, name: employeeName(requisition.approvedBy) }
    : null,
  openings: requisition.openings,
  status: requisition.status,
  approvals: requisition.approvals?.map((approval) => ({
    id: approval.id,
    status: approval.status,
    comments: approval.comments,
    decidedAt: approval.decidedAt,
    approver: approval.approver
      ? { id: approval.approver.id, name: employeeName(approval.approver) }
      : null,
  })),
  createdAt: requisition.createdAt,
  updatedAt: requisition.updatedAt,
});

const listOrder = (sort, order, fallback, allowed) => {
  const field = allowed.includes(sort) ? sort : fallback;
  return { [field]: order };
};

export const getDashboardWidgetCatalog = async () => ({
  items: [
    { id: "headcount-summary", title: "Headcount Summary", permission: "hr:employee", defaultSize: "md" },
    { id: "hiring-overview", title: "Hiring Overview", permission: "hr:recruitment", defaultSize: "md" },
    { id: "attendance-leave", title: "Attendance and Leave", permission: "hr:attendance", defaultSize: "lg" },
    { id: "payroll-summary", title: "Payroll Summary", permission: "hr:payroll", defaultSize: "md" },
    { id: "performance-summary", title: "Performance Summary", permission: "hr:performance", defaultSize: "md" },
    { id: "document-expiry", title: "Document Expiry Alerts", permission: "hr:compliance", defaultSize: "md" },
  ],
});

export const getDashboardSummary = async () => {
  const [employees, activeEmployees, positions, requisitions, pendingRequisitions] = await Promise.all([
    prisma.employee.count(),
    prisma.employee.count({
      where: { OR: [{ status: "Active" }, { employement_status: "Active" }] },
    }),
    prisma.position.count({ where: { isActive: true } }),
    prisma.jobRequisition.count(),
    prisma.jobRequisition.count({ where: { status: "PENDING_APPROVAL" } }),
  ]);

  return {
    widgets: {
      headcountSummary: { total: employees, active: activeEmployees },
      positions: { active: positions },
      recruitment: { totalRequisitions: requisitions, pendingApproval: pendingRequisitions },
    },
  };
};

export const getDashboardLayout = async (employeeId) => {
  if (!employeeId) return { widgets: [], updatedAt: null };

  const employee = await prisma.employee.findUnique({
    where: { id: Number(employeeId) },
    select: { additional_fields: true },
  });

  return employee?.additional_fields?.dashboardLayout || { widgets: [], updatedAt: null };
};

export const saveDashboardLayout = async (employeeId, layout) => {
  if (!employeeId) throw new Error("Employee context is required to save dashboard layout");

  const employee = await prisma.employee.findUnique({
    where: { id: Number(employeeId) },
    select: { additional_fields: true },
  });

  if (!employee) throw new Error("Employee not found");

  const additionalFields =
    employee.additional_fields && typeof employee.additional_fields === "object"
      ? employee.additional_fields
      : {};
  const dashboardLayout = {
    widgets: Array.isArray(layout?.widgets) ? layout.widgets : [],
    updatedAt: new Date().toISOString(),
  };

  await prisma.employee.update({
    where: { id: Number(employeeId) },
    data: { additional_fields: { ...additionalFields, dashboardLayout } },
  });

  return dashboardLayout;
};

export const listEmployees = async (query) => {
  const list = parseListQuery(query, { sort: "created_at" });
  const filters = {
    status: query.status || null,
    positionId: toInt(query.positionId),
    departmentId: toInt(query.departmentId),
  };

  const where = {
    AND: [
      list.q
        ? {
            OR: [
              { employee_name: { contains: list.q, mode: "insensitive" } },
              { first_name: { contains: list.q, mode: "insensitive" } },
              { last_name: { contains: list.q, mode: "insensitive" } },
              { employee_code: { contains: list.q, mode: "insensitive" } },
              { email: { contains: list.q, mode: "insensitive" } },
              { work_email: { contains: list.q, mode: "insensitive" } },
              { job_title: { contains: list.q, mode: "insensitive" } },
            ],
          }
        : {},
      filters.status
        ? { OR: [{ status: filters.status }, { employement_status: filters.status }] }
        : {},
      filters.positionId ? { positionId: filters.positionId } : {},
      filters.departmentId ? { businessUnitId: filters.departmentId } : {},
    ],
  };

  const allowedSorts = ["created_at", "updated_at", "employee_name", "employee_code", "hire_date"];
  const orderBy = { [allowedSorts.includes(list.sort) ? list.sort : "created_at"]: list.order };

  const [items, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      select: compactEmployeeSelect,
      orderBy,
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.employee.count({ where }),
  ]);

  return buildListPayload({
    ...list,
    total,
    filters,
    items: items.map(employeeDirectoryRow),
  });
};

export const getEmployeeQuickView = async (id) => {
  const employee = await prisma.employee.findUnique({
    where: { id: Number(id) },
    select: {
      ...compactEmployeeSelect,
      emergencyContact: { take: 2 },
      leaveBalances: { take: 5 },
      TrainingEnrollment: { take: 5, include: { course: true } },
    },
  });

  if (!employee) throw new Error("Employee not found");

  return {
    ...employeeDirectoryRow(employee),
    emergencyContacts: employee.emergencyContact,
    leaveBalances: employee.leaveBalances,
    training: employee.TrainingEnrollment?.map((enrollment) => ({
      id: enrollment.id,
      course: enrollment.course?.title,
      status: enrollment.status,
      progress: enrollment.progress,
    })),
  };
};

export const getEmployeeProfile = async (id) => {
  const employee = await prisma.employee.findUnique({
    where: { id: Number(id) },
    select: {
      ...compactEmployeeSelect,
      date_of_birth: true,
      nationality: true,
      marital_status: true,
      current_address: true,
      city: true,
      country: true,
      employee_type: true,
      fte: true,
      tenureMonths: true,
      teamMembers: { select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true } },
      reports: { select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true } },
    },
  });

  if (!employee) throw new Error("Employee not found");

  return {
    summary: employeeDirectoryRow(employee),
    overview: {
      dateOfBirth: employee.date_of_birth,
      nationality: employee.nationality,
      maritalStatus: employee.marital_status,
      address: employee.current_address,
      city: employee.city,
      country: employee.country,
      employeeType: employee.employee_type,
      fte: employee.fte,
      tenure: employee.tenureMonths,
    },
    org: {
      manager: employee.manager,
      reports: employee.reports?.map((report) => ({ id: report.id, name: employeeName(report), role: report.job_title })),
      teamMembers: employee.teamMembers?.map((member) => ({ id: member.id, name: employeeName(member), role: member.job_title })),
    },
  };
};

export const getEmployeeDocuments = async (id) => {
  const documents = await prisma.employeeMedia.findMany({
    where: { employee_id: Number(id), visibility: true },
    orderBy: { id: "desc" },
  });

  return {
    items: documents.map((document) => ({
      id: document.id,
      title: document.title,
      category: document.category,
      version: document.version,
      effectiveDate: document.effective_date,
      expiryDate: document.expiry_date,
      notes: document.notes,
      mediaId: document.media_id,
    })),
  };
};

export const updateEmployeeStatus = async (id, status, actorId) => {
  if (!status) throw new Error("Status is required");

  const employee = await prisma.employee.update({
    where: { id: Number(id) },
    data: {
      status,
      employement_status: status,
      updatedById: actorId ? Number(actorId) : undefined,
    },
    select: compactEmployeeSelect,
  });

  return employeeDirectoryRow(employee);
};

export const listPositions = async (query) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const filters = { status: query.status || null };
  const where = {
    AND: [
      list.q ? { title: { contains: list.q, mode: "insensitive" } } : {},
      filters.status ? { isActive: filters.status.toLowerCase() === "active" } : {},
    ],
  };

  const [items, total] = await Promise.all([
    prisma.position.findMany({
      where,
      include: { _count: { select: { employees: true, JobRequisition: true } } },
      orderBy: listOrder(list.sort, list.order, "createdAt", ["id", "title", "createdAt", "updatedAt"]),
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.position.count({ where }),
  ]);

  return buildListPayload({ ...list, total, filters, items: items.map(positionRow) });
};

export const getPosition = async (id) => {
  const position = await prisma.position.findUnique({
    where: { id: Number(id) },
    include: {
      employees: { select: compactEmployeeSelect, take: 20, orderBy: { employee_name: "asc" } },
      JobRequisition: { take: 10, orderBy: { createdAt: "desc" } },
      _count: { select: { employees: true, JobRequisition: true } },
    },
  });

  if (!position) throw new Error("Position not found");

  return {
    ...positionRow(position),
    employees: position.employees.map(employeeDirectoryRow),
    requisitions: position.JobRequisition.map(requisitionRow),
  };
};

export const createPosition = async (data, actorId) => {
  if (!data.title) throw new Error("Title is required");

  const lastPosition = await prisma.position.findFirst({
    orderBy: { id: "desc" },
    select: { id: true },
  });
  const nextId = lastPosition ? lastPosition.id + 1 : 1;

  const position = await prisma.position.create({
    data: {
      title: data.title,
      description: data.description || null,
      isActive: data.isActive ?? true,
      createdById: actorId ? Number(actorId) : null,
      jobCode: data.jobCode || `TST-${nextId.toString().padStart(3, "0")}`,
    },
    include: { _count: { select: { employees: true, JobRequisition: true } } },
  });

  return positionRow(position);
};

export const updatePosition = async (id, data) => {
  const position = await prisma.position.update({
    where: { id: Number(id) },
    data: {
      title: data.title,
      description: data.description,
      isActive: data.isActive,
      jobCode: data.jobCode,
    },
    include: { _count: { select: { employees: true, JobRequisition: true } } },
  });

  return positionRow(position);
};

export const updatePositionStatus = async (id, isActive) => {
  const position = await prisma.position.update({
    where: { id: Number(id) },
    data: { isActive },
    include: { _count: { select: { employees: true, JobRequisition: true } } },
  });

  return positionRow(position);
};

export const listRequisitions = async (query) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const filters = {
    status: query.status || null,
    positionId: toInt(query.positionId),
  };
  const where = {
    AND: [
      list.q ? { title: { contains: list.q, mode: "insensitive" } } : {},
      filters.status ? { status: filters.status } : {},
      filters.positionId ? { positionId: filters.positionId } : {},
    ],
  };

  const [items, total] = await Promise.all([
    prisma.jobRequisition.findMany({
      where,
      include: {
        position: true,
        requestedBy: true,
        approvedBy: true,
        approvals: { include: { approver: true }, orderBy: { id: "desc" } },
      },
      orderBy: listOrder(list.sort, list.order, "createdAt", ["id", "title", "createdAt", "updatedAt", "status"]),
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.jobRequisition.count({ where }),
  ]);

  return buildListPayload({ ...list, total, filters, items: items.map(requisitionRow) });
};

export const getRequisition = async (id) => {
  const requisition = await prisma.jobRequisition.findUnique({
    where: { id: Number(id) },
    include: {
      position: true,
      requestedBy: true,
      approvedBy: true,
      approvals: { include: { approver: true }, orderBy: { id: "desc" } },
      postings: { orderBy: { postedAt: "desc" } },
    },
  });

  if (!requisition) throw new Error("Requisition not found");

  return { ...requisitionRow(requisition), postings: requisition.postings };
};

export const createRequisition = async (data, actorId) => {
  if (!data.title) throw new Error("Title is required");
  if (!actorId) throw new Error("Employee context is required");

  const requisition = await prisma.jobRequisition.create({
    data: {
      title: data.title,
      description: data.description || null,
      departmentId: toInt(data.departmentId),
      positionId: toInt(data.positionId),
      requestedById: Number(actorId),
      openings: Number(data.openings || 1),
      status: data.status || "DRAFT",
    },
    include: { position: true, requestedBy: true, approvedBy: true, approvals: true },
  });

  return requisitionRow(requisition);
};

export const updateRequisition = async (id, data) => {
  const requisition = await prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: {
      title: data.title,
      description: data.description,
      departmentId: data.departmentId === undefined ? undefined : toInt(data.departmentId),
      positionId: data.positionId === undefined ? undefined : toInt(data.positionId),
      openings: data.openings === undefined ? undefined : Number(data.openings),
    },
    include: { position: true, requestedBy: true, approvedBy: true, approvals: true },
  });

  return requisitionRow(requisition);
};

const transitionRequisition = async ({ id, status, actorId, comments }) => {
  if (!actorId) throw new Error("Employee context is required");

  const requisition = await prisma.jobRequisition.findUnique({ where: { id: Number(id) } });
  if (!requisition) throw new Error("Requisition not found");

  const updated = await prisma.$transaction(async (tx) => {
    if (["APPROVED", "REJECTED"].includes(status)) {
      await tx.requisitionApproval.create({
        data: {
          requisitionId: Number(id),
          approverId: Number(actorId),
          status,
          comments,
          decidedAt: new Date(),
        },
      });
    }

    return tx.jobRequisition.update({
      where: { id: Number(id) },
      data: {
        status,
        approvedById: status === "APPROVED" || status === "REJECTED" ? Number(actorId) : undefined,
      },
      include: {
        position: true,
        requestedBy: true,
        approvedBy: true,
        approvals: { include: { approver: true }, orderBy: { id: "desc" } },
      },
    });
  });

  return requisitionRow(updated);
};

export const submitRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "PENDING_APPROVAL" });

export const approveRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "APPROVED" });

export const rejectRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "REJECTED" });

export const closeRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "CLOSED" });

export const reopenRequisition = (id, actorId, comments) =>
  transitionRequisition({ id, actorId, comments, status: "DRAFT" });
