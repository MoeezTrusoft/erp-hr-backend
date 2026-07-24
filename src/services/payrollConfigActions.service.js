// src/services/payrollConfigActions.service.js
//
// Payroll Setup → Global KPIs + Actions (Publish / Export). Assembles the whole
// tenant config set, publishes it (immutable snapshot + DRAFT→PUBLISHED flip +
// meta bump), and exports a snapshot (or the live config when nothing is
// published yet). Every read folds the verified tenant via
// scopedWhere(tenantId, where); Employee counts use scopedEmployeeWhere (the
// Employee table scopes on snake_case tenant_id). The publish path is a single
// tenantTransaction so the FORCE-RLS tenant GUC covers every write.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getPayrollRules } from "./payrollRuleConfig.service.js";
import logger from "../lib/logger.js";

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function toIntOrNull(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ── GLOBAL KPIs ─────────────────────────────────────────────────────────────
export async function getGlobalKpis({ tenantId }) {
  const [activeEmployees, totalPayComponents, approvalRows] = await Promise.all([
    // Employee has string status fields (status / employement_status) — count
    // the active ones. tenant scoping uses the snake_case tenant_id column.
    prisma.employee.count({
      where: scopedEmployeeWhere(tenantId, {
        OR: [{ status: "Active" }, { employement_status: "Active" }],
      }),
    }),
    prisma.salaryComponent.count({
      where: scopedWhere(tenantId, { active: true }),
    }),
    // DISTINCT approval levels among ACTIVE approval-matrix rows.
    prisma.payrollApprovalMatrix.findMany({
      where: scopedWhere(tenantId, { status: "ACTIVE" }),
      distinct: ["level"],
      select: { level: true },
    }),
  ]);

  return {
    activeEmployees,
    totalPayComponents,
    approvalLevels: approvalRows.length,
  };
}

// ── CONFIG STATUS ───────────────────────────────────────────────────────────
export async function getConfigStatus({ tenantId }) {
  const meta = await prisma.payrollConfigMeta.findFirst({
    where: scopedWhere(tenantId, {}),
    orderBy: [{ id: "asc" }],
  });

  // Derive hasUnpublished: no published snapshot yet, OR any config row is DRAFT.
  const [publishedSnapshots, draftComponent, draftCalendar, draftRules] =
    await Promise.all([
      prisma.payrollConfigSnapshot.count({ where: scopedWhere(tenantId, {}) }),
      prisma.salaryComponent.count({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
      }),
      prisma.payrollCalendar.count({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
      }),
      prisma.payrollRuleConfig.count({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
      }),
    ]);

  const hasUnpublished =
    publishedSnapshots === 0 ||
    draftComponent > 0 ||
    draftCalendar > 0 ||
    draftRules > 0;

  return {
    status: meta?.status ?? "DRAFT",
    publishedVersion: meta?.publishedVersion ?? 0,
    draftVersion: meta?.draftVersion ?? 1,
    hasUnpublished,
    publishedAt: meta?.publishedAt ?? null,
  };
}

// ── FULL CONFIG OBJECT (publish + export) ───────────────────────────────────
export async function buildConfigObject({ tenantId }) {
  const [salaryComponents, grades, taxSlabs, calendar, approvalMatrix, payRules] =
    await Promise.all([
      prisma.salaryComponent.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      }),
      prisma.gradeLevel.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ name: "asc" }],
      }),
      prisma.taxRate.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ effectiveFrom: "asc" }, { bracketMin: "asc" }],
      }),
      prisma.payrollCalendar.findFirst({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ id: "asc" }],
      }),
      prisma.payrollApprovalMatrix.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ level: "asc" }, { id: "asc" }],
      }),
      getPayrollRules({ tenantId }),
    ]);

  const gradeBands = grades.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    minSalary: g.minSalary ?? null,
    midSalary: g.midSalary ?? null,
    maxSalary: g.maxSalary ?? null,
    bandCurrency: g.bandCurrency ?? null,
  }));

  return {
    salaryComponents,
    gradeBands,
    taxSlabs,
    calendar: calendar ?? null,
    approvalMatrix,
    payRules,
  };
}

