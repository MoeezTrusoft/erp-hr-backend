import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migrationPath = path.join(
  root,
  "prisma/migrations/20260726210000_f_db_03_05_tenant_integrity/migration.sql",
);

function model(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match).not.toBeNull();
  return match[1];
}

describe("F-DB-03/F-DB-04 tenant-qualified and natural-key integrity", () => {
  test.each([
    ["DashboardLayout", "@@unique([tenantId, employeeId, dashboardType])"],
    ["LeavePolicy", "@@unique([tenantId, name])"],
    ["ApprovalWorkflow", "@@unique([tenantId, name])"],
    ["Region", "@@unique([tenantId, name])"],
    ["PayrollEarningType", "@@unique([tenantId, code])"],
    ["PayrollDeductionType", "@@unique([tenantId, code])"],
    ["Candidate", "@@unique([tenantId, email])"],
    ["Skill", "@@unique([tenantId, name])"],
    ["TrainingCourse", "@@unique([tenantId, courseCode])"],
    ["SalaryComponent", "@@unique([tenantId, code])"],
    ["PayrollCalendar", "@@unique([tenantId])"],
    ["PayrollRuleConfig", "@@unique([tenantId])"],
    ["PayrollConfigMeta", "@@unique([tenantId])"],
    ["PayrollConfigSnapshot", "@@unique([tenantId, version])"],
  ])("%s declares %s", (name, key) => {
    expect(model(name)).toContain(key);
  });

  test("global uniqueness is removed from tenant-owned fields", () => {
    expect(model("PayrollEarningType")).not.toMatch(/code\s+String\s+@unique/);
    expect(model("PayrollDeductionType")).not.toMatch(/code\s+String\s+@unique/);
    expect(model("Candidate")).not.toMatch(/email\s+String\s+@unique/);
    expect(model("Skill")).not.toMatch(/name\s+String\s+@unique/);
    expect(model("DashboardLayout")).not.toContain("@@unique([dashboardType])");
  });

  test.each([
    ["dashboardLayout.service.js", "tenantId_employeeId_dashboardType"],
    ["candidateService.js", "tenantId_email"],
    ["resumeParsing.service.js", "tenantId_name"],
    ["payrollCalendar.service.js", "payrollCalendar.upsert"],
    ["payrollRuleConfig.service.js", "payrollRuleConfig.upsert"],
    ["payrollConfigActions.service.js", "tenantId_version"],
    ["payrollConfigActions.service.js", "payrollConfigMeta.upsert"],
  ])("%s uses the composite selector/upsert %s", (file, selector) => {
    const source = readFileSync(path.join(root, "src/services", file), "utf8");
    expect(source).toContain(selector);
  });
});

describe("F-DB-05 safe tenant backfill staging", () => {
  test("migration preflights duplicates before removing legacy indexes", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const preflight = sql.indexOf("F-DB-03 duplicate preflight failed");
    const firstDrop = sql.indexOf("DROP INDEX");
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(firstDrop).toBeGreaterThan(preflight);
    expect(sql).toContain("Action: resolve the listed duplicate groups");
  });

  test("all currently nullable tenant models receive staged NOT VALID checks", () => {
    const nullableModels = [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
      .filter(([, , body]) => /\b(?:tenantId|tenant_id)\s+String\?/.test(body))
      .map(([, name]) => name);
    expect(nullableModels).toHaveLength(114);

    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("NOT VALID");
    expect(sql).toContain("tenant_not_null_staged");
    expect(sql).toContain("F-DB-05 nullable tenant backfill report");
  });

  test("the executable backfill requires explicit mappings and supports report-only mode", () => {
    const script = readFileSync(path.join(root, "scripts/backfill-tenant-ids.js"), "utf8");
    expect(script).toContain("--mapping");
    expect(script).toContain("--report");
    expect(script).toContain("No tenant is inferred from a default");
    expect(script).not.toMatch(/DEFAULT_TENANT|tenantId\s*=\s*["']?[01]["']?/);
  });
});
