// src/services/orgChartView.service.js — Organization Chart read views.
//
// Backs the hr_org_chart_departments and hr_org_chart_export MCP tools. All
// reads are tenant-scoped through the verified RBAC Company.uuid (scopedEmployeeWhere)
// so the chart NEVER leaks another tenant's (or a null-tenant's) employees.
//
// Three exports:
//   getDepartmentView(tenantId, {q}) — departments (businessUnit) each with a
//     resolved head + members, sorted by department name.
//   getOrgChartRows(tenantId, {q})   — flat rows (employee / role / department /
//     manager / status) for CSV / PDF export.
//   orgChartToPNG(rows)              — pure-JS boxes-and-lines PNG of the hierarchy
//     (indented by reporting depth) via pureimage. NOTE: pureimage is not yet a
//     dependency — see INTEGRATION NOTES.
import * as PImage from "pureimage";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import prisma from "../lib/prisma.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";

// Bundled font for PNG labels (pureimage has no built-in fonts). Registered +
// loaded once, lazily, on the first PNG render.
const ORG_FONT_PATH = fileURLToPath(new URL("../assets/fonts/OrgSans.ttf", import.meta.url));
let orgFontLoaded = false;
function ensureOrgFont() {
  if (orgFontLoaded) return;
  try {
    const f = PImage.registerFont(ORG_FONT_PATH, "OrgSans");
    f.loadSync();
    orgFontLoaded = true;
  } catch {
    /* font load failed — boxes still render, labels are skipped */
  }
}

// Local copy of the shared employeeName helper (see hrContract.service.js /
// employeeProfileTabs.service.js) — kept local so this file has no cross-service
// coupling beyond prisma + tenancy.
const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.middle_name, e?.last_name].filter(Boolean).join(" ") ||
  e?.preferred_name ||
  (e?.id != null ? `Employee ${e.id}` : null);

const roleOf = (e) => e?.job_title || e?.Position?.title || null;
const statusOf = (e) => e?.status || e?.employement_status || "Active";

// The columns we hydrate for every org-chart read. businessUnit → department,
// manager → reporting line, Position → role fallback.
const ORG_SELECT = {
  id: true,
  employee_name: true,
  first_name: true,
  middle_name: true,
  last_name: true,
  preferred_name: true,
  job_title: true,
  status: true,
  employement_status: true,
  businessUnitId: true,
  managerId: true,
  businessUnit: { select: { id: true, name: true } },
  Position: { select: { id: true, title: true } },
  manager: {
    select: {
      id: true,
      employee_name: true,
      first_name: true,
      middle_name: true,
      last_name: true,
      job_title: true,
    },
  },
};

