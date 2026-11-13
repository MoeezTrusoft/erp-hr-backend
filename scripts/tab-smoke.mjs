// scripts/tab-smoke.mjs — exercises every tab aggregator query against a real DB
// (catches wrong field/relation names). Cross-service tabs fail-soft.
import { randomUUID } from "node:crypto";
import prisma from "../src/lib/prisma.js";
import { createEmployee } from "../src/services/hrContract.service.js";
import { getEmployeeProfileTab, PROFILE_TABS } from "../src/services/employeeProfileTabs.service.js";

const TENANT = randomUUID();
let PASS = 0, FAIL = 0;
const ok = (c, l, d = "") => (c ? (PASS++, console.log("  ✓", l)) : (FAIL++, console.error("  ✗", l, d)));
const created = { employeeId: null, gradeLevelId: null };

async function main() {
  const res = await createEmployee(
    { firstName: "Tab", middleName: "T", lastName: "Smoke", workEmail: `tab.${Date.now()}@ex.com`, jobTitle: "Eng",
      bankName: "Meezan", accountNumber: "0001112223334", ntn: "1112223-4" },
    null, { tenantId: TENANT });
  const id = res?.summary?.id;
  created.employeeId = id;
  ok(Number.isFinite(id), "employee created");

  // Minimal seed so job_and_comp has comp + an allowance.
  const grade = await prisma.gradeLevel.create({ data: { name: "G7", tenantId: TENANT } });
  created.gradeLevelId = grade.id;
  await prisma.employee.update({ where: { id }, data: { gradeLevelId: grade.id } });
  await prisma.employmentTerms.create({ data: { tenantId: TENANT, employeeId: id, baseSalary: 300000, currency: "PKR", payFrequency: "MONTHLY", effectiveFrom: new Date("2025-07-01"), equity: "1000 RSUs" } });
  const et = await prisma.payrollEarningType.create({ data: { tenantId: TENANT, code: `HRA_${Date.now()}`, name: "House Allowance" } });
  await prisma.payrollAssignment.create({ data: { tenantId: TENANT, employeeId: id, earningTypeId: et.id, amount: 50000, isActive: true, effectiveFrom: new Date("2025-07-01") } });
  await prisma.recognition.create({ data: { employeeId: id, title: "Star Performer", category: "Award", tenantId: TENANT } });

  // Call every tab; assert header + data + no throw.
  for (const tab of PROFILE_TABS) {
    try {
      const out = await getEmployeeProfileTab(id, TENANT, { tab, showSensitive: true, taxFiscalYear: "FY26" });
      ok(out?.tab === tab && out?.header?.employeeId === id && out?.data != null, `tab '${tab}' returns header+data`);
    } catch (e) {
      ok(false, `tab '${tab}' threw`, e.message);
    }
  }

  // Spot-check a few derived fields.
  const jc = await getEmployeeProfileTab(id, TENANT, { tab: "job_and_comp", showSensitive: true });
  ok(jc.data?.ctc?.basicSalary === 300000, "job_and_comp basic salary", JSON.stringify(jc.data?.ctc?.basicSalary));
  ok(jc.data?.ctc?.annualCTC === (300000 + 50000) * 12, "job_and_comp CTC computed", JSON.stringify(jc.data?.ctc?.annualCTC));
  ok(jc.data?.ctc?.equity === "1000 RSUs", "job_and_comp equity DECRYPTED", JSON.stringify(jc.data?.ctc?.equity));
  ok(jc.header?.payGrade === "G7", "header pay grade");
  const perf = await getEmployeeProfileTab(id, TENANT, { tab: "performance", showSensitive: true });
  ok(perf.data?.recognition?.count === 1, "performance recognition count", JSON.stringify(perf.data?.recognition?.count));
  const act = await getEmployeeProfileTab(id, TENANT, { tab: "activity", showSensitive: true });
  ok(act.data?.available === false, "activity fail-soft (RBAC unreachable)", JSON.stringify(act.data?.available));
  const ov = await getEmployeeProfileTab(id, TENANT, { tab: "overview", showSensitive: true });
  ok(ov.data?.projects?.available === false, "overview projects fail-soft (PM unreachable)");

  console.log(`\n[tab-smoke] PASS=${PASS} FAIL=${FAIL}`);
}

async function cleanup() {
  const id = created.employeeId;
  if (!id) return;
  await prisma.payrollAssignment.deleteMany({ where: { employeeId: id } }).catch(() => {});
  await prisma.payrollEarningType.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
  await prisma.employmentTerms.deleteMany({ where: { employeeId: id } }).catch(() => {});
  await prisma.recognition.deleteMany({ where: { employeeId: id } }).catch(() => {});
  await prisma.bankDetail.deleteMany({ where: { employeeId: id } }).catch(() => {});
  await prisma.log.deleteMany({ where: { OR: [{ employeeId: id }, { actionById: id }] } }).catch(() => {});
  await prisma.outboxEvent.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
  await prisma.employee.update({ where: { id }, data: { gradeLevelId: null } }).catch(() => {});
  if (created.gradeLevelId) await prisma.gradeLevel.deleteMany({ where: { id: created.gradeLevelId } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { id } }).catch(() => {});
  console.log("[cleanup] done");
}

let code = 0;
try { await main(); if (FAIL) code = 1; } catch (e) { console.error("ERR", e); code = 1; } finally { await cleanup(); await prisma.$disconnect(); }
process.exit(code);
