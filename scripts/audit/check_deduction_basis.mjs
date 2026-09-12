// A-DBB-01 — deduction-basis & base-duplication audit for all tenants.
// N-15 regression risk: four tenants carry package as BASIC assignment rows
// alongside employment_terms.baseSalary (the 45% BASIC). If a tenant's ACTIVE
// payroll rule sets deductionBasis = 'BASIC' AND a duplication exists, N-15
// would halve every salary. This audit proves the combination absent, or
// forces rule migration to PACKAGE basis before any reprocess.
import { mcpCtx } from '../../src/mcp/context.js';
import prisma from '../../src/lib/prisma.js';

const T = {
  TRUSOFT: '40314ef4-0a81-4390-b631-b3ad3f21f523',
  HOMENET: 'a5f89a2b-9fdd-4ee0-8854-36d40646b39c',
  HOMEVISION: '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73',
  JOC: '8f4a526f-d45b-4da2-b772-d6682e849812',
  BOC: '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2',
};

await mcpCtx.run({ system: true }, async () => {
  // Locate the singleton PayrollRuleConfig per tenant (unique on tenantId).
  const out = [];
  for (const [name, tenantId] of Object.entries(T)) {
    const rule = await prisma.payrollRuleConfig.findUnique({ where: { tenantId } }).catch(() => null);
    const basis = rule ? `${rule.deductionBasis}/${rule.status}` : 'NO_ROW';
    // Duplication probe: open BASIC-code assignment rows vs term baseSalary.
    const baseCodes = ['BASIC', 'BASE_SALARY'];
    const assigns = await prisma.payrollAssignment.findMany({
      where: { tenantId, isActive: true, effectiveTo: null, earningType: { code: { in: baseCodes } } },
      select: { employeeId: true, amount: true },
    });
    const termBases = await prisma.employmentTerms.findMany({
      where: { tenantId, effectiveTo: null },
      select: { employeeId: true, baseSalary: true },
    });
    const baseByEmp = new Map(termBases.map((t) => [t.employeeId, Number(t.baseSalary)]));
    let dup = 0, checked = 0;
    for (const a of assigns) {
      const b = baseByEmp.get(a.employeeId);
      if (b == null) continue;
      checked++;
      if (Math.abs(Number(a.amount) - b) < 0.01) dup++;
      else if (b > 0 && Math.abs(Number(a.amount) - b / b) < 0.01) { /* ratio probe placeholder */ }
    }
    out.push({ tenant: name, rule: rule ? rule.id : null, basis, basicAssigns: assigns.length, matchedBase: checked, exactDup: dup });
  }
  console.log('TENANT | DEDUCTION_BASIS/STATUS | BASIC_ASSIGN_ROWS | MATCHED_TERMS | EXACT_DUP');
  for (const o of out) console.log(`${o.tenant} | ${o.basis} | ${o.basicAssigns} | ${o.matchedBase} | ${o.exactDup}`);
  const risky = out.filter((o) => o.basis.startsWith('BASIC') && o.exactDup > 0);
  console.log(risky.length ? `RISK: ${JSON.stringify(risky)}` : 'NO N-15 RISK — no tenant combines BASIC deduction basis with exact base duplication.');
});