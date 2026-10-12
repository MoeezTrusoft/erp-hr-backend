// Deployment smoke for the registered-device, durable attendance intake.
// Creates only an unassigned synthetic event. Retains its audit, dismisses the
// event and deactivates the temporary device; never modifies employee attendance.
import { randomUUID } from "node:crypto";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { getAttendancePolicy } from "../src/services/attendancePolicyConfig.service.js";
import { registerCaptureDevice, reviewCaptureEvents, updateCaptureDevice } from "../src/services/attendanceCapture.service.js";

const BASE = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;
const TENANT = process.env.HR_ATTENDANCE_INTAKE_TENANT_ID;
const ACTOR = "attendance-release-smoke";
const serial = `SMOKE-${randomUUID()}`;
const deviceUserId = `UNASSIGNED-${randomUUID()}`;
let device, receiptId, passed = 0, failed = 0;
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
  const key = `smoke-${randomUUID()}`;
  const accepted = await post(registered.credential, key);
  receiptId = accepted.body?.summary?.receiptId;
  check(accepted.status === 202, "registered device receipt accepted with 202");
  check(accepted.body?.summary?.stored === 1 && !!receiptId, "one durable event stored");
  if (!receiptId) throw new Error("No durable receipt was returned");
  const duplicate = await post(registered.credential, key);
  check(duplicate.status === 202 && duplicate.body?.summary?.replayed === true && duplicate.body?.summary?.receiptId === receiptId, "identical retry reuses receipt");
  const events = await prisma.attendanceCaptureEvent.findMany({ where: { tenantId: TENANT, receiptId } });
  check(events.length === 1 && events[0].employeeId === null && events[0].state === "NEEDS_REVIEW", "synthetic identity is held without employee attribution");
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
      if (receiptId) {
        const events = await prisma.attendanceCaptureEvent.findMany({ where: { tenantId: TENANT, receiptId } });
        if (events.length && events.every((event) => event.employeeId === null && ["NEEDS_REVIEW", "FAILED"].includes(event.state))) {
          await reviewCaptureEvents({ tenantId: TENANT, actorId: ACTOR, items: events.map(({ id, version }) => ({ id, version })), action: "DISMISS", reason: "Deployment smoke: synthetic unassigned evidence, no employee attendance" });
        } else { throw new Error("Unexpected smoke event state; preserve evidence for review"); }
      }
    } catch (error) { failed++; console.error("FAIL smoke dismissal:", error.message); }
    try {
      if (device) await updateCaptureDevice({ tenantId: TENANT, actorId: ACTOR, id: device.id, active: false, reason: "Deployment smoke complete; temporary device deactivated" });
    } catch (error) { failed++; console.error("FAIL smoke device cleanup:", error.message); }
  }
});
await prisma.$disconnect();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
