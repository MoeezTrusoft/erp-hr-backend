// O-05 — gathers the rows for lib/opsHealth.js. Read-only, tenant-scoped.
import prisma from "../lib/prisma.js";
import { evaluateHealth, THRESHOLDS } from "../lib/opsHealth.js";
import { openRequestWhere } from "../lib/openAnomalyRequests.js";

const LOOKBACK_DAYS = 90;

export async function opsHealth({ tenantId, now = new Date() }) {
  const t = +new Date(now);
  if (Number.isNaN(t)) throw Object.assign(new Error("now is not a valid date"), { status: 400 });
  const since = new Date(t - LOOKBACK_DAYS * 86400000);
  const [devices, anomalies, runs, heldPayslips] = await Promise.all([
    prisma.attendanceCaptureDevice.findMany({
      where: { OR: [{ tenantId }, { allowedTenantIds: { has: tenantId } }], active: true },
      select: { sn: true, name: true, active: true, lastSeenAt: true, staleAfterMinutes: true },
    }),
    prisma.attendanceAnomaly.findMany({
      where: { ...openRequestWhere(tenantId, { from: since, to: new Date(t) }), createdAt: { lt: new Date(t - THRESHOLDS.anomalyDays * 86400000) } },
      select: { id: true, createdAt: true, date: true },
    }),
    prisma.payrollRun.findMany({
      where: { tenantId, status: { notIn: ["FINALIZED", "CANCELLED"] }, periodEnd: { lt: new Date(t - THRESHOLDS.runDays * 86400000), gte: since } },
      select: { id: true, periodStart: true, periodEnd: true, status: true },
    }),
    prisma.payrollPayslip.count({ where: { tenantId, status: "HOLD", payrollRun: { status: { notIn: ["FINALIZED", "CANCELLED"] } } } }),
  ]);
  return evaluateHealth({ now: new Date(t), devices, anomalies, runs, heldPayslips });
}
