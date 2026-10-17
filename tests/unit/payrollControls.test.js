import { describe, it, expect, jest } from "@jest/globals";
import {
  payrollAssignments,
  validatePayrollConfiguration,
  employeeCode,
} from "../../src/lib/payrollConfiguration.js";
import { buildPayslipFromInputs } from "../../src/services/payrollService.js";
import {
  reservePayrollLoans,
  settlePayrollLoans,
} from "../../src/services/payrollLoans.service.js";
import { evaluateMoneyFormula } from "../../src/lib/payrollFormula.js";
import { COMPANY_PAYROLL_BANKS } from "../../src/services/payrollPayments.service.js";
import {loadSource} from '../../src/services/approval/adapters.js';
const run = {
  periodStart: new Date("2026-09-01"),
  periodEnd: new Date("2026-09-30"),
  countryCode: "PK",
  currencyCode: "PKR",
};
const term = { baseSalary: 100000, payFrequency: "MONTHLY", currency: "PKR" };
const component = {
  id: 1,
  code: "HOUSING",
  name: "Housing",
  active: true,
  type: "EARNING",
  computation: "PERCENTAGE",
  value: 10,
  sortOrder: 1,
};
describe("published payroll controls", () => {
  it('preserves legacy approval snapshots and binds line items for newly calculated payroll',async()=>{
    const row={id:1,status:'COMPLETED',processedBy:7,calculationConfigVersion:null};
    const slip={employeeId:7,grossAmount:'100',totalDeductions:'10',netAmount:'90',payableDays:30,earnings:[{earningTypeId:2,amount:'100',description:'Basic'}],deductions:[]};
    const db={payrollRun:{findFirst:async()=>row},employee:{findFirst:async()=>({id:7,employee_code:'EMP-007'})},payrollPayslip:{findMany:async()=>[structuredClone(slip)],count:async()=>0}};
    const old=await loadSource(db,{tenantId:'company'},'PAYROLL','1');
    expect(old.snapshot).not.toHaveProperty('calculationConfigVersion');
    expect(old.snapshot.payslips[0]).toEqual({employeeCode:'EMP-007',grossAmount:'100',totalDeductions:'10',netAmount:'90'});
    row.calculationConfigVersion=1;
    const current=await loadSource(db,{tenantId:'company'},'PAYROLL','1');
    slip.earnings[0].description='Changed component';
    const changed=await loadSource(db,{tenantId:'company'},'PAYROLL','1');
    expect(current.digest).not.toBe(changed.digest);
  });
  it("keeps decimal formula arithmetic exact through the currency rounding boundary", () => {
    expect(evaluateMoneyFormula("0.1 + 0.2")).toBe("0.3");
    expect(
      evaluateMoneyFormula("BASIC + 0.01", { BASIC: "99999999999999.99" }),
    ).toBe("100000000000000");
    expect(
      evaluateMoneyFormula("min(BASIC * 0.4, 5000)", { BASIC: "100000" }),
    ).toBe("5000");
    expect(() =>
      evaluateMoneyFormula("BASIC / 0", { BASIC: "100000" }),
    ).toThrow("zero");
  });
  it("uses the confirmed company bank assignments without claiming an API connection", () => {
    expect(Object.values(COMPANY_PAYROLL_BANKS)).toEqual(
      expect.arrayContaining([
        { company: "HomeNet", bank: "Faysal Bank" },
        { company: "BOC", bank: "UBL" },
        { company: "JOC", bank: "UBL" },
        { company: "TruSoft", bank: "Bank Alfalah" },
        { company: "HomeVision", bank: "Meezan Bank" },
      ]),
    );
  });
  it("uses a grade template and an explicit code override once", () => {
    const assignments = payrollAssignments({
      employee: { gradeLevelId: 3 },
      employmentTerm: term,
      payrollRun: run,
      components: [{ ...component, gradeLevelId: 3 }],
      assignments: [
        {
          earningType: { id: 4, code: "HOUSING", name: "Housing" },
          amount: "15000",
        },
      ],
    });
    expect(assignments).toHaveLength(1);
    expect(
      Number(
        buildPayslipFromInputs({
          employee: { id: 1 },
          employmentTerm: term,
          assignments,
          payrollRun: run,
        }).grossAmount,
      ),
    ).toBe(115000);
  });
  it("excludes templates for another grade and inactive components", () => {
    expect(
      payrollAssignments({
        employee: { gradeLevelId: 3 },
        employmentTerm: term,
        payrollRun: run,
        components: [
          { ...component, gradeLevelId: 2 },
          { ...component, active: false },
        ],
      }),
    ).toEqual([]);
  });
  it("evaluates ordered formulas using the same contractual inputs", () => {
    const assignments = payrollAssignments({
      employee: {},
      employmentTerm: term,
      payrollRun: run,
      components: [
        component,
        {
          ...component,
          id: 2,
          code: "TRAVEL",
          sortOrder: 2,
          computation: "FORMULA",
          formula: "HOUSING * 0.5",
        },
      ],
    });
    expect(assignments.map((a) => Number(a.amount))).toEqual([10000, 5000]);
  });
  it.each(["NET * 0.1", "LWP_DAYS * 100", "FUTURE + 1"])(
    "rejects unsupported or forward formula references before publication: %s",
    (formula) => {
      expect(() =>
        validatePayrollConfiguration({
          salaryComponents: [{ ...component, computation: "FORMULA", formula }],
        }),
      ).toThrow();
    },
  );
  it("disabling recovery disables the deduction, including the uncapped case", () => {
    const slip = buildPayslipFromInputs({
      employee: { id: 1 },
      employmentTerm: term,
      payrollRun: run,
      bridges: {
        loanLines: [{ loanId: 1, name: "Loan repayment", amountMinor: 500000 }],
      },
      ruleConfig: { garnishmentRecovery: false },
    });
    expect(slip.deductions.some((d) => d.loanId)).toBe(false);
  });
  it("never substitutes a name or numeric key for an employee code", () => {
    expect(
      employeeCode({ id: 19, first_name: "Personal", last_name: "Name" }),
    ).toBe("Employee code required");
    expect(
      employeeCode({
        employee_code: "EMP-001",
        employee_name: "Personal Name",
      }),
    ).toBe("EMP-001");
  });
  it("reservations do not mutate loan balances and preserve settled history", async () => {
    const db = {
      loanRepayment: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        create: jest.fn(),
      },
      loan: { updateMany: jest.fn() },
    };
    await reservePayrollLoans(db, {
      tenantId: "company",
      runId: 1,
      payslipId: 2,
      currency: "PKR",
      deductions: [{ loanId: 3, amount: "123" }],
    });
    expect(db.loan.updateMany).not.toHaveBeenCalled();
    expect(db.loanRepayment.create.mock.calls[0][0].data).toMatchObject({
      amountMinor: 12300,
      settledAt: null,
    });
    db.loanRepayment.findMany.mockResolvedValue([
      { loanId: 3, amountMinor: 12300, settledAt: new Date() },
    ]);
    await expect(
      reservePayrollLoans(db, {
        tenantId: "company",
        runId: 1,
        payslipId: 2,
        currency: "PKR",
        deductions: [{ loanId: 3, amount: "124" }],
      }),
    ).rejects.toThrow("Posted loan repayment changed");
  });
  it("a changed balance aborts settlement before recording a paid instalment", async () => {
    const db = {
      loanRepayment: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 1, loanId: 3, amountMinor: 12300 }]),
        update: jest.fn(),
      },
      loan: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    await expect(
      settlePayrollLoans(db, { tenantId: "company", runId: 1 }),
    ).rejects.toThrow("Loan balance changed");
    expect(db.loanRepayment.update).not.toHaveBeenCalled();
  });
});
