import { describe, it, expect } from "@jest/globals";
import { SALARY_SPLIT, BASIC_PCT_OF_TOTAL, LEGACY_ALLOWANCE_CODES, componentPctOfBasic } from "../../src/lib/employeeImportTaxonomy.js";

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
