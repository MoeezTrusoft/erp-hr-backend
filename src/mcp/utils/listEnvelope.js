// src/mcp/utils/listEnvelope.js
//
// IC-1: the HR frontend binds 6 list SCREENS (attendance, candidates, leave
// requests, payslips, performance reviews, requisitions) to hr_*_list MCP
// TOOLS via `callTool` (tools/call). The backend previously exposed those six
// names ONLY as RESOURCES (resources/read), so the tools/call dispatch resolved
// to "tool not found" and the screens fell back to mock data.
//
// These helpers let the new list TOOLS return the exact paginated envelope the
// FE parses — hr-schemas `parseHrCollection` accepts `{ items: [...] }` and the
// `safeArr` adapter reads `.items`/`.data` — regardless of the heterogeneous
// `{ data: [...] }`, `{ data: { items, total } }`, `{ reviews: [...] }` shapes
// the underlying REST controllers emit.

// Generic row-array keys + the HR-specific entity keys the heterogeneous
// controllers use (IC-1: payrollService.getPayslips returns {data:{payslips,
// pagination}} — without "payslips" here findRows missed it and hr_payslips_list
// returned []). Add each entity's plural key so its list tool surfaces rows.
const ARRAY_KEYS = [
  "items", "data", "reviews", "results", "rows", "records",
  "payslips", "candidates", "requisitions", "applications",
  "employees", "leaveRequests", "leave_requests", "attendance", "records",
];
const NEST_KEYS = ["data", "result", "payload"];

// Find the first row array anywhere in a (possibly wrapped) controller payload.
function findRows(payload, depth = 0) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && depth < 4) {
    for (const key of ARRAY_KEYS) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    for (const key of NEST_KEYS) {
      if (payload[key] && typeof payload[key] === "object") {
        const rows = findRows(payload[key], depth + 1);
        if (rows) return rows;
      }
    }
  }
  return null;
}

export function extractRows(payload) {
  return findRows(payload) || [];
}

function extractTotal(payload, rows) {
  const candidates = [
    payload?.total,
    payload?.count,
    payload?.totalCount,
    payload?.data?.total,
    payload?.data?.count,
    payload?.pagination?.total,
    payload?.data?.pagination?.total, // IC-1: payroll nests pagination under data
    payload?.data?.pagination?.totalCount,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return rows.length;
}

// Find an opaque keyset cursor anywhere in a (possibly wrapped) controller
// payload. API-4 — surfaced ALONGSIDE the offset/page fields so cursor-aware
// callers can page forward while offset callers are unaffected.
function findNextCursor(payload, depth = 0) {
  if (payload && typeof payload === "object" && depth < 4) {
    if (typeof payload.nextCursor === "string" && payload.nextCursor) return payload.nextCursor;
    for (const key of NEST_KEYS) {
      if (payload[key] && typeof payload[key] === "object") {
        const found = findNextCursor(payload[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

// Normalize any controller payload into the FE-expected paginated list envelope.
export function toListEnvelope(payload, { page = 1, pageSize } = {}) {
  const rows = extractRows(payload);
  const resolvedPage = Number(page) > 0 ? Number(page) : 1;
  const resolvedPageSize = Number(pageSize) > 0 ? Number(pageSize) : rows.length;
  const envelope = {
    items: rows,
    total: extractTotal(payload, rows),
    page: resolvedPage,
    pageSize: resolvedPageSize,
  };
  // API-4: pass through an opaque nextCursor when the underlying service emits
  // one. Additive — clients that only read items/total/page/pageSize are
  // unaffected, and it's null/absent for services that don't support keyset.
  const nextCursor = findNextCursor(payload);
  if (nextCursor) envelope.nextCursor = nextCursor;
  return envelope;
}

// Build the controller `query` from FE list args: pagination is mapped to the
// REST convention (pageSize → limit) and any extra filters pass through verbatim
// so the underlying service (which already tenant-scopes) can narrow the rows.
export function toListQuery({ page, pageSize, ...filters } = {}) {
  const query = { ...filters };
  if (page != null) query.page = page;
  if (pageSize != null) query.limit = pageSize;
  return query;
}
