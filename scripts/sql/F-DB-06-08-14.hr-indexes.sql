-- F-DB-06/F-DB-07/F-DB-08 and selective F-DB-14.
-- ARCH-01 §5.1, §5.5: run with psql in autocommit mode. CREATE/DROP INDEX
-- CONCURRENTLY must not be wrapped in BEGIN/COMMIT or a Prisma migration.

-- F-DB-06: outbox predicate from src/jobs/outbox.dispatcher.js:201-207.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_events_ready_created_id_idx"
  ON "outbox_events" ("createdAt" ASC, "id" ASC)
  WHERE "publishedAt" IS NULL AND "claimedAt" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_events_expired_claim_created_id_idx"
  ON "outbox_events" ("claimExpiresAt" ASC, "createdAt" ASC, "id" ASC)
  WHERE "publishedAt" IS NULL AND "claimExpiresAt" IS NOT NULL;

-- F-DB-06: provisioning predicates from
-- src/jobs/system-account-provisioning.js:165-177. The first two indexes are
-- mutually exclusive by claimedAt, so an active row occupies only one of them.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "system_account_provisioning_ready_unclaimed_idx"
  ON "system_account_provisioning" ("nextAttemptAt" ASC, "createdAt" ASC, "id" ASC)
  WHERE "status" IN ('PENDING', 'RETRY_WAIT') AND "claimedAt" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "system_account_provisioning_ready_expired_idx"
  ON "system_account_provisioning" ("nextAttemptAt" ASC, "claimExpiresAt" ASC, "createdAt" ASC, "id" ASC)
  WHERE "status" IN ('PENDING', 'RETRY_WAIT') AND "claimedAt" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "system_account_provisioning_processing_expired_idx"
  ON "system_account_provisioning" ("claimExpiresAt" ASC, "nextAttemptAt" ASC, "createdAt" ASC, "id" ASC)
  WHERE "status" = 'PROCESSING';

-- F-DB-07: attendance/anomaly/leave/overtime source-query composites.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Attendance_tenant_employee_date_id_idx"
  ON "Attendance" ("tenantId" ASC, "employeeId" ASC, "date" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Attendance_tenant_date_checkin_id_idx"
  ON "Attendance" ("tenantId" ASC, "date" DESC, "check_in" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "attendance_anomalies_tenant_status_created_id_idx"
  ON "attendance_anomalies" ("tenantId" ASC, "status" ASC, "createdAt" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "leave_requests_tenant_employee_status_dates_id_idx"
  ON "leave_requests" ("tenantId" ASC, "employeeId" ASC, "status" ASC, "startDate" ASC, "endDate" ASC, "id" ASC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "leave_requests_tenant_status_created_id_idx"
  ON "leave_requests" ("tenantId" ASC, "status" ASC, "created_at" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "overtime_requests_tenant_status_date_id_idx"
  ON "overtime_requests" ("tenantId" ASC, "status" ASC, "date" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "overtime_requests_tenant_employee_status_date_id_idx"
  ON "overtime_requests" ("tenantId" ASC, "employeeId" ASC, "status" ASC, "date" DESC, "id" DESC);

-- F-DB-08: payroll employee/effective-date/audit paths.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payroll_payslips_tenant_employee_created_id_idx"
  ON "payroll_payslips" ("tenantId" ASC, "employeeId" ASC, "created_at" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "employment_terms_tenant_employee_effective_id_idx"
  ON "employment_terms" ("tenantId" ASC, "employeeId" ASC, "effectiveFrom" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payroll_assignments_tenant_employee_active_effective_id_idx"
  ON "payroll_assignments" ("tenantId" ASC, "employeeId" ASC, "isActive" ASC, "effectiveFrom" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tax_rates_tenant_country_effective_id_idx"
  ON "tax_rates" ("tenantId" ASC, "countryCode" ASC, "effectiveFrom" DESC, "effectiveTo" ASC, "id" ASC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payroll_audit_logs_tenant_created_id_idx"
  ON "payroll_audit_logs" ("tenantId" ASC, "created_at" DESC, "id" DESC);

-- F-DB-14: drop only catalog-proven left-prefix overlaps after replacements are
-- valid. Tenant-only indexes not listed here remain because their wider source
-- workloads were not proven covered by this finding.
DROP INDEX CONCURRENTLY IF EXISTS "Attendance_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "attendance_anomalies_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "overtime_requests_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "payroll_payslips_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "employment_terms_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "payroll_assignments_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "payroll_audit_logs_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "tax_rates_tenantId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "outbox_events_publishedAt_createdAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "outbox_events_publishedAt_claimExpiresAt_createdAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "system_account_provisioning_status_nextAttemptAt_claimExpir_idx";
