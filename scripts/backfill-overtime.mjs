// scripts/backfill-overtime.mjs — mock OvertimeRequest rows so the overtime
// history/shift screen has data. Idempotent (no-op if rows exist). Company 1.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const PROJECTS = ["Platform Migration", "Q3 Release", "Client Onboarding", "Data Cleanup", "Security Audit", "Mobile App"];
const REASONS = ["Release deadline", "Production incident", "Client deliverable", "Sprint catch-up", "Month-end close"];
const STATUS = ["APPROVED", "APPROVED", "PENDING", "REJECTED"];
async function main() {
  const log = (m) => console.log(`[ot] ${m}`);

  // ---------- Maternity leave policy + balances (so leave summary has it) ----------
  const empIdsAll = (await prisma.employee.findMany({ select: { id: true } })).map((e) => e.id);
  let matPolicy = await prisma.leavePolicy.findFirst({ where: { name: "Maternity Leave" } });
  if (!matPolicy) {
    matPolicy = await prisma.leavePolicy.create({ data: { name: "Maternity Leave", leaveTypeCode: "ML", createdById: empIdsAll[0], tenantId: TENANT } });
    log("created Maternity Leave policy");
  }
  if ((await prisma.leaveBalance.count({ where: { leavePolicyId: matPolicy.id } })) === 0) {
    for (const eid of empIdsAll.slice(0, 20)) await prisma.leaveBalance.create({ data: { employeeId: eid, leavePolicyId: matPolicy.id, balance: 90, tenantId: TENANT } });
    log("created 20 maternity balances (90 days)");
  }

  const existing = await prisma.overtimeRequest.count({ where: { tenantId: TENANT } });
  if (existing > 0) { log(`overtime requests present (${existing}) — skip`); return; }
  const emps = empIdsAll.slice(0, 40);
  let n = 0;
  for (let i = 0; i < 60; i++) {
    const status = pick(STATUS);
    await prisma.overtimeRequest.create({ data: {
      employeeId: pick(emps), date: daysAgo(rnd(60)), hours: 1 + rnd(4),
      project: pick(PROJECTS), reason: pick(REASONS),
      approverId: status === "PENDING" ? null : pick(emps),
      status, decidedAt: status === "PENDING" ? null : daysAgo(rnd(30)), tenantId: TENANT,
    } });
    n++;
  }
  log(`created ${n} overtime requests`);
}
mcpCtx.run({ user: { tenantId: TENANT } }, () => { main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => { console.error("OT ERR:", e); await prisma.$disconnect(); process.exit(1); }); });
