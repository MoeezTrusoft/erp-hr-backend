// src/services/payrollRule.service.js
//
// Payroll Setup → Pay Rules: discrete, tenant-owned policy rules (an array on
// the screen), distinct from the singleton PayrollRuleConfig toggles. Each rule
// carries a human `title` + `description`; the backend camel-cases the title
// into a stable `ruleKey` (e.g. "Mid Month Joiner Proration" →
// "midMonthJoinerProration") used as the machine key, unique per tenant.
//
// PayrollRule is a FORCE-RLS model (see src/lib/rlsTenant.js). Reads fold the
// verified tenant via scopedWhere/scopedData; the multi-row create runs inside a
// tenantTransaction so the tenant GUC is set for the whole batch. No console —
// pino logger only.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function toIntOrNull(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Camel-case a human title into a stable machine key:
//   "Mid Month Joiner Proration" → "midMonthJoinerProration"
//   "LWP Recovery"               → "lwpRecovery"
//   "off-cycle_release"          → "offCycleRelease"
// Splits on any non-alphanumeric run; first word lower-cased, the rest
// capitalised. Returns "" when the title has no usable characters.
export function camelCaseKey(title) {
  const words = String(title == null ? "" : title)
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words
    .map((w, i) =>
      i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join("");
}

function toRow(r) {
  return {
    id: r.id,
    ruleKey: r.ruleKey,
    title: r.title,
    description: r.description ?? null,
    enabled: r.enabled,
    sortOrder: r.sortOrder,
    status: r.status,
    version: r.version,
  };
}

// Normalise + validate one incoming {title, description, enabled?, sortOrder?}.
function normalizeInput(raw, idx) {
  const label = `rules[${idx}]`;
  const title = raw && raw.title != null ? String(raw.title).trim() : "";
  if (!title) throw badRequest(`${label}: title is required`);
  const ruleKey = camelCaseKey(title);
  if (!ruleKey) throw badRequest(`${label}: title "${title}" has no letters/digits to build a rule key from`);
  return {
    title,
    ruleKey,
    description:
      raw.description == null || raw.description === "" ? null : String(raw.description).trim(),
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    sortOrder: toIntOrNull(raw.sortOrder) ?? 0,
  };
}

// Create one or many rules. Accepts an array of {title, description, ...}; the
// title is camel-cased into ruleKey server-side. Rejects duplicate keys both
// within the batch and against already-stored rules for the tenant.
export async function createPayrollRules({ tenantId, rules }) {
  const list = Array.isArray(rules) ? rules : rules == null ? [] : [rules];
  if (list.length === 0) throw badRequest("rules must be a non-empty array of { title, description }");

  const normalized = list.map(normalizeInput);

  // In-batch duplicate keys.
  const seen = new Map();
  for (const r of normalized) {
    if (seen.has(r.ruleKey)) {
      throw conflict(`Duplicate rule key "${r.ruleKey}" in the batch (titles "${seen.get(r.ruleKey)}" and "${r.title}" collapse to the same key)`);
    }
    seen.set(r.ruleKey, r.title);
  }

  const created = await tenantTransaction(prisma, async (tx) => {
    const keys = normalized.map((r) => r.ruleKey);
    const existing = await tx.payrollRule.findMany({
      where: scopedWhere(tenantId, { ruleKey: { in: keys } }),
      select: { ruleKey: true },
    });
    if (existing.length > 0) {
      const dup = existing.map((e) => e.ruleKey).join(", ");
      throw conflict(`Rule(s) already exist for this tenant: ${dup}`);
    }
    const rows = [];
    for (const r of normalized) {
      const row = await tx.payrollRule.create({
        data: scopedData(tenantId, { ...r, status: "DRAFT", version: 1 }),
      });
      rows.push(row);
    }
    return rows;
  });

  logger.info({ tenantId, count: created.length }, "payroll rules created");
  return { success: true, created: created.length, items: created.map(toRow) };
}

// Update a single rule. Changing the title recomputes ruleKey (re-checking
// per-tenant uniqueness). Any edit bumps version and reverts the row to DRAFT,
// matching the rest of the Payroll Setup config surface.
export async function updatePayrollRule({ tenantId, id, title, description, enabled, sortOrder }) {
  const ruleId = toIntOrNull(id);
  if (ruleId == null) throw badRequest("id is required");

  const row = await tenantTransaction(prisma, async (tx) => {
    const existing = await tx.payrollRule.findFirst({ where: scopedWhere(tenantId, { id: ruleId }) });
    if (!existing) throw notFound(`Payroll rule ${id} not found`);

    const data = {};
    if (title !== undefined) {
      const t = title == null ? "" : String(title).trim();
      if (!t) throw badRequest("title cannot be empty");
      const key = camelCaseKey(t);
      if (!key) throw badRequest(`title "${t}" has no letters/digits to build a rule key from`);
      if (key !== existing.ruleKey) {
        const clash = await tx.payrollRule.findFirst({
          where: scopedWhere(tenantId, { ruleKey: key, id: { not: ruleId } }),
          select: { id: true },
        });
        if (clash) throw conflict(`Another rule already uses the key "${key}"`);
      }
      data.title = t;
      data.ruleKey = key;
    }
    if (description !== undefined) {
      data.description = description == null || description === "" ? null : String(description).trim();
    }
    if (enabled !== undefined) data.enabled = Boolean(enabled);
    if (sortOrder !== undefined) data.sortOrder = toIntOrNull(sortOrder) ?? 0;

    if (Object.keys(data).length === 0) throw badRequest("Provide at least one field to update");

    return tx.payrollRule.update({
      where: { id: ruleId },
      data: { ...data, status: "DRAFT", version: (existing.version ?? 1) + 1 },
    });
  });

  logger.info({ id: ruleId, tenantId }, "payroll rule updated");
  return toRow(row);
}

// Delete one or many rules (single `id` or an `ids` array). Tenant-scoped
// deleteMany so a cross-tenant id resolves to 0 rows rather than deleting
// another tenant's rule.
export async function deletePayrollRules({ tenantId, id, ids }) {
  const raw = ids !== undefined ? ids : id;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const idList = [...new Set(list.map(toIntOrNull).filter((n) => n != null))];
  if (idList.length === 0) throw badRequest("Provide id or ids (SalaryComponent-style) to delete");

  const res = await prisma.payrollRule.deleteMany({
    where: scopedWhere(tenantId, { id: { in: idList } }),
  });
  if (res.count === 0) throw notFound("No matching payroll rule(s) found");
  logger.info({ tenantId, requested: idList.length, deleted: res.count }, "payroll rules deleted");
  return { success: true, requested: idList.length, deleted: res.count };
}

const SORT_FIELDS = { sortOrder: "sortOrder", title: "title", ruleKey: "ruleKey", createdAt: "createdAt" };

export async function listPayrollRules({ tenantId, q, enabled, status, sortBy, sortDir, page, pageSize } = {}) {
  const where = scopedWhere(tenantId, {
    ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: String(q), mode: "insensitive" } },
            { ruleKey: { contains: String(q), mode: "insensitive" } },
            { description: { contains: String(q), mode: "insensitive" } },
          ],
        }
      : {}),
  });

  const orderField = SORT_FIELDS[sortBy] || "sortOrder";
  const dir = String(sortDir).toLowerCase() === "desc" ? "desc" : "asc";
  const pg = Math.max(1, Number(page) || 1);
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));

  const [total, rows] = await Promise.all([
    prisma.payrollRule.count({ where }),
    prisma.payrollRule.findMany({
      where,
      orderBy: [{ [orderField]: dir }, { id: "asc" }],
      skip: (pg - 1) * size,
      take: size,
    }),
  ]);

  return { items: rows.map(toRow), total, page: pg, pageSize: size };
}

export async function getPayrollRule({ tenantId, id }) {
  const ruleId = toIntOrNull(id);
  if (ruleId == null) throw badRequest("id is required");
  const row = await prisma.payrollRule.findFirst({ where: scopedWhere(tenantId, { id: ruleId }) });
  if (!row) throw notFound(`Payroll rule ${id} not found`);
  return toRow(row);
}
