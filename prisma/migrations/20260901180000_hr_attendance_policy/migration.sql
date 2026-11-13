-- HR-ATT-POLICY-01 — attendance policy, deduction rules and anomaly approvals.
--
-- Additive only: every new column is nullable or defaulted, and no existing
-- column changes type. Safe to apply BEFORE the code that uses it ships.
--
-- Enum values are added first and NOT used by any DDL below, so this file can be
-- applied in one psql run. Postgres forbids USING a new enum value in the same
-- transaction that adds it, so do not wrap this file in BEGIN/COMMIT.

-- 1. Blocking attendance states -------------------------------------------
ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'MISSING_CHECKIN';
ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'MISSING_CHECKOUT';

-- 2. Payable credit for the day -------------------------------------------
-- NULL = undetermined (awaiting regularization). Payroll HOLDS on NULL; it must
-- never coerce it to zero.
ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "day_credit" DOUBLE PRECISION;
ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "requires_regularization" BOOLEAN NOT NULL DEFAULT false;

-- 3. Anomaly request form --------------------------------------------------
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "applicationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "positionSnapshot" TEXT;
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "departmentSnapshot" TEXT;
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "expectedTime" TIMESTAMP(3);
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "actualTime" TIMESTAMP(3);
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "sourceKind" TEXT;
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;
ALTER TABLE "attendance_anomalies" ADD COLUMN IF NOT EXISTS "currentApprovalLevel" INTEGER NOT NULL DEFAULT 1;

-- One auto-raised anomaly per source. DISAPPROVED_LEAVE can arrive from both a
-- rejected LeaveRequest and a rejected regularization; this is what stops the
-- employee being deducted twice for one day.
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_anomalies_source_key"
    ON "attendance_anomalies" ("tenantId", "sourceKind", "sourceRef");

-- 4. Approval chain decisions ----------------------------------------------
CREATE TABLE IF NOT EXISTS "attendance_anomaly_approvals" (
    "id"           SERIAL PRIMARY KEY,
    "anomalyId"    INTEGER NOT NULL REFERENCES "attendance_anomalies"("id") ON DELETE CASCADE,
    "level"        INTEGER NOT NULL,
    "approverId"   INTEGER NOT NULL REFERENCES "Employee"("id"),
    "approverRole" TEXT NOT NULL,
    "decision"     "ApprovalDecision" NOT NULL,
    "comments"     TEXT,
    "decidedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"     UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_anomaly_approvals_anomalyId_level_key"
    ON "attendance_anomaly_approvals" ("anomalyId", "level");
CREATE INDEX IF NOT EXISTS "attendance_anomaly_approvals_anomalyId_idx" ON "attendance_anomaly_approvals" ("anomalyId");
CREATE INDEX IF NOT EXISTS "attendance_anomaly_approvals_approverId_idx" ON "attendance_anomaly_approvals" ("approverId");
CREATE INDEX IF NOT EXISTS "attendance_anomaly_approvals_tenantId_idx" ON "attendance_anomaly_approvals" ("tenantId");

-- 5. Payroll Setup · attendance policy -------------------------------------
CREATE TABLE IF NOT EXISTS "attendance_policy_config" (
    "id"                      SERIAL PRIMARY KEY,
    "graceMinutes"            INTEGER NOT NULL DEFAULT 0,
    "halfDayAfterMinutes"     INTEGER NOT NULL DEFAULT 30,
    "earlyLeaveGraceMin"      INTEGER NOT NULL DEFAULT 0,
    "checkoutLeniencyMin"     INTEGER NOT NULL DEFAULT 240,
    "overtimeAfterMinutes"    INTEGER NOT NULL DEFAULT 45,
    "overtimeNeedsApproval"   BOOLEAN NOT NULL DEFAULT true,
    "fullDayMinPercent"       DOUBLE PRECISION NOT NULL DEFAULT 90,
    "halfDayMinPercent"       DOUBLE PRECISION NOT NULL DEFAULT 50,
    "duplicatePunchWindowMin" INTEGER NOT NULL DEFAULT 5,
    "shiftGapHours"           INTEGER NOT NULL DEFAULT 11,
    "defaultShiftStart"       TEXT NOT NULL DEFAULT '09:00',
    "status"                  "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "version"                 INTEGER NOT NULL DEFAULT 1,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"                UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_policy_config_tenantId_key" ON "attendance_policy_config" ("tenantId");

-- 6. Payroll Setup · deduction rules ---------------------------------------
DO $$ BEGIN
    CREATE TYPE "AttendanceDeductionRuleKey" AS ENUM (
        'DISAPPROVED_LEAVE', 'LATE', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'EARLY_CHECKOUT'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "attendance_deduction_rules" (
    "id"                        SERIAL PRIMARY KEY,
    "ruleKey"                   "AttendanceDeductionRuleKey" NOT NULL,
    -- Ships DISABLED. 460 of 1628 August shifts were single-scan, so switching
    -- MISSING_CHECKOUT on blind would deduct ~230 days across 64 people in one
    -- month for what is a device artefact. Enable only after a dry-run review.
    "enabled"                   BOOLEAN NOT NULL DEFAULT false,
    "triggerCount"              INTEGER NOT NULL DEFAULT 1,
    "deductionDays"             DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "periodScope"               TEXT NOT NULL DEFAULT 'PAY_PERIOD',
    "maxDeductionDaysPerPeriod" DOUBLE PRECISION,
    "status"                    "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "version"                   INTEGER NOT NULL DEFAULT 1,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"                  UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_deduction_rules_tenantId_ruleKey_key"
    ON "attendance_deduction_rules" ("tenantId", "ruleKey");
CREATE INDEX IF NOT EXISTS "attendance_deduction_rules_tenantId_idx" ON "attendance_deduction_rules" ("tenantId");

-- 7. Payroll Setup · anomaly approval chain --------------------------------
CREATE TABLE IF NOT EXISTS "attendance_approval_levels" (
    "id"                     SERIAL PRIMARY KEY,
    "level"                  INTEGER NOT NULL,
    "role"                   TEXT NOT NULL,
    "approverId"             INTEGER REFERENCES "Employee"("id"),
    "useEmployeeManager"     BOOLEAN NOT NULL DEFAULT false,
    "skipIfUnresolved"       BOOLEAN NOT NULL DEFAULT true,
    "autoEscalateAfterHours" INTEGER,
    "rowStatus"              "RowStatus" NOT NULL DEFAULT 'ACTIVE',
    "status"                 "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "version"                INTEGER NOT NULL DEFAULT 1,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"               UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_approval_levels_tenantId_level_key"
    ON "attendance_approval_levels" ("tenantId", "level");
CREATE INDEX IF NOT EXISTS "attendance_approval_levels_tenantId_idx" ON "attendance_approval_levels" ("tenantId");
