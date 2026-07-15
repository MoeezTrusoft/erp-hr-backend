// src/services/requisitionMgmt.service.js — Job Requisition Management read/action/export surface.
//
// Backs the requisition-management screens (enhanced list, single detail,
// submit / reject / close lifecycle actions, export). This is the MANAGEMENT
// view layered on top of the existing recruitment requisition CRUD — the
// create / update / delete / approve / post lifecycle already lives in
// recruitmentMcpController.js and is surfaced by hr_requisition_create /
// _update / _delete / _approve / _post. This file adds ONLY the management
// list/detail, the submit / reject / close transitions, and the export.
//
// TENANCY: every query is fail-closed tenant-scoped. JobRequisition,
// RequisitionApproval and BusinessUnit carry the camelCase `tenantId` column
// (scopedWhere). Employee carries the snake_case `tenant_id` — but names are
// resolved via a relation include on JobRequisition, so the parent's tenant
// scope already constrains the row set; no separate Employee scoping needed for
// the name lookups.
import prisma from "../lib/prisma.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";
import { scopedWhere } from "../lib/tenancy.js";
import { exportRows } from "../lib/export.util.js";

// Resolve a display name from an Employee row (names decrypt transparently via
// the C4 client extension on the shared prisma singleton).
const employeeName = (employee) => {
  if (!employee) return null;
  return (
    employee.employee_name ||
    [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(" ") ||
    employee.preferred_name ||
    (employee.id != null ? `Employee ${employee.id}` : null) ||
    null
  );
};

const EMPLOYEE_NAME_SELECT = {
  id: true,
  employee_name: true,
  first_name: true,
  middle_name: true,
  last_name: true,
  preferred_name: true,
};

// Include shape shared by list + detail so the two never drift.
const requisitionInclude = {
  requestedBy: { select: EMPLOYEE_NAME_SELECT },
  approvedBy: { select: EMPLOYEE_NAME_SELECT },
  approvals: {
    orderBy: { decidedAt: "desc" },
    include: { approver: { select: EMPLOYEE_NAME_SELECT } },
  },
};

// Resolve departmentId (a BusinessUnit id) → business-unit name, batched for a
// page of requisitions so we never issue N queries. Returns a Map<id, name>.
const resolveDepartmentNames = async (departmentIds, tenantId) => {
  const ids = [...new Set(departmentIds.filter((id) => id != null))];
  if (!ids.length) return new Map();
  const units = await prisma.businessUnit.findMany({
    where: scopedWhere(tenantId, { id: { in: ids } }),
    select: { id: true, name: true },
  });
  return new Map(units.map((unit) => [unit.id, unit.name]));
};

// Shape one management row. `departmentName` is injected by the caller (batched).
const managementRow = (requisition, departmentName) => ({
  reqId: requisition.id,
  id: requisition.id,
  title: requisition.title,
  department: departmentName ?? null,
  departmentId: requisition.departmentId ?? null,
  manager: employeeName(requisition.requestedBy),
  openCount: requisition.openings,
  openings: requisition.openings,
  priority: requisition.priority ?? null,
  status: requisition.status,
  jobDescription: requisition.description ?? null,
  requirements: requisition.requirements ?? null,
  createdAt: requisition.createdAt,
  updatedAt: requisition.updatedAt,
  approvalHistory: (requisition.approvals || []).map((approval) => ({
    approvedBy: employeeName(approval.approver),
    status: approval.status,
    decidedAt: approval.decidedAt,
    comments: approval.comments ?? null,
  })),
});

const REQUISITION_SORTS = ["createdAt", "title", "priority", "status"];

const requisitionOrderBy = (sort, order) => {
  const dir = order === "asc" ? "asc" : "desc";
  if (sort === "title") return { title: dir };
  if (sort === "priority") return { priority: dir };
  if (sort === "status") return { status: dir };
  return { createdAt: dir };
};

// Shared WHERE builder for the management list AND export so the two never
// drift. Supports search q (title), status/priority/departmentId filters, all
// tenant-scoped fail-closed.
const buildRequisitionWhere = (query, tenantId, q) => {
  const filters = {
    status: query.status || null,
    priority: query.priority || null,
    departmentId: query.departmentId != null && query.departmentId !== "" ? Number(query.departmentId) : null,
  };
  const where = {
    AND: [
      scopedWhere(tenantId, {}),
      q ? { title: { contains: q, mode: "insensitive" } } : {},
      filters.status ? { status: filters.status } : {},
      filters.priority ? { priority: filters.priority } : {},
      filters.departmentId != null && Number.isFinite(filters.departmentId)
        ? { departmentId: filters.departmentId }
        : {},
    ],
  };
  return { where, filters };
};

// Build a page of management rows (list + department-name resolution) from a set
// of raw requisition rows.
const buildRows = async (rows, tenantId) => {
  const deptNames = await resolveDepartmentNames(rows.map((r) => r.departmentId), tenantId);
  return rows.map((requisition) =>
    managementRow(requisition, deptNames.get(requisition.departmentId) ?? null)
  );
};

// Enhanced management list: reqId, title, department, manager, openCount,
// priority, status, jobDescription, requirements, approvalHistory. Paginated +
// searchable (title) + filterable (status/priority/departmentId) + sortable
// (createdAt|title|priority|status).
export const listManagedRequisitions = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const { where, filters } = buildRequisitionWhere(query, tenantId, list.q);
  const sort = REQUISITION_SORTS.includes(list.sort) ? list.sort : "createdAt";

  const [total, rows] = await Promise.all([
    prisma.jobRequisition.count({ where }),
    prisma.jobRequisition.findMany({
      where,
      include: requisitionInclude,
      orderBy: requisitionOrderBy(sort, list.order),
      skip: list.skip,
      take: list.pageSize,
    }),
  ]);

  return buildListPayload({
    ...list,
    sort,
    total,
    filters,
    items: await buildRows(rows, tenantId),
  });
};

