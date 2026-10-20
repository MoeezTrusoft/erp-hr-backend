// Deployment smoke for the registered-device attendance intake.
// Registers a temporary device, proves the intake gate refuses it (no credential,
// wrong credential, and a correctly registered device that has not been through
// the reviewed onsite acceptance workflow), then reads the schema through the
// generated client and deactivates the device. Never creates employee attendance
// and never activates a device.
import { randomUUID } from "node:crypto";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { getAttendancePolicy } from "../src/services/attendancePolicyConfig.service.js";
import { registerCaptureDevice, updateCaptureDevice } from "../src/services/attendanceCapture.service.js";

const BASE = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;
const TENANT = process.env.HR_ATTENDANCE_INTAKE_TENANT_ID;
const ACTOR = "attendance-release-smoke";
const serial = `SMOKE-${randomUUID()}`;
const deviceUserId = `UNASSIGNED-${randomUUID()}`;
let device, passed = 0, failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}`); }
}
async function post(key, requestKey) {
  const response = await fetch(`${BASE}/device-attendance/iclock-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "X-Intake-Key": key } : {}), ...(requestKey ? { "Idempotency-Key": requestKey } : {}) },
    body: JSON.stringify({ sn: serial, rows: [`${deviceUserId}\t2000-01-01 00:00:00\t0\t0\t0`] }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
async function main() {
  if (!TENANT) throw new Error("HR_ATTENDANCE_INTAKE_TENANT_ID is required");
  for (const path of ["/healthz", "/readyz"]) {
    const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15000) });
    check(response.status === 200, `${path} returns 200`);
  }
  const registered = await registerCaptureDevice({ tenantId: TENANT, actorId: ACTOR, sn: serial, name: "Deployment smoke (temporary, no employee)", timeZone: "Asia/Karachi" });
  device = registered.device;
  check((await post()).status === 403, "missing device credential rejected");
  check((await post("invalid-smoke-key")).status === 403, "incorrect device credential rejected");
  // The 202 path needs an active device, and activation became a reviewed
  // workflow (b018020) backed by a DB trigger that only an APPROVED acceptance
  // site plus its session GUC can satisfy. A deployment cannot produce that,
  // and must not: creating an approval to make a smoke pass would defeat the
  // control. So the positive case here is the refusal the guard exists for —
  // a correctly registered, unaccepted device is denied and leaves no receipt.
  const unaccepted = await post(registered.credential);
  check(unaccepted.status === 403, "registered but unaccepted device is refused");
  check(unaccepted.body?.summary?.receiptId == null, "refused intake returns no receipt");
  const policy = await getAttendancePolicy({ tenantId: TENANT });
  check(policy?.id != null, "tenant policy reads from storage");
  // Exercise generated Prisma models/columns against the deployed schema.
  for (const model of ["attendanceSetupRelease", "attendanceBiometricProfile", "attendanceSession", "attendanceEvaluationJob", "attendanceGraceRule", "attendanceGraceMembership", "attendanceManualTime", "attendanceRuleAudit", "attendancePayrollAdjustment"]) {
    await prisma[model].findFirst({ where: { tenantId: TENANT } });
  }
  check(true, "setup, biometric, evaluation and anomaly schema readable");
}
await mcpCtx.run({ system: true, user: { tenantId: TENANT } }, async () => {
  try { await main(); }
  catch (error) { failed++; console.error("FAIL smoke:", error.message); }
  finally {
    try {
      if (device) await updateCaptureDevice({ tenantId: TENANT, actorId: ACTOR, id: device.id, active: false, reason: "Deployment smoke complete; temporary device deactivated" });
    } catch (error) { failed++; console.error("FAIL smoke device cleanup:", error.message); }
  }
});
await prisma.$disconnect();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
