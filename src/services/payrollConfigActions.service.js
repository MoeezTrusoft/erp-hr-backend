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
import { getAttendancePolicy } from "./attendancePolicyConfig.service.js";
import { listDeductionRules } from "./attendanceDeductionRule.service.js";
import { listApprovalLevels } from "./attendanceApprovalLevel.service.js";
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
  const meta = await prisma.payrollConfigMeta.findUnique({ where: { tenantId } });

  // Derive hasUnpublished: no published snapshot yet, OR any config row is DRAFT.
  // HR-ATT-POLICY-01: the three attendance tables MUST be counted here too —
  // otherwise editing only attendance config leaves hasUnpublished false and the
  // screen reports nothing to publish while the changes sit unpublished.
  const [
    publishedSnapshots,
    draftComponent,
    draftCalendar,
    draftRules,
    draftAttendancePolicy,
    draftDeductionRules,
    draftApprovalLevels,
  ] = await Promise.all([
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
    prisma.attendancePolicyConfig.count({
      where: scopedWhere(tenantId, { status: "DRAFT" }),
    }),
    prisma.attendanceDeductionRule.count({
      where: scopedWhere(tenantId, { status: "DRAFT" }),
    }),
    prisma.attendanceApprovalLevel.count({
      where: scopedWhere(tenantId, { status: "DRAFT" }),
    }),
  ]);

  const hasUnpublished =
    publishedSnapshots === 0 ||
    draftComponent > 0 ||
    draftCalendar > 0 ||
    draftRules > 0 ||
    draftAttendancePolicy > 0 ||
    draftDeductionRules > 0 ||
    draftApprovalLevels > 0;

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
  const [
    salaryComponents,
    grades,
    taxSlabs,
    calendar,
    approvalMatrix,
    payRules,
    // HR-ATT-POLICY-01 — attendance config is part of the published set. A
    // payroll run records the snapshot version it used, so the thresholds and
    // deduction rules that produced a payslip stay reconstructable.
    attendancePolicy,
    attendanceDeductionRules,
    attendanceApprovalLevels,
  ] = await Promise.all([
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
      getAttendancePolicy({ tenantId }),
      listDeductionRules({ tenantId }),
      listApprovalLevels({ tenantId }),
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
    attendancePolicy,
    attendanceDeductionRules,
    attendanceApprovalLevels,
  };
}

// ── PUBLISH ─────────────────────────────────────────────────────────────────
export async function publishConfig({ tenantId, publishedById }) {
  const result = await tenantTransaction(prisma, async (tx) => {
    // 1. Assemble the full current config (reads run under the tx tenant GUC).
    const config = await buildConfigObjectTx(tx, tenantId);

    // 2. Next version = current publishedVersion + 1.
    const meta = await tx.payrollConfigMeta.findUnique({ where: { tenantId } });
    const version = (meta?.publishedVersion ?? 0) + 1;
    const publishedAt = new Date();

    // 3. Immutable snapshot of the config set.
    const snapshot = await tx.payrollConfigSnapshot.create({
      data: { tenantId, version, config, publishedById: publishedById ?? null, publishedAt },
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
      // HR-ATT-POLICY-01 — attendance config publishes with the rest of the set.
      tx.attendancePolicyConfig.updateMany({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
        data: { status: "PUBLISHED" },
      }),
      tx.attendanceDeductionRule.updateMany({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
        data: { status: "PUBLISHED" },
      }),
      tx.attendanceApprovalLevel.updateMany({
        where: scopedWhere(tenantId, { status: "DRAFT" }),
        data: { status: "PUBLISHED" },
      }),
    ]);

    // 5. Upsert the meta row (create if none).
    await tx.payrollConfigMeta.upsert({
      where: { tenantId },
      update: {
        status: "PUBLISHED",
        publishedVersion: version,
        hasUnpublished: false,
        publishedAt,
        publishedById: publishedById ?? null,
      },
      create: {
        tenantId,
        status: "PUBLISHED",
        publishedVersion: version,
        hasUnpublished: false,
        publishedAt,
        publishedById: publishedById ?? null,
      },
    });

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
  const [
    salaryComponents,
    grades,
    taxSlabs,
    calendar,
    approvalMatrix,
    payRules,
    // HR-ATT-POLICY-01 — must mirror buildConfigObject(). This tx-scoped twin is
    // what the published snapshot is actually built from, so anything added
    // there and not here would be silently absent from every snapshot.
    attendancePolicy,
    attendanceDeductionRules,
    attendanceApprovalLevels,
  ] = await Promise.all([
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
      tx.attendancePolicyConfig.findFirst({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ id: "asc" }],
      }),
      tx.attendanceDeductionRule.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ ruleKey: "asc" }],
      }),
      tx.attendanceApprovalLevel.findMany({
        where: scopedWhere(tenantId, {}),
        orderBy: [{ level: "asc" }, { id: "asc" }],
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
    attendancePolicy: attendancePolicy ?? null,
    attendanceDeductionRules,
    attendanceApprovalLevels,
  };
}

// ── EXPORT ──────────────────────────────────────────────────────────────────
export async function exportConfig({ tenantId, version }) {
  const wanted = toIntOrNull(version);

  if (wanted != null) {
    const snap = await prisma.payrollConfigSnapshot.findUnique({
      where: { tenantId_version: { tenantId, version: wanted } },
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
