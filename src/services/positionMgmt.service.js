// src/services/positionMgmt.service.js — Position Management read/export surface.
//
// Backs the position-management screens (enhanced list, single detail, export).
// Create / edit / deactivate are NOT here — they already live in
// hrContract.service.js (createPosition / updatePosition / updatePositionStatus)
// and are surfaced by hr_position_create / hr_position_update /
// hr_position_status_update in employeeTools.js.
//
// SCHEMA NOTE (band / responsibilities / requirements):
// The Position model currently has ONLY id, title, description, jobCode,
// isActive, createdAt, updatedAt, tenantId, employees[], JobRequisition[]. It
// has NO band / responsibilities / requirements columns yet. Until the additive
// migration lands (see INTEGRATION NOTES in the handoff), those fields are read
// defensively from the optional `__TRUSOFT_POSITION_META__:` JSON blob that
// hr_position_create / hr_position_update already fold into `description` — so
// this code works BEFORE the migration (meta-blob or null) AND is trivially
// swapped to real columns after it (see the post-migration `positionSelect`
// note in the handoff). TODO(position-columns): once band/responsibilities/
// requirements exist as real columns, prefer position.band ?? meta.band, etc.
import prisma from "../lib/prisma.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";
import { scopedWhere } from "../lib/tenancy.js";
import { exportRows } from "../lib/export.util.js";

const POSITION_META_PREFIX = "__TRUSOFT_POSITION_META__:";

// Read band/responsibilities/requirements out of the optional meta blob that the
// existing create/update path writes into `description`. Returns the plain
// description plus null placeholders when no meta blob is present. This is the
// pre-migration bridge; after the columns land these come straight off the row.
const parsePositionDescription = (description) => {
  if (!description || typeof description !== "string" || !description.startsWith(POSITION_META_PREFIX)) {
    return { description: description || null, meta: {} };
  }
  try {
    const parsed = JSON.parse(description.slice(POSITION_META_PREFIX.length));
    return {
      description: parsed.description || null,
      meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {},
    };
  } catch {
    return { description, meta: {} };
  }
};

const employeeName = (employee) =>
  employee?.employee_name ||
  [employee?.first_name, employee?.middle_name, employee?.last_name].filter(Boolean).join(" ") ||
  employee?.preferred_name ||
  `Employee ${employee?.id}`;

// PRE-MIGRATION select: ONLY columns that exist on Position today. A prisma
// `select` naming a non-existent column throws, so band/responsibilities/
// requirements are NOT selected here — they are derived from the meta blob (or
// null). Swap in the enhanced select (adds band/responsibilities/requirements)
// AFTER the additive migration; see the handoff INTEGRATION NOTES.
const positionSelect = {
  id: true,
  title: true,
  description: true,
  jobCode: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  band: true,
  responsibilities: true,
  requirements: true,
};

// filled ratio (e.g. "3/5"):
//   filled   = # of Employee with positionId = position.id (tenant-scoped)
//   openings = SUM of JobRequisition.openings for that position (fallback 0)
// Needs NO schema change — computed live per position.
const buildFilledRatio = async (positionId, tenantId) => {
  const [filled, agg] = await Promise.all([
    prisma.employee.count({
      // Employee carries the tenant on snake_case `tenant_id`; fold it in
      // fail-closed (undefined = legacy unscoped) so the count never crosses
      // tenants.
      where:
        tenantId === undefined
          ? { positionId: Number(positionId) }
          : { positionId: Number(positionId), tenant_id: tenantId ?? null },
    }),
    prisma.jobRequisition.aggregate({
      _sum: { openings: true },
      where: { positionId: Number(positionId) },
    }),
  ]);
  const openings = agg?._sum?.openings ?? 0;
  return { filled, openings, ratio: `${filled}/${openings}` };
};

// Shape one enhanced management row. `filledRatio` is injected by the caller
// (computed per position). `department` is not resolvable from Position today
// (positions don't hold a department FK); surface the meta hint if present else
// null — TODO(position-department): resolve via RBAC once the link exists.
const managementRow = (position, filledRatio) => {
  const { description, meta } = parsePositionDescription(position.description);
  return {
    id: position.id,
    title: position.title,
    code: position.jobCode,
    department: meta.departmentName || null, // not resolvable from Position yet
    departmentId: meta.departmentId || null,
    band: position.band ?? meta.band ?? null, // real column preferred, meta blob fallback
    filled: filledRatio.filled,
    openings: filledRatio.openings,
    filledRatio: filledRatio.ratio,
    status: position.isActive ? "Active" : "Inactive",
    isActive: position.isActive,
    jobDescription: description,
    responsibilities: position.responsibilities ?? meta.responsibilities ?? null,
    requirements: position.requirements ?? meta.requirements ?? null,
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
  };
};

