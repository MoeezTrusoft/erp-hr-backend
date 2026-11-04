import { describe, it, expect } from "@jest/globals";
import {
  SALARY_SPLIT,
  BASIC_PCT_OF_TOTAL,
  LEGACY_ALLOWANCE_CODES,
  SPLIT_PCT_PRECISION,
  componentPctOfBasic,
  storedPctOfBasic,
} from "../../src/lib/employeeImportTaxonomy.js";
import { payrollAssignments } from "../../src/lib/payrollConfiguration.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The engine's own path: gross = baseSalary + Σ(percent/100 · baseSalary), each amount rounded to the paisa.
function grossFor(total, pctOfBasic) {
  const basic = round2(total * (BASIC_PCT_OF_TOTAL / 100));
  const components = SALARY_SPLIT.map((s, i) => ({
    id: i + 1,
    code: s.code,
    name: s.name,
    type: "EARNING",
    computation: "PERCENTAGE",
    value: String(pctOfBasic(s.pctOfTotal)),
    active: true,
    taxable: true,
    sortOrder: i,
    gradeLevelId: null,
  }));
  const rows = payrollAssignments({
    employee: { id: 1 },
    employmentTerm: { baseSalary: String(basic) },
    assignments: [],
    components,
    payrollRun: { currencyCode: "PKR" },
  });
  return rows.reduce((sum, r) => round2(sum + Number(r.amount)), basic);
}

// Employees carry allowance assignments coded HRA / CONVEYANCE / MEDICAL / UTILITY; a salary component is skipped
// only on an identical code, so the importer's components must use the same codes or the allowance is paid twice.
describe("importer salary split codes", () => {
  it("uses the allowance codes of the earning types", () => {
    expect(SALARY_SPLIT.map((s) => s.code)).toEqual(["HRA", "CONVEYANCE", "MEDICAL", "UTILITY"]);
  });
  it("lists the older codes it retires, none of which is a current code", () => {
    expect(LEGACY_ALLOWANCE_CODES).toEqual(["CONV", "MED", "UTIL"]);
    for (const c of LEGACY_ALLOWANCE_CODES) expect(SALARY_SPLIT.some((s) => s.code === c)).toBe(false);
  });
  it("still adds up to the whole salary: basic plus the allowances as a share of basic is 100%", () => {
    const pctOfBasic = SALARY_SPLIT.reduce((n, s) => n + componentPctOfBasic(s.pctOfTotal), 0);
    expect(BASIC_PCT_OF_TOTAL + (BASIC_PCT_OF_TOTAL * pctOfBasic) / 100).toBeCloseTo(100, 6);
  });
});

// §369: the split percentages are 400/9, 100/3, 250/9 and 50/3 percent of basic. Stored at 4 dp they lost part of
// the package (300,000 → 299,999.97); they are stored at 8 dp so basic + allowances rebuild the entered total.
describe("importer salary split precision (§369)", () => {
  it("stores the percent-of-basic values at 8 dp", () => {
    expect(SPLIT_PCT_PRECISION).toBe(8);
    expect(SALARY_SPLIT.map((s) => storedPctOfBasic(s.pctOfTotal))).toEqual([
      44.44444444, 33.33333333, 27.77777778, 16.66666667,
    ]);
  });

  it("leaves less than one paisa of the package unaccounted for", () => {
    const stored = SALARY_SPLIT.reduce((n, s) => n + storedPctOfBasic(s.pctOfTotal), 0);
    const exact = SALARY_SPLIT.reduce((n, s) => n + componentPctOfBasic(s.pctOfTotal), 0);
    // 1e-7 % of basic is 0.000135 on a 100,000 basic — far below a paisa.
    expect(Math.abs(stored - exact)).toBeLessThan(1e-6);
  });

  it("reconstructs the entered package exactly", () => {
    for (const total of [37_500, 100_000, 150_000, 300_000, 1_000_000]) {
      expect(grossFor(total, storedPctOfBasic)).toBe(total);
    }
  });

  it("would still lose money at the old 4 dp precision", () => {
    expect(grossFor(300_000, (pct) => roundSplitPctAt(componentPctOfBasic(pct), 4))).toBe(299_999.97);
  });
});

function roundSplitPctAt(pctOfBasic, dp) {
  const f = 10 ** dp;
  return Math.round((Number(pctOfBasic) + Number.EPSILON) * f) / f;
}
