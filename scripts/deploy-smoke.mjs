// scripts/deploy-smoke.mjs — REQ-HR-DEPLOY-HARDENING-2026-09-02 §3a.
//
// The blocking post-deploy check. "The pod is Ready" is not a deployment
// verification: /readyz stayed green throughout the window in which the gitops
// manifest carried no HR_ATTENDANCE_INTAKE_KEY, which would have 403'd the
// biometric device silently until HR noticed a missing day of punches.
//
// So this asserts the things that actually break:
//   1. the process is up
//   2. the intake guard REJECTS a bad key   (guard is wired, not bypassed)
//   3. the intake route ACCEPTS the real key (the key is actually present)
//   4. a tenant-scoped config read returns the stored row, not the defaults
//      (RLS_MODELS omissions read back as "unconfigured" with no error — that
//      shipped once already: grace was written as 15 and read back as 0)
//
// Exit code is the contract: non-zero means roll back.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { getAttendancePolicy } from "../src/services/attendancePolicyConfig.service.js";

const BASE = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const KEY = process.env.HR_ATTENDANCE_INTAKE_KEY;
const TENANT = process.env.HR_ATTENDANCE_INTAKE_TENANT_ID;

// Matches no employee, so intake stores the raw punch and resolves nothing —
// no Attendance row is written and no real person is touched.
const SMOKE_DEVICE_ID = "SMOKE0";
const SMOKE_ROW = `${SMOKE_DEVICE_ID}\t2000-01-01 00:00:00\t0\t15\t0`;

let PASS = 0;
let FAIL = 0;
const ok = (cond, label, detail = "") =>
    cond ? (PASS++, console.log("  ✓", label)) : (FAIL++, console.error("  ✗", label, detail));

async function post(body, headers = {}) {
    const res = await fetch(`${BASE}/device-attendance/iclock-ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
    console.log(`deploy smoke → ${BASE}`);

    if (!KEY) ok(false, "HR_ATTENDANCE_INTAKE_KEY is set", "missing from the environment");
    if (!TENANT) ok(false, "HR_ATTENDANCE_INTAKE_TENANT_ID is set", "missing from the environment");
    if (!KEY || !TENANT) return;

    for (const path of ["/healthz", "/readyz"]) {
        const res = await fetch(`${BASE}${path}`).catch((err) => ({ status: `unreachable: ${err.message}` }));
        ok(res.status === 200, `GET ${path} → 200`, res.status);
    }

    // A route that 200s without a key is worse than one that 403s with a good
    // key: it means the guard is gone and anyone in the cluster can inject
    // attendance. Check the negative before the positive.
    const noKey = await post({ sn: "SMOKE", rows: [SMOKE_ROW] });
    ok(noKey.status === 403, "intake without a key → 403", noKey.status);

    const badKey = await post({ sn: "SMOKE", rows: [SMOKE_ROW] }, { "X-Intake-Key": `${KEY}-wrong` });
    ok(badKey.status === 403, "intake with a wrong key → 403", badKey.status);

    const good = await post({ sn: "SMOKE", rows: [SMOKE_ROW] }, { "X-Intake-Key": KEY });
    ok(good.status === 200, "intake with the real key → 200", `${good.status} ${good.body?.message || ""}`);
    ok(good.body?.summary?.rawStored === 1, "the punch was stored", JSON.stringify(good.body?.summary));

    // Reads the row back through the RLS extension the same way the app does.
    // id === null is the service's "no row saved" sentinel, which is exactly
    // what a missing RLS_MODELS entry looks like from the outside.
    await mcpCtx.run({ user: { tenantId: TENANT } }, async () => {
        const policy = await getAttendancePolicy({ tenantId: TENANT });
        ok(policy?.id != null, "attendance policy reads back for the intake tenant", "got the unsaved defaults");
    });
}

try {
    await main();
} catch (err) {
    FAIL++;
    console.error("  ✗ smoke threw:", err?.message);
} finally {
    // The await MUST be inside the callback. Returning the PrismaPromise out of
    // mcpCtx.run hands back an un-executed query, the store unwinds, and the
    // delete then runs with no tenant context — HR-4030. See
    // tests/unit/HR-ATT-DEVICE-INTAKE-03.lazy-context.test.js.
    await mcpCtx
        .run({ system: true }, async () => {
            return await prisma.attendanceDevicePunch.deleteMany({
                where: { deviceUserId: SMOKE_DEVICE_ID },
            });
        })
        .then((r) => console.log(`  cleanup: removed ${r?.count ?? 0} smoke punch(es)`))
        .catch((err) => console.error("  ✗ cleanup failed:", err?.message));
    await prisma.$disconnect().catch(() => {});
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