const POSITION_SORTS = ["title", "createdAt", "status"];

// Map an incoming sort key onto a real orderable column. "status" is stored as
// the boolean isActive, so sort on that; title/createdAt map directly.
const positionOrderBy = (sort, order) => {
  const dir = order === "asc" ? "asc" : "desc";
  if (sort === "status") return { isActive: dir };
  if (sort === "title") return { title: dir };
  return { createdAt: dir };
};

// Shared WHERE builder for the management list AND export so the two never
// drift. Supports search q (title/jobCode), status filter, and (post-migration)
// a band filter — surfaced now via the meta blob in a post-query filter.
const buildPositionWhere = (query, tenantId, q) => {
  const filters = {
    status: query.status || null,
    band: query.band ? String(query.band) : null,
  };
  const where = {
    AND: [
      scopedWhere(tenantId, {}),
      q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { jobCode: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
      filters.status ? { isActive: filters.status.toLowerCase() === "active" } : {},
    ],
  };
  return { where, filters };
};

// Enhanced management list: title, department, band, filled ratio, status,
// jobDescription, responsibilities, requirements. Paginated + searchable +
// filterable + sortable. Band filter is applied post-query (meta blob) until the
// column lands; swap to a WHERE predicate after the migration.
export const listManagedPositions = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "createdAt" });
  const { where, filters } = buildPositionWhere(query, tenantId, list.q);
  const sort = POSITION_SORTS.includes(list.sort) ? list.sort : "createdAt";

  const rows = await prisma.position.findMany({
    where,
    select: positionSelect,
    orderBy: positionOrderBy(sort, list.order),
  });

  // Compute the filled ratio for each position, then apply the band filter
  // (meta-blob-derived today). Pagination is applied after band filtering so the
  // total reflects the filtered set.
  const built = await Promise.all(
    rows.map(async (position) => managementRow(position, await buildFilledRatio(position.id, tenantId)))
  );
  const filtered = filters.band
    ? built.filter((row) => row.band && String(row.band) === filters.band)
    : built;

  return buildListPayload({
    ...list,
    sort,
    total: filtered.length,
    filters,
    items: filtered.slice(list.skip, list.skip + list.pageSize),
  });
};

// Single position with all management detail + the filled ratio + the list of
// current employees in it (id, name).
export const getManagedPosition = async (id, tenantId) => {
  const position = await prisma.position.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    select: {
      ...positionSelect,
      employees: {
        select: {
          id: true,
          employee_name: true,
          first_name: true,
          middle_name: true,
          last_name: true,
          preferred_name: true,
        },
        orderBy: { employee_name: "asc" },
        take: 500,
      },
    },
  });

  if (!position) throw new Error("Position not found");

  const filledRatio = await buildFilledRatio(position.id, tenantId);
  const { employees, ...positionCore } = position;

  return {
    ...managementRow(positionCore, filledRatio),
    employees: (employees || []).map((employee) => ({
      id: employee.id,
      name: employeeName(employee),
    })),
  };
};

const POSITION_EXPORT_COLUMNS = [
  { key: "title", header: "Title", value: (r) => r.title || "-" },
  { key: "department", header: "Department", value: (r) => r.department || "-" },
  { key: "band", header: "Band", value: (r) => r.band || "-" },
  { key: "filled", header: "Filled/Openings", value: (r) => r.filledRatio },
  { key: "status", header: "Status" },
  {
    key: "created",
    header: "Created",
    value: (r) => (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "-"),
  },
];

// Export the position-management view (all rows matching the filters) as CSV or
// PDF. Same filters/sort as listManagedPositions; returns a base64 buffer.
export const exportManagedPositions = async (query, tenantId, format = "csv") => {
  const list = parseListQuery(query, { sort: "title" });
  const { where, filters } = buildPositionWhere(query, tenantId, list.q);
  const sort = POSITION_SORTS.includes(list.sort) ? list.sort : "title";

  const rows = await prisma.position.findMany({
    where,
    select: positionSelect,
    orderBy: positionOrderBy(sort, list.order),
    take: 5000, // hard cap so an export can never run away
  });

  const built = await Promise.all(
    rows.map(async (position) => managementRow(position, await buildFilledRatio(position.id, tenantId)))
  );
  const items = filters.band
    ? built.filter((row) => row.band && String(row.band) === filters.band)
    : built;

  const { mimeType, ext, buffer } = await exportRows(format, {
    title: "Position Management",
    subtitle: `${items.length} position(s) — generated ${new Date().toISOString().slice(0, 10)}`,
    columns: POSITION_EXPORT_COLUMNS,
    rows: items,
  });

  return {
    format,
    fileName: `positions-${new Date().toISOString().slice(0, 10)}.${ext}`,
    mimeType,
    count: items.length,
    base64: buffer.toString("base64"),
  };
};
