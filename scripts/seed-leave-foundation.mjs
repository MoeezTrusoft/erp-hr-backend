// C1+C2 — leave foundation seed (idempotent; run inside the erp-hr-backend pod).
//
// Production truth before this script: leave_policies = 0, leave_balances = 0.
// The Leave Management screen therefore rendered an empty table forever, and
// every leave approval would have died on the balance decrement (fixed
// separately by the C5 guard, but a missing balance still shows a negative
// balance instead of a proper entitlement).
//
// What this seeds, per tenant (operator proposal 2026-09-18, pending HR
// correction — adjust POLICIES and re-run; the script never overwrites an
// existing policy's entitlement or an existing balance):
//   ANNUAL 14 · SICK 10 · CASUAL 12 · MATERNITY 90 (accrue ANNUALLY)
//   OTHER 0 · UNPAID 0 (accrue NONE — HR-discretion / payroll-LWP types)
// Balances are seeded (balance = accrualRate) ONLY for accruing policies and
// ONLY for currently ACTIVE employees.
//
// Usage:
//   kubectl exec -n erp-svc deployment/erp-hr-backend -- \
//     node /app/scripts/seed-leave-foundation.mjs [--dry-run]
import { mcpCtx } from '../src/mcp/context.js';

const DRY = process.argv.includes('--dry-run');

// Policy catalogue: leaveTypeCode → [policy name, accrualRate, accrualPeriod].
const POLICIES = [
  ['ANNUAL', 'Annual Leave', 14, 'ANNUAL'],
  ['SICK', 'Sick Leave', 10, 'ANNUAL'],
  ['CASUAL', 'Casual Leave', 12, 'ANNUAL'],
  ['MATERNITY', 'Maternity / Paternity Leave', 90, 'ANNUAL'],
  ['OTHER', 'Other Leave', 0, 'NONE'],
  ['UNPAID', 'Unpaid Leave (LWP)', 0, 'NONE'],
];

await mcpCtx.run({ system: true }, async () => {
  const { default: prisma } = await import('../src/lib/prisma.js');
  const { tenantData } = await import('../src/lib/tenancy.js');

  const tenants = await prisma.employee.findMany({
    where: { tenant_id: { not: null } },
    distinct: ['tenant_id'],
    select: { tenant_id: true },
  });
  console.log(`Tenants found: ${tenants.length}`);

  let policiesCreated = 0;
  let policiesKept = 0;
  let balancesCreated = 0;
  let balancesKept = 0;

  for (const { tenant_id: tenantId } of tenants) {
    console.log(`\n── Tenant ${tenantId}`);

    const policyIdByCode = new Map();

    for (const [code, name, rate, period] of POLICIES) {
      const existing = await prisma.leavePolicy.findFirst({
        where: { tenantId, name },
        select: { id: true, accrualRate: true, leaveTypeCode: true },
      });

      if (existing) {
        // Never clobber an HR-edited entitlement; only backfill a missing code.
        policyIdByCode.set(code, existing.id);
        policiesKept += 1;
        if (!existing.leaveTypeCode) {
          if (!DRY) {
            await prisma.leavePolicy.update({
              where: { id: existing.id },
              data: { leaveTypeCode: code },
            });
          }
          console.log(`   policy "${name}" kept (backfilled typeCode=${code})`);
        } else {
          console.log(`   policy "${name}" kept`);
        }
        continue;
      }

      if (!DRY) {
        const created = await prisma.leavePolicy.create({
          data: tenantData(tenantId, {
            name,
            description: `${name} — seeded default (operator proposal 2026-09-18; HR may edit)`,
            leaveTypeCode: code,
            accrualRate: rate,
            accrualPeriod: period,
            carryForwardAllowed: false,
            maxCarryForward: 0,
            minServiceMonths: 0,
            active: true,
          }),
        });
        policyIdByCode.set(code, created.id);
      }
      policiesCreated += 1;
      console.log(`   policy "${name}" (${code}, ${rate}d/${period}) ${DRY ? '[dry] created' : 'created'}`);
    }

    if (DRY) {
      console.log('   balances: skipped in dry-run (policy ids not materialized)');
      continue;
    }

    const employees = await prisma.employee.findMany({
      where: { tenant_id: tenantId, employement_status: 'Active' },
      select: { id: true },
    });

    for (const emp of employees) {
      for (const [code, , rate] of POLICIES) {
        const policyId = policyIdByCode.get(code);
        if (!policyId || rate <= 0) continue; // no balance row for 0-entitlement types

        const existing = await prisma.leaveBalance.findUnique({
          where: { employeeId_leavePolicyId: { employeeId: emp.id, leavePolicyId: policyId } },
          select: { balance: true },
        });
        if (existing) {
          balancesKept += 1;
          continue;
        }
        await prisma.leaveBalance.create({
          data: tenantData(tenantId, {
            employeeId: emp.id,
            leavePolicyId: policyId,
            balance: rate,
            carryOverBalance: 0,
          }),
        });
        balancesCreated += 1;
      }
    }
    console.log(`   balances seeded for ${employees.length} active employees`);
  }

  console.log(
    `\nSUMMARY policies created=${policiesCreated} kept=${policiesKept} · ` +
      `balances created=${balancesCreated} kept=${balancesKept}${DRY ? ' (DRY RUN — nothing written)' : ''}`
  );

  await prisma.$disconnect();
});
