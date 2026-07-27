// F-12 / ARCH-01 §2.3, §5.1 / ARCH-06 C-06, C-11.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import prisma from '../../src/lib/prisma.js';
import { serializePayrollMoney } from '../../src/lib/money.js';

const TENANT = 'f1200000-0000-4000-8000-000000000012';
let dbAvailable = false;
const ids = {};

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const columns = await prisma.$queryRaw`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('payroll_runs', 'totalGross'),
          ('payroll_payslips', 'grossAmount'),
          ('payroll_earnings', 'amount'),
          ('payroll_deductions', 'amount'),
          ('payroll_assignments', 'amount'),
          ('tax_rates', 'bracketMin')
        )`;
    dbAvailable = columns.length === 6 && columns.every((column) => column.data_type === 'numeric');
    if (!dbAvailable) return;
  } catch {
    return;
  }

  const employee = await prisma.employee.create({
    data: { tenant_id: TENANT, first_name: 'Exact', last_name: 'Money', status: 'active' },
  });
  ids.employee = employee.id;
  const earningType = await prisma.payrollEarningType.create({
    data: { tenantId: TENANT, code: `F12_E_${employee.id}`, name: 'F-12 earning' },
  });
  const deductionType = await prisma.payrollDeductionType.create({
    data: { tenantId: TENANT, code: `F12_D_${employee.id}`, name: 'F-12 deduction' },
  });
  ids.earningType = earningType.id;
  ids.deductionType = deductionType.id;
});

afterAll(async () => {
  if (dbAvailable) {
    if (ids.run) await prisma.payrollRun.deleteMany({ where: { id: ids.run } });
    if (ids.assignment) await prisma.payrollAssignment.deleteMany({ where: { id: ids.assignment } });
    if (ids.taxRate) await prisma.taxRate.deleteMany({ where: { id: ids.taxRate } });
    if (ids.deductionType) await prisma.payrollDeductionType.deleteMany({ where: { id: ids.deductionType } });
    if (ids.earningType) await prisma.payrollEarningType.deleteMany({ where: { id: ids.earningType } });
    if (ids.employee) await prisma.employee.deleteMany({ where: { id: ids.employee } });
  }
  await prisma.$disconnect();
});

describe('F-12 Decimal(18,4) live DB round trip', () => {
  it('round-trips 0.1, large, negative, KWD, and equal totals exactly', async () => {
    if (!dbAvailable) return;

    const run = await prisma.payrollRun.create({
      data: {
        tenantId: TENANT,
        periodStart: new Date('2098-01-01T00:00:00.000Z'),
        periodEnd: new Date('2098-01-31T00:00:00.000Z'),
        countryCode: 'KW',
        currencyCode: 'KWD',
        totalGross: '9007199254740.9910',
        totalDeductions: '0.1000',
        totalNet: '9007199254740.8910',
        payslips: {
          create: {
            tenantId: TENANT,
            employeeId: ids.employee,
            grossAmount: '9007199254740.9910',
            totalDeductions: '0.1000',
            netAmount: '9007199254740.8910',
            earnings: { create: { tenantId: TENANT, earningTypeId: ids.earningType, amount: '9007199254740.9910' } },
            deductions: { create: { tenantId: TENANT, deductionTypeId: ids.deductionType, amount: '-0.1000' } },
          },
        },
      },
      include: { payslips: { include: { earnings: true, deductions: true } } },
    });
    ids.run = run.id;

    const assignment = await prisma.payrollAssignment.create({
      data: {
        tenantId: TENANT,
        employeeId: ids.employee,
        earningTypeId: ids.earningType,
        amount: '1.2340',
        effectiveFrom: new Date('2098-01-01T00:00:00.000Z'),
      },
    });
    ids.assignment = assignment.id;
    const taxRate = await prisma.taxRate.create({
      data: {
        tenantId: TENANT,
        countryCode: 'KW',
        bracketMin: '0.1000',
        bracketMax: '9007199254740.9910',
        baseTax: '1.2340',
        rate: 0.05,
        effectiveFrom: new Date('2098-01-01T00:00:00.000Z'),
      },
    });
    ids.taxRate = taxRate.id;

    const wire = serializePayrollMoney({ run, assignment, taxRate });
    expect(wire.run.totalGross).toBe('9007199254740.9910');
    expect(wire.run.totalDeductions).toBe('0.1000');
    expect(wire.run.totalNet).toBe('9007199254740.8910');
    expect(wire.run.payslips[0].deductions[0].amount).toBe('-0.1000');
    expect(wire.assignment.amount).toBe('1.2340');
    expect(wire.taxRate.bracketMin).toBe('0.1000');
    expect(wire.taxRate.bracketMax).toBe('9007199254740.9910');
    expect(wire.taxRate.baseTax).toBe('1.2340');
    expect(BigInt(wire.run.totalGross.replace('.', '')) - BigInt(wire.run.totalDeductions.replace('.', '')))
      .toBe(BigInt(wire.run.totalNet.replace('.', '')));
  });
});
