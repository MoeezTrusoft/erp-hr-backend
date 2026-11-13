import { evaluateMoneyFormula, validateFormula } from "./payrollFormula.js";
import * as money from "./money.js";

export const employeeCode = (employee) =>
  employee?.employee_code || employee?.employeeCode || "Employee code required";
export const SUPPORTED_PAY_RULES = Object.freeze([
  "midMonthJoinerProration",
  "lwpRecovery",
  "garnishmentRecovery",
  "cashDisbursement",
  "garnishmentCapPct",
  "deductionBasis",
  "eobiEnabled",
  "eobiEmployeeRatePct",
  "eobiWageCeilingMinor",
]);

// Templates and employee overrides share one input to the production engine.
// An explicitly assigned code overrides its template; BASIC remains in terms.
export function payrollAssignments({
  employee,
  employmentTerm,
  assignments = [],
  components = [],
  payrollRun,
}) {
  const currency = payrollRun.currencyCode;
  const result = [...assignments];
  const codes = new Set(
    assignments.map((a) => a.earningType?.code || a.deductionType?.code),
  );
  const basic = String(employmentTerm?.baseSalary || 0);
  const scope = { BASIC: basic, GROSS: basic };
  for (const c of [...components].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  )) {
    if (
      !c.active ||
      (c.gradeLevelId != null && c.gradeLevelId !== employee.gradeLevelId) ||
      ["BASIC", "BASE_SALARY"].includes(c.code)
    )
      continue;
    if (codes.has(c.code)) {
      const existing = assignments.find(
        (a) => (a.earningType?.code || a.deductionType?.code) === c.code,
      );
      scope[c.code] = String(
        existing.amount ??
          evaluateMoneyFormula("GROSS * RATE", {
            GROSS: scope.GROSS,
            RATE: String(existing.rate || 0),
          }),
      );
      if (existing.earningType)
        scope.GROSS = evaluateMoneyFormula("A + B", {
          A: scope.GROSS,
          B: scope[c.code],
        });
      continue;
    }
    // NET and attendance-dependent formulas are circular at this stage.
    if (
      c.computation === "FORMULA" &&
      /\b(NET|DAYS_WORKED|WORKING_DAYS|LWP_DAYS)\b/i.test(c.formula || "")
    )
      throw new Error(
        `Component ${c.code}: use contractual salary variables only`,
      );
    const value =
      c.computation === "FORMULA"
        ? evaluateMoneyFormula(c.formula, scope)
        : c.computation === "PERCENTAGE"
          ? evaluateMoneyFormula("BASIC * RATE / 100", {
              BASIC: basic,
              RATE: String(c.value),
            })
          : String(c.value);
    if (money.compareDecimal(value, 0) < 0)
      throw Object.assign(
        new Error(`Component ${c.code} must produce a non-negative amount`),
        { status: 400 },
      );
    const amount = money.minorToDecimal(
      money.decimalToMinor(String(value), currency),
      currency,
    );
    scope[c.code] = amount;
    if (c.type === "EARNING")
      scope.GROSS = evaluateMoneyFormula("A + B", {
        A: scope.GROSS,
        B: amount,
      });
    const type = { code: c.code, name: c.name, isTaxable: c.taxable !== false };
    result.push({
      amount,
      ...(c.type === "EARNING"
        ? { earningType: type }
        : { deductionType: type }),
    });
  }
  return result;
}

export function assertPayrollPeriod(run) {
  const start = new Date(run.periodStart),
    end = new Date(run.periodEnd);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end < start)
    throw Object.assign(new Error("HR-4301: Invalid payroll period"), {
      status: 400,
      code: "HR-4301",
    });
  if (
    !/^[A-Z]{2}$/.test(run.countryCode || "") ||
    !/^[A-Z]{3}$/.test(run.currencyCode || "")
  )
    throw Object.assign(
      new Error("HR-4301: Country and currency are required"),
      { status: 400, code: "HR-4301" },
    );
}

export function validatePayrollConfiguration(config) {
  const components = config.salaryComponents || [];
  const grades = new Set([
    null,
    ...components.map((c) => c.gradeLevelId).filter((v) => v != null),
  ]);
  for (const grade of grades) {
    const available = ["BASIC", "GROSS"];
    for (const c of components
      .filter(
        (c) => c.active && (c.gradeLevelId == null || c.gradeLevelId === grade),
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)) {
      if (c.computation === "FORMULA") {
        const checked = validateFormula(c.formula, available);
        if (!checked.ok)
          throw Object.assign(
            new Error(
              `Component ${c.code}: ${checked.error}. Refer only to BASIC, GROSS and preceding components.`,
            ),
            { status: 400 },
          );
      }
      if (
        !["BASIC", "BASE_SALARY"].includes(c.code) &&
        available.includes(c.code)
      )
        throw Object.assign(
          new Error(`Duplicate component code ${c.code} in this grade`),
          { status: 400 },
        );
      available.push(c.code);
    }
  }
}