// ── PUBLISH ─────────────────────────────────────────────────────────────────
export async function publishConfig({ tenantId, publishedById }) {
  const result = await tenantTransaction(prisma, async (tx) => {
    // 1. Assemble the full current config (reads run under the tx tenant GUC).
    const config = await buildConfigObjectTx(tx, tenantId);

    // 2. Next version = current publishedVersion + 1.
    const meta = await tx.payrollConfigMeta.findFirst({
      where: scopedWhere(tenantId, {}),
      orderBy: [{ id: "asc" }],
    });
    const version = (meta?.publishedVersion ?? 0) + 1;
    const publishedAt = new Date();

    // 3. Immutable snapshot of the config set.
    const snapshot = await tx.payrollConfigSnapshot.create({
      data: { version, config, publishedById: publishedById ?? null, publishedAt },
    });

    // 4. Flip every DRAFT config row → PUBLISHED.
    const [comp] = await Promise.all([
      tx.salaryComponent.updateMany({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
        data: { status: "PUBLISHED" },
      }),
      tx.payrollCalendar.updateMany({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
        data: { status: "PUBLISHED" },
      }),
      tx.payrollRuleConfig.updateMany({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
        data: { status: "PUBLISHED" },
      }),
    ]);

    // 5. Upsert the meta row (create if none).
    if (meta) {
      await tx.payrollConfigMeta.update({
        where: { id: meta.id },
        data: {
          status: "PUBLISHED",
          publishedVersion: version,
          hasUnpublished: false,
          publishedAt,
          publishedById: publishedById ?? null,
        },
      });
    } else {
      await tx.payrollConfigMeta.create({
        data: {
          status: "PUBLISHED",
          publishedVersion: version,
          hasUnpublished: false,
          publishedAt,
          publishedById: publishedById ?? null,
        },
      });
    }

    return {
      version,
      publishedAt,
      componentsPublished: comp.count,
      snapshotId: snapshot.id,
    };
  });

  logger.info(
    { version: result.version, snapshotId: result.snapshotId },
    "payroll config published"
  );
  return result;
}

// Transaction-bound twin of buildConfigObject: same assembly, but every read
// runs on the passed tx client so it shares the publish tenant GUC.
async function buildConfigObjectTx(tx, tenantId) {
  const [salaryComponents, grades, taxSlabs, calendar, approvalMatrix, payRules] =
    await Promise.all([
      tx.salaryComponent.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      }),
      tx.gradeLevel.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ name: "asc" }],
      }),
      tx.taxRate.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ effectiveFrom: "asc" }, { bracketMin: "asc" }],
      }),
      tx.payrollCalendar.findFirst({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ id: "asc" }],
      }),
      tx.payrollApprovalMatrix.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ level: "asc" }, { id: "asc" }],
      }),
      tx.payrollRuleConfig.findFirst({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ id: "asc" }],
      }),
    ]);

  const gradeBands = grades.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    minSalary: g.minSalary ?? null,
    midSalary: g.midSalary ?? null,
    maxSalary: g.maxSalary ?? null,
    bandCurrency: g.bandCurrency ?? null,
  }));

  return {
    salaryComponents,
    gradeBands,
    taxSlabs,
    calendar: calendar ?? null,
    approvalMatrix,
    payRules: payRules ?? null,
  };
}

// ── EXPORT ──────────────────────────────────────────────────────────────────
export async function exportConfig({ tenantId, version }) {
  const wanted = toIntOrNull(version);

  if (wanted != null) {
    const snap = await prisma.payrollConfigSnapshot.findFirst({
      where: scopedWhere(tenantId, { version: wanted }),
    });
    if (!snap) throw notFound(`Payroll config snapshot version ${version} not found`);
    return { version: snap.version, publishedAt: snap.publishedAt, config: snap.config };
  }

  const latest = await prisma.payrollConfigSnapshot.findFirst({
    where: scopedWhere(tenantId, {}),
    orderBy: [{ version: "desc" }],
  });
  if (latest) {
    return { version: latest.version, publishedAt: latest.publishedAt, config: latest.config };
  }

  // No snapshots yet — export the live config set.
  const config = await buildConfigObject({ tenantId });
  return { version: null, publishedAt: null, config };
}
