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
import { requisitionScopeWhere } from "../lib/recruitmentAccess.js";
import { recordExport } from "../lib/recruitmentOpsMetrics.js";
import {
  assertRequisitionTransition,
  assertRequisitionAdvanceAllowed,
  recordRequisitionTransition,
} from "./requisitionWorkflow.service.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { exportRows } from "../lib/export.util.js";
import { logAction } from "../utils/logs.js";
import { closeActivePostingsForRequisition } from "./requisitionPublication.service.js";

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
  // Phase 2.1 — the append-only transition history, oldest first, so an operator
  // reads the requisition the way it happened (submitted → decided → posted →
  // closed) rather than newest-first like the approval log.
  transitions: { orderBy: { createdAt: "asc" } },
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
  requestedById: requisition.requestedById ?? null,
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
  // Phase 2.1 — every state change, attributed. `baseline`/'migration' rows mark
  // where the history starts for records that predate the table; they are not
  // operator actions and their from/to are equal by construction.
  transitionHistory: (requisition.transitions || []).map((transition) => ({
    fromStatus: transition.fromStatus,
    toStatus: transition.toStatus,
    reason: transition.reason ?? null,
    actorId: transition.actorId ?? null,
    source: transition.source,
    at: transition.createdAt,
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
// Phase 1.4 — `scope` narrows the management list the same way the REST list is
// narrowed, so the transport cannot be used to widen a caller's reach.
export const listManagedRequisitions = async (query, tenantId, scope = null) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const built = buildRequisitionWhere(query, tenantId, list.q);
  const { filters } = built;
  const where = scope ? { AND: [built.where, requisitionScopeWhere(scope)] } : built.where;
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
export const getManagedRequisition = async (id, tenantId, scope = null) => {
  const requisition = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id), ...(scope ? requisitionScopeWhere(scope) : {}) }),
    include: requisitionInclude,
  });
  if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });

  const [row] = await buildRows([requisition], tenantId);
  return row;
};

// Fail-closed tenant-scoped fetch of the raw row for a mutation. Throws 404 when
// the requisition is not in the caller's tenant so a cross-tenant id can never
// be transitioned.
// Phase 2.2 — the FULL row, not `{ id, status }`. The submission gate has to see
// every mandatory field, and a narrower select here would make the gate silently
// read undefined for everything it was written to check.
const requireScoped = async (id, tenantId) => {
  const requisition = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
  });
  if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });
  return requisition;
};

// Submit for approval: status → PENDING_APPROVAL.
// Phase 3.2 — only a DRAFT (or a REJECTED one revised back to draft) may be
// submitted; submitting an APPROVED/POSTED/CLOSED requisition is refused.
// Phase 2.1 — the flip and its history row commit together, and the actor is the
// verified caller rather than an anonymous service call.
export const submitRequisition = async (id, tenantId, actorId = null) => {
  const current = await requireScoped(id, tenantId);
  // Phase 2.2 — the row goes in so the mandatory-field gate can reject an
  // incomplete requisition instead of pushing it into the approval chain.
  assertRequisitionTransition(current.status, "PENDING_APPROVAL", { requisition: current });
  // Phase 4 — and a hiring freeze blocks submission outright. Drafting is not
  // blocked, so this is the first moment the freeze can apply.
  await assertRequisitionAdvanceAllowed(tenantId, current, "PENDING_APPROVAL");
  await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.jobRequisition.update({
        where: { id: Number(id) },
        data: { status: "PENDING_APPROVAL" },
      });
      await recordRequisitionTransition(tx, {
        requisitionId: Number(id),
        tenantId,
        fromStatus: current.status,
        toStatus: "PENDING_APPROVAL",
        actorId,
        source: "requisition.submit",
      });
    },
    { tenantId },
  );
  return getManagedRequisition(id, tenantId);
};

