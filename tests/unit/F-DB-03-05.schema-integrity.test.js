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
    // 116 + the 4 HR-ATT-POLICY-01 models (AttendancePolicyConfig,
    // AttendanceDeductionRule, AttendanceApprovalLevel,
    // AttendanceAnomalyApproval). They follow the same nullable-tenant
    // convention as the rest of Payroll Setup, so they join the staged-backfill
    // cohort rather than being exempted.
    // 120 + OvertimeRequestApproval (HR-OT-APPROVAL-01), which follows the same
    // nullable-tenant convention as every other tenant-owned model here.
    // 121 + EmploymentPeriod (HR-PAYROLL-EMPLOYMENT-PERIOD-01), likewise.
    // 122 + EmployeeDeviceEnrolment (HR-ATT-DEVICE-ENROLMENT-01), likewise.
    // 123 + AttendanceCallIn (HR-ATT-ONCALL-01), likewise — nullable-tenant
    // call-in rows join the staged-backfill cohort, same as every model here.
    // 123 + RequisitionTransition (Phase 2.1), the requisition's immutable
    // transition history. Nullable-tenant like RequisitionApproval beside it: a
    // legacy tenantless requisition must still be able to record a transition
    // rather than fail its write on a NOT NULL column.
    // 124 + RequisitionAttachment (Phase 2.2), the typed/ACL'd requisition
    // documents. Nullable-tenant for the same reason: the pointer hangs off a
    // requisition that may predate tenancy, and the row must not be unwritable
    // just because the parent is legacy.
    // 125 + RecruitmentHiringFreeze (Phase 4) — a freeze is a tenant control and
    // every recruitment table beside it follows the same nullable-tenant
    // convention. It carries its own RLS policy in the migration that creates it.
    // 126 + RequisitionApprovalRule (Phase 4) — the approval matrix, same
    // convention and same own-policy-in-own-migration rule.
    // 127 + ApplicationQuestion (Phase 5 §3.5) — the public intake-form
    // questions, nullable-tenant like every recruitment table beside it and
    // carrying its own RLS policy in its creating migration.
    // 128-130 + ApplicationScreening, DispositionReasonCode, ShortlistEntry
    // (Phase 6 §4.1–4.3) — same convention, same own-policy-in-own-migration
    // rule, all three in one migration.
    // 131 + ResumeParseAttempt (Phase 6 §4.5a) — the content-hash-keyed parse
    // ledger, own RLS policy in its creating migration.
    // 132 + InterviewPacketItem (Phase 6 §4.4) — the interview packet, same
    // nullable-tenant convention and own-policy-in-own-migration rule.
    // 133 + InterviewLifecycleEvent (Phase 7 §5.4) — the coded cancel/reschedule
    // ledger, same convention and own-policy-in-own-migration rule.
    // 134-135 + ScorecardTemplate, ScorecardTemplateLink (Phase 7 §5.5) —
    // tenant-configurable templates and their scope links, same convention.
    // 136-137 + SkillAlias, AiInferenceRecord (Phase 13 §7.2/§7.4) — the
    // taxonomy alias layer and the AI provenance ledger, same convention.
    // 139 + CandidateEmailVerification (Phase 5 §3.2) — the magic-link token
    // table, same convention and own-policy-in-own-migration rule.
    // 140 + ApplicationDraft (Phase 5 FR-04.07) — save-and-return drafts,
    // same convention and own-policy-in-own-migration rule.
    // 141 + OnboardingTemplate (Phase 9 residue FR-13) — tenant-configurable
    // onboarding checklists, same convention and own-policy-in-own-migration
    // rule.
    // 142 + OfferApprovalRule (Phase 9 residue FR-09) — the tenant offer
    // approval policy (role-specific approver chains with compensation
    // windows), same convention and own-policy-in-own-migration rule.
    // 143 + TalentPoolInvitation (FR-10 residue) — the invitation lifecycle,
    // same convention and own-policy-in-own-migration rule.
    // 144: both sets above together (main's AttendanceCallIn plus the twenty
    // recruitment models), counted after the recruitment branch was merged.
    expect(nullableModels).toHaveLength(144);

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