// Single requisition with full management detail + approvalHistory.
export const getManagedRequisition = async (id, tenantId) => {
  const requisition = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: requisitionInclude,
  });
  if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });

  const [row] = await buildRows([requisition], tenantId);
  return row;
};

// Fail-closed tenant-scoped fetch of the raw row for a mutation. Throws 404 when
// the requisition is not in the caller's tenant so a cross-tenant id can never
// be transitioned.
const requireScoped = async (id, tenantId) => {
  const requisition = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    select: { id: true, status: true },
  });
  if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });
  return requisition;
};

// Submit for approval: status → PENDING_APPROVAL.
export const submitRequisition = async (id, tenantId) => {
  await requireScoped(id, tenantId);
  await prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: { status: "PENDING_APPROVAL" },
  });
  return getManagedRequisition(id, tenantId);
};

// Reject: status → REJECTED and record a RequisitionApproval row for the
// caller (approverId = caller employeeId) with the rejection comments.
export const rejectRequisition = async (id, tenantId, { comments, approverId } = {}) => {
  await requireScoped(id, tenantId);
  await prisma.$transaction([
    prisma.jobRequisition.update({
      where: { id: Number(id) },
      data: { status: "REJECTED" },
    }),
    prisma.requisitionApproval.create({
      data: scopedWhere(tenantId, {
        requisitionId: Number(id),
        approverId: Number(approverId),
        status: "REJECTED",
        comments: comments ?? null,
        decidedAt: new Date(),
      }),
    }),
  ]);
  return getManagedRequisition(id, tenantId);
};

// Close: status → CLOSED.
export const closeRequisition = async (id, tenantId) => {
  await requireScoped(id, tenantId);
  await prisma.jobRequisition.update({
    where: { id: Number(id) },
    data: { status: "CLOSED" },
  });
  return getManagedRequisition(id, tenantId);
};

const REQUISITION_EXPORT_COLUMNS = [
  { key: "reqId", header: "Req ID", value: (r) => r.reqId },
  { key: "title", header: "Title", value: (r) => r.title || "-" },
  { key: "department", header: "Department", value: (r) => r.department || "-" },
  { key: "manager", header: "Manager", value: (r) => r.manager || "-" },
  { key: "openings", header: "Openings", value: (r) => r.openCount },
  { key: "priority", header: "Priority", value: (r) => r.priority || "-" },
  { key: "status", header: "Status", value: (r) => r.status },
];

// Export the requisition-management view (all rows matching the filters) as CSV
// or PDF. Same filters/sort as the list; returns a base64 buffer.
export const exportManagedRequisitions = async (query, tenantId, format = "csv") => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const { where } = buildRequisitionWhere(query, tenantId, list.q);
  const sort = REQUISITION_SORTS.includes(list.sort) ? list.sort : "createdAt";

  const rows = await prisma.jobRequisition.findMany({
    where,
    include: requisitionInclude,
    orderBy: requisitionOrderBy(sort, list.order),
    take: 5000, // hard cap so an export can never run away
  });

  const items = await buildRows(rows, tenantId);

  const { mimeType, ext, buffer } = await exportRows(format, {
    title: "Job Requisitions",
    subtitle: `${items.length} requisition(s) — generated ${new Date().toISOString().slice(0, 10)}`,
    columns: REQUISITION_EXPORT_COLUMNS,
    rows: items,
  });

  return {
    format,
    fileName: `requisitions-${new Date().toISOString().slice(0, 10)}.${ext}`,
    mimeType,
    count: items.length,
    base64: buffer.toString("base64"),
  };
};