// Reject: status → REJECTED and record a RequisitionApproval row for the
// caller (approverId = caller employeeId) with the rejection comments.
export const rejectRequisition = async (id, tenantId, { comments, approverId } = {}) => {
  const current = await requireScoped(id, tenantId);
  // Phase 3.2 — a decision is only legal on a SUBMITTED requisition, and a
  // rejection must carry a reason (the guard throws on both).
  assertRequisitionTransition(current.status, "REJECTED", { comments });
  // Phase 2.1 — the decision, the approval row and the history row are one unit.
  // Previously this was a bare `$transaction([...])` batch, which does NOT set
  // the tenant GUC on its connection: an interactive tx through tenantTransaction
  // does, so the force-RLS tables are reachable here the same way they are on
  // every other requisition write.
  await tenantTransaction(
    prisma,
    async (tx) => {
      await tx.jobRequisition.update({
        where: { id: Number(id) },
        data: { status: "REJECTED" },
      });
      await tx.requisitionApproval.create({
        data: scopedWhere(tenantId, {
          requisitionId: Number(id),
          approverId: Number(approverId),
          status: "REJECTED",
          comments: comments ?? null,
          decidedAt: new Date(),
        }),
      });
      await recordRequisitionTransition(tx, {
        requisitionId: Number(id),
        tenantId,
        fromStatus: current.status,
        toStatus: "REJECTED",
        reason: comments,
        actorId: approverId,
        source: "requisition.reject",
      });
    },
    { tenantId },
  );
  return getManagedRequisition(id, tenantId);
};

// Close: status → CLOSED (terminal).
//
// Phase 4 / §2.4a — closing a PUBLISHED requisition requires a reason and closes
// every active posting in the same transaction. A closed requisition that is still
// advertised on a job board is the failure this prevents, and "closed" without a
// reason is indistinguishable from "closed because we filled it" in reporting.
// A draft or rejected requisition still closes with no reason (housekeeping).
export const closeRequisition = async (id, tenantId, actorId = null, reason = null) => {
  const current = await requireScoped(id, tenantId);
  assertRequisitionTransition(current.status, "CLOSED", { comments: reason });
  await tenantTransaction(
    prisma,
    async (tx) => {
      const closedPostings = await closeActivePostingsForRequisition(tx, {
        requisitionId: Number(id),
        tenantId,
        closeReason: "REQUISITION_CLOSED",
        actorId,
      });
      await tx.jobRequisition.update({
        where: { id: Number(id) },
        data: { status: "CLOSED" },
      });
      await recordRequisitionTransition(tx, {
        requisitionId: Number(id),
        tenantId,
        fromStatus: current.status,
        toStatus: "CLOSED",
        reason,
        actorId,
        source: "requisition.close",
      });
      if (closedPostings) {
        await logAction({
          employeeId: actorId,
          type: "UPDATE",
          module: "Requisition Close",
          result: "SUCCESS",
          notes: `Requisition "${id}" closed; ${closedPostings} active posting(s) closed`,
          tenantId: typeof tenantId !== "undefined" ? tenantId : null,
        });
      }
    },
    { tenantId },
  );
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
// Phase 1.4 — an export is a read at bulk scale, so it carries the caller's
// record scope too; otherwise the export endpoint would be the way around it.
export const exportManagedRequisitions = async (query, tenantId, format = "csv", scope = null) => {
  // Phase 15 — exports are a rollout metric (format × outcome, no row data in
  // labels). The happy path records below; a denial never reaches the service
  // (F-02 denies first), but a computation failure records `failed`.
  try {
    const result = await exportManagedRequisitionsInner(query, tenantId, format, scope);
    recordExport(format, "ok");
    return result;
  } catch (err) {
    recordExport(format, "failed");
    throw err;
  }
};

const exportManagedRequisitionsInner = async (query, tenantId, format = "csv", scope = null) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const built = buildRequisitionWhere(query, tenantId, list.q);
  const where = scope ? { AND: [built.where, requisitionScopeWhere(scope)] } : built.where;
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
