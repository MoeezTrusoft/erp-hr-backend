import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const schema = read("prisma/schema.prisma");
const deploymentSql = read("scripts/sql/F-DB-06-08-14.hr-indexes.sql");

const indexDefinitions = [...deploymentSql.matchAll(
  /CREATE INDEX CONCURRENTLY IF NOT EXISTS\s+"([^"]+)"\s+ON\s+"?([^"\s]+)"?\s*\(([^;]+?)\)(?:\s+WHERE\s+([^;]+))?;/g,
)].map((match) => ({
  name: match[1],
  table: match[2],
  columns: match[3].replace(/\s+/g, " ").trim(),
  predicate: (match[4] || "").replace(/\s+/g, " ").trim(),
}));

describe("F-DB-06 queue index contracts", () => {
  test("uses nontransactional concurrent partial indexes matching worker predicates", () => {
    const executableSql = deploymentSql.replace(/^--.*$/gm, "");
    expect(executableSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/);
    expect(deploymentSql).toContain(
      'WHERE "publishedAt" IS NULL AND "claimedAt" IS NULL;'
    );
    expect(deploymentSql).toContain(
      'WHERE "publishedAt" IS NULL AND "claimExpiresAt" IS NOT NULL;'
    );
    expect(deploymentSql).toContain(
      `WHERE "status" IN ('PENDING', 'RETRY_WAIT')`
    );
    expect(deploymentSql).toContain(`WHERE "status" = 'PROCESSING';`);
    expect(deploymentSql).toContain('"createdAt" ASC, "id" ASC');
    expect(deploymentSql).toContain('"nextAttemptAt" ASC, "createdAt" ASC, "id" ASC');
  });
});

describe("F-DB-07 and F-DB-08 workload composites", () => {
  test.each([
    "@@index([tenantId, employeeId, date(sort: Desc), id(sort: Desc)], map: \"Attendance_tenant_employee_date_id_idx\")",
    "@@index([tenantId, status, createdAt(sort: Desc), id(sort: Desc)], map: \"attendance_anomalies_tenant_status_created_id_idx\")",
    "@@index([tenantId, employeeId, status, startDate, endDate, id], map: \"leave_requests_tenant_employee_status_dates_id_idx\")",
    "@@index([tenantId, status, date(sort: Desc), id(sort: Desc)], map: \"overtime_requests_tenant_status_date_id_idx\")",
    "@@index([tenantId, employeeId, status, date(sort: Desc), id(sort: Desc)], map: \"overtime_requests_tenant_employee_status_date_id_idx\")",
    "@@index([tenantId, employeeId, created_at(sort: Desc), id(sort: Desc)], map: \"payroll_payslips_tenant_employee_created_id_idx\")",
    "@@index([tenantId, employeeId, effectiveFrom(sort: Desc), id(sort: Desc)], map: \"employment_terms_tenant_employee_effective_id_idx\")",
    "@@index([tenantId, employeeId, isActive, effectiveFrom(sort: Desc), id(sort: Desc)], map: \"payroll_assignments_tenant_employee_active_effective_id_idx\")",
    "@@index([tenantId, countryCode, effectiveFrom(sort: Desc), effectiveTo, id], map: \"tax_rates_tenant_country_effective_id_idx\")",
    "@@index([tenantId, created_at(sort: Desc), id(sort: Desc)], map: \"payroll_audit_logs_tenant_created_id_idx\")",
  ])("declares %s", (declaration) => {
    expect(schema).toContain(declaration);
  });
});

describe("F-DB-14 selective overlap inventory", () => {
  test("contains no duplicate deployment signature or duplicate index name", () => {
    const names = indexDefinitions.map(({ name }) => name);
    const signatures = indexDefinitions.map(({ table, columns, predicate }) =>
      `${table}|${columns}|${predicate}`
    );
    expect(indexDefinitions).toHaveLength(17);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  test.each([
    "Attendance_tenantId_idx",
    "attendance_anomalies_tenantId_idx",
    "overtime_requests_tenantId_idx",
    "payroll_payslips_tenantId_idx",
    "employment_terms_tenantId_idx",
    "payroll_assignments_tenantId_idx",
    "payroll_audit_logs_tenantId_idx",
    "tax_rates_tenantId_idx",
    "outbox_events_publishedAt_createdAt_idx",
    "outbox_events_publishedAt_claimExpiresAt_createdAt_idx",
    "system_account_provisioning_status_nextAttemptAt_claimExpir_idx",
  ])("retires catalog-proven overlap %s", (indexName) => {
    expect(deploymentSql).toContain(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}";`);
  });

  test("keeps independently queried tenant and uniqueness paths", () => {
    expect(schema).toContain("@@index([tenantId, publishedAt])");
    expect(schema).toContain("@@unique([tenantId, employeeId])");
    expect(schema).toContain("@@unique([tenantId, idempotencyKey])");
  });
});

describe("F-DB-07/F-DB-08 stable pagination order", () => {
  test.each([
    ["src/jobs/system-account-provisioning.js", 'orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }]'],
    ["src/services/attendanceAnomaly.service.js", 'orderBy: [{ [sortField]: dir }, { id: dir }]'],
    ["src/services/leaveReport.service.js", 'orderBy: [{ [sortField]: dir }, { id: dir }]'],
    ["src/services/overtimeManager.service.js", 'orderBy: [{ date: "desc" }, { id: "desc" }]'],
    ["src/services/payrollService.js", "orderBy: [{ created_at: 'desc' }, { id: 'desc' }]"],
  ])("pins an id tie-break in %s", (relativePath, expected) => {
    expect(read(relativePath)).toContain(expected);
  });
});