// Fetch all in-tenant employees, optionally filtered by a free-text q against
// name / role. Returns the raw hydrated rows sorted by name.
const fetchEmployees = async (tenantId, { q } = {}) => {
  const where = {
    AND: [
      scopedEmployeeWhere(tenantId, {}),
      q
        ? {
            OR: [
              { employee_name: { contains: q, mode: "insensitive" } },
              { first_name: { contains: q, mode: "insensitive" } },
              { last_name: { contains: q, mode: "insensitive" } },
              { job_title: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  return prisma.employee.findMany({
    where,
    select: ORG_SELECT,
    orderBy: { employee_name: "asc" },
    take: 5000, // hard cap so the chart can never run away
  });
};

/**
 * Department view: group employees by businessUnit (department), resolve a
 * head per department, sort by department name. Optional q filters employees by
 * name / role across all departments.
 * @param {string|null|undefined} tenantId  verified RBAC Company.uuid
 * @param {{q?: string}} [opts]
 */
export const getDepartmentView = async (tenantId, { q } = {}) => {
  const employees = await fetchEmployees(tenantId, { q });

  // Count direct reports per employee (people whose managerId points at them),
  // computed in-memory over the fetched set to avoid relation-name ambiguity.
  const reportCount = new Map();
  for (const e of employees) {
    if (e.managerId != null) {
      reportCount.set(e.managerId, (reportCount.get(e.managerId) || 0) + 1);
    }
  }

  // Group by department. businessUnitId null → an "Unassigned" bucket.
  const groups = new Map();
  for (const e of employees) {
    const key = e.businessUnitId ?? "__unassigned__";
    if (!groups.has(key)) {
      groups.set(key, {
        departmentId: e.businessUnitId ?? null,
        department: e.businessUnit?.name || "Unassigned",
        members: [],
      });
    }
    groups.get(key).members.push(e);
  }

  const idsInGroup = (members) => new Set(members.map((m) => m.id));

  const pickHead = (members) => {
    if (!members.length) return null;
    const inDept = idsInGroup(members);
    // Heuristic: prefer an employee whose manager is OUTSIDE this department
    // (or who has no manager) — the department's top of the local reporting
    // line. Break ties (and the no-such-employee case) by most direct reports.
    const externallyManaged = members.filter(
      (m) => m.managerId == null || !inDept.has(m.managerId)
    );
    const pool = externallyManaged.length ? externallyManaged : members;
    let head = pool[0];
    let headReports = reportCount.get(head.id) || 0;
    for (const m of pool) {
      const r = reportCount.get(m.id) || 0;
      if (r > headReports) {
        head = m;
        headReports = r;
      }
    }
    return head;
  };

  const departments = [...groups.values()]
    .map((group) => {
      const head = pickHead(group.members);
      return {
        departmentId: group.departmentId,
        department: group.department,
        head: head
          ? {
              id: head.id,
              name: employeeName(head),
              role: roleOf(head),
              status: statusOf(head),
              directReports: reportCount.get(head.id) || 0,
            }
          : null,
        memberCount: group.members.length,
        members: group.members.map((m) => ({
          id: m.id,
          name: employeeName(m),
          role: roleOf(m),
          status: statusOf(m),
        })),
      };
    })
    .sort((a, b) => a.department.localeCompare(b.department));

  return { count: employees.length, departments };
};

/**
 * Flat org-hierarchy rows for export: employee, role, department, manager, status.
 * Rows carry a `depth` (reporting depth from a top-level employee) so the PNG
 * renderer can indent them; CSV/PDF ignore it.
 * @param {string|null|undefined} tenantId
 * @param {{q?: string}} [opts]
 */
export const getOrgChartRows = async (tenantId, { q } = {}) => {
  const employees = await fetchEmployees(tenantId, { q });
  const byId = new Map(employees.map((e) => [e.id, e]));

  // Reporting depth = number of in-set managers above this employee. Cached to
  // keep it O(n); a broken cycle stops at a guard so we never loop forever.
  const depthCache = new Map();
  const depthOf = (e, seen = new Set()) => {
    if (depthCache.has(e.id)) return depthCache.get(e.id);
    if (e.managerId == null || !byId.has(e.managerId) || seen.has(e.id)) {
      depthCache.set(e.id, 0);
      return 0;
    }
    seen.add(e.id);
    const d = depthOf(byId.get(e.managerId), seen) + 1;
    depthCache.set(e.id, d);
    return d;
  };

  return employees.map((e) => ({
    id: e.id,
    name: employeeName(e),
    role: roleOf(e) || "-",
    department: e.businessUnit?.name || "Unassigned",
    manager: e.manager ? employeeName(e.manager) : "-",
    status: statusOf(e),
    depth: depthOf(e),
  }));
};

/**
 * Render a simple boxes-and-lines PNG of the org hierarchy: one labeled box per
 * employee (name + role), indented by reporting depth, connected to the parent
 * box by an elbow line. Pure JS via pureimage. Returns Promise<Buffer>.
 * @param {Array<{name:string, role:string, depth:number}>} rows
 */
export const orgChartToPNG = async (rows) => {
  const list = Array.isArray(rows) ? rows : [];

  // Layout constants.
  const PADDING = 24;
  const INDENT = 40; // px per reporting depth
  const ROW_H = 46; // vertical space per box
  const BOX_H = 34;
  const BOX_W = 260;
  const FONT_SIZE = 12;

  const maxDepth = list.reduce((m, r) => Math.max(m, r.depth || 0), 0);
  const width = PADDING * 2 + maxDepth * INDENT + BOX_W + 20;
  const height = PADDING * 2 + Math.max(list.length, 1) * ROW_H + 40;

  const img = PImage.make(width, height);
  const ctx = img.getContext("2d");

  // Background.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // Title.
  ctx.fillStyle = "#111111";
  ensureOrgFont(); // register + load the bundled DejaVu-based font once
  // pureimage needs a registered font to draw text; when none is available the
  // fillText calls below are wrapped so a missing font never crashes the render.
  const safeText = (text, x, y) => {
    try {
      ctx.fillText(String(text ?? ""), x, y);
    } catch {
      /* font unavailable — boxes still render, labels are skipped */
    }
  };
  ctx.font = `16px OrgSans`;
  safeText("Organization Chart", PADDING, PADDING + 6);

  // Track the last y-center drawn at each depth so a child can elbow back to its
  // parent's box on the left.
  const parentCenterByDepth = new Map();

  ctx.font = `${FONT_SIZE}px OrgSans`;
  list.forEach((row, i) => {
    const depth = row.depth || 0;
    const x = PADDING + depth * INDENT;
    const y = PADDING + 40 + i * ROW_H;
    const cy = y + BOX_H / 2;

    // Connector from the parent box (one depth to the left) down to this box.
    if (depth > 0 && parentCenterByDepth.has(depth - 1)) {
      const parent = parentCenterByDepth.get(depth - 1);
      const elbowX = PADDING + (depth - 1) * INDENT + 12;
      ctx.strokeStyle = "#9aa5b1";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(elbowX, parent.cy);
      ctx.lineTo(elbowX, cy);
      ctx.lineTo(x, cy);
      ctx.stroke();
    }

    // Box.
    ctx.fillStyle = "#eef2f7";
    ctx.fillRect(x, y, BOX_W, BOX_H);
    ctx.strokeStyle = "#5b6b7b";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, BOX_W, BOX_H);

    // Labels: name (bold-ish tone) + role beneath.
    ctx.fillStyle = "#111111";
    safeText(row.name || "-", x + 8, y + 14);
    ctx.fillStyle = "#556070";
    safeText(row.role || "-", x + 8, y + 28);

    parentCenterByDepth.set(depth, { cy });
    // Any deeper cached parents are stale once we move to a shallower/equal depth.
    for (const d of [...parentCenterByDepth.keys()]) {
      if (d > depth) parentCenterByDepth.delete(d);
    }
  });

  // Collect the PNG into a Buffer via a REAL Node stream. pureimage pipes to the
  // sink and calls stream methods (removeListener etc.) + emits 'error'/'end', so
  // the sink MUST be a proper Writable — a fake object throws inside pureimage's
  // async cleanup and escapes as an uncaughtException that kills the process.
  const chunks = [];
  const sink = new PassThrough();
  sink.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    sink.on("end", resolve);
    sink.on("error", reject);
  });
  await PImage.encodePNGToStream(img, sink);
  await done;
  return Buffer.concat(chunks);
};
