-- AlterTable
ALTER TABLE "attendance_evaluation_jobs" ADD COLUMN     "rulesReconciliation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "attendance_anomalies" ADD COLUMN     "decisionRole" TEXT,
ADD COLUMN     "factHash" TEXT,
ADD COLUMN     "measuredMinutes" DOUBLE PRECISION,
ADD COLUMN     "rulesVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sessionKey" TEXT;

-- AlterTable
ALTER TABLE "payroll_payslips" ADD COLUMN     "attendanceBasisMinor" TEXT,
ADD COLUMN     "attendancePeriodDays" INTEGER;

-- CreateTable
CREATE TABLE "attendance_grace_rules" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "checkInMinutes" INTEGER,
    "checkOutMinutes" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_grace_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_grace_memberships" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "teamKey" TEXT,
    "departmentKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "attendance_grace_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_manual_times" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_manual_times_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_rule_audit" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeId" INTEGER,
    "anomalyId" INTEGER,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_rule_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_payroll_adjustments" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "sourcePayslipId" INTEGER NOT NULL,
    "sourcePeriodEnd" TIMESTAMP(3) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "amountMinor" TEXT NOT NULL,
    "appliedPayslipId" INTEGER,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_grace_rules_tenantId_scope_scopeKey_effectiveFro_key" ON "attendance_grace_rules"("tenantId", "scope", "scopeKey", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_grace_memberships_tenantId_employeeId_effectiveF_key" ON "attendance_grace_memberships"("tenantId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_manual_times_tenantId_employeeId_date_sessionKey_key" ON "attendance_manual_times"("tenantId", "employeeId", "date", "sessionKey", "direction");

-- CreateIndex
CREATE INDEX "attendance_rule_audit_tenantId_anomalyId_id_idx" ON "attendance_rule_audit"("tenantId", "anomalyId", "id");

-- CreateIndex
CREATE INDEX "attendance_payroll_adjustments_tenantId_employeeId_appliedP_idx" ON "attendance_payroll_adjustments"("tenantId", "employeeId", "appliedPayslipId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_payroll_adjustments_tenantId_sourcePayslipId_rev_key" ON "attendance_payroll_adjustments"("tenantId", "sourcePayslipId", "revision");

-- Every new operational table is tenant scoped, including background re-evaluation.
DO $$ DECLARE tab TEXT; BEGIN
  FOREACH tab IN ARRAY ARRAY['attendance_grace_rules','attendance_grace_memberships','attendance_manual_times','attendance_rule_audit','attendance_payroll_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app',tab);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO hr_app',tab || '_id_seq');
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',tab);
  END LOOP;
END $$;
ALTER TABLE attendance_grace_rules ADD CONSTRAINT attendance_grace_valid CHECK
 (scope IN ('COMPANY','DEPARTMENT','TEAM','EMPLOYEE','SHIFT') AND
  ("checkInMinutes" IS NULL OR "checkInMinutes" BETWEEN 0 AND 1440) AND
  ("checkOutMinutes" IS NULL OR "checkOutMinutes" BETWEEN 0 AND 1440));
ALTER TABLE attendance_manual_times ADD CONSTRAINT attendance_manual_direction CHECK (direction IN ('IN','OUT'));
CREATE FUNCTION hr_attendance_rule_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Attendance rule audit and manual evidence are append-only';
END $$;
CREATE TRIGGER attendance_rule_audit_immutable BEFORE UPDATE OR DELETE ON attendance_rule_audit
 FOR EACH ROW EXECUTE FUNCTION hr_attendance_rule_immutable();
CREATE TRIGGER attendance_manual_time_immutable BEFORE UPDATE OR DELETE ON attendance_manual_times
 FOR EACH ROW EXECUTE FUNCTION hr_attendance_rule_immutable();

-- Only the internal rules reconciliation transaction may revise protected derived
-- attendance. It also prices the outcome and records the payroll audit atomically.
CREATE OR REPLACE FUNCTION hr_attendance_protected_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant UUID; work_date TIMESTAMP;
BEGIN
 tenant := CASE WHEN TG_OP='DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
 work_date := CASE WHEN TG_OP='DELETE' THEN OLD.date ELSE NEW.date END;
 IF TG_OP='UPDATE' AND (NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW.date IS DISTINCT FROM OLD.date OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId") THEN
   RAISE EXCEPTION 'Attendance identity and work date are immutable';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext(tenant::text || ':attendance-period'));
 IF EXISTS (SELECT 1 FROM payroll_runs WHERE "tenantId"=tenant AND "periodStart"<=work_date+INTERVAL '1 day'-INTERVAL '1 millisecond' AND "periodEnd">=work_date AND status::text NOT IN ('CANCELLED','FAILED')) THEN
   IF TG_OP='DELETE' OR current_setting('app.attendance_rules_reconciliation',true) IS DISTINCT FROM 'on' OR NEW.calculation->>'algorithmVersion' IS DISTINCT FROM 'anomaly-rules-v2' THEN
     RAISE EXCEPTION 'PERIOD_PROTECTED: recall or cancel payroll before changing attendance';
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hr_rule_payslip_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtext((CASE WHEN TG_OP='DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END)::text || ':attendance-period'));
 IF TG_OP='DELETE' THEN
   IF OLD.status::text='DISTRIBUTED' OR OLD."distributedAt" IS NOT NULL THEN RAISE EXCEPTION 'Disbursed payroll is immutable'; END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.status::text='DISTRIBUTED' OR OLD."distributedAt" IS NOT NULL) AND
   (NEW."grossAmount" IS DISTINCT FROM OLD."grossAmount" OR NEW."netAmount" IS DISTINCT FROM OLD."netAmount" OR NEW."totalDeductions" IS DISTINCT FROM OLD."totalDeductions" OR NEW.status IS DISTINCT FROM OLD.status OR NEW."payableDays" IS DISTINCT FROM OLD."payableDays" OR NEW."distributedAt" IS DISTINCT FROM OLD."distributedAt" OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."payrollRunId" IS DISTINCT FROM OLD."payrollRunId") THEN
   RAISE EXCEPTION 'Disbursed payroll is immutable; use a next-period adjustment';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_rule_payslip_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_payslips
 FOR EACH ROW EXECUTE FUNCTION hr_rule_payslip_guard();

ALTER TABLE attendance_payroll_adjustments ADD CONSTRAINT "attendance_payroll_adjustments_sourcePayslipId_fkey"
 FOREIGN KEY ("sourcePayslipId") REFERENCES payroll_payslips(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE attendance_payroll_adjustments ADD CONSTRAINT "attendance_payroll_adjustments_appliedPayslipId_fkey"
 FOREIGN KEY ("appliedPayslipId") REFERENCES payroll_payslips(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE attendance_payroll_adjustments ADD CONSTRAINT attendance_adjustment_amount CHECK ("amountMinor" ~ '^-?[0-9]+$' AND revision > 0);
ALTER TABLE payroll_payslips ADD CONSTRAINT attendance_pricing_basis CHECK
 (("attendanceBasisMinor" IS NULL AND "attendancePeriodDays" IS NULL) OR
  ("attendanceBasisMinor" ~ '^[0-9]+$' AND "attendancePeriodDays" > 0));
CREATE FUNCTION hr_rule_deduction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid INTEGER; paid BOOLEAN; tenant UUID;
BEGIN
 sid := CASE WHEN TG_OP='DELETE' THEN OLD."payslipId" ELSE NEW."payslipId" END;
 SELECT "tenantId" INTO tenant FROM payroll_payslips WHERE id=sid;
 PERFORM pg_advisory_xact_lock(hashtext(tenant::text || ':attendance-period'));
 SELECT status::text='DISTRIBUTED' OR "distributedAt" IS NOT NULL INTO paid FROM payroll_payslips WHERE id=sid;
 IF paid THEN RAISE EXCEPTION 'Disbursed payroll deductions are immutable'; END IF;
 IF TG_OP='UPDATE' AND NEW."payslipId" IS DISTINCT FROM OLD."payslipId" THEN
   RAISE EXCEPTION 'A deduction cannot be moved between payslips';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_rule_deduction_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_deductions
 FOR EACH ROW EXECUTE FUNCTION hr_rule_deduction_guard();

CREATE FUNCTION hr_rule_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attendance adjustments are append-only'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(NEW."tenantId"::text || ':attendance-period'));
 IF TG_OP='UPDATE' AND (NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId" OR NEW."sourcePayslipId" IS DISTINCT FROM OLD."sourcePayslipId" OR NEW."sourcePeriodEnd" IS DISTINCT FROM OLD."sourcePeriodEnd" OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode" OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor" OR NEW.revision IS DISTINCT FROM OLD.revision) THEN
   RAISE EXCEPTION 'Attendance adjustment amounts and source identity are immutable';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM payroll_payslips WHERE id=NEW."sourcePayslipId" AND "tenantId"=NEW."tenantId" AND "employeeId"=NEW."employeeId") THEN
   RAISE EXCEPTION 'Attendance adjustment source is outside employee or tenant scope';
 END IF;
 IF NEW."appliedPayslipId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payroll_payslips WHERE id=NEW."appliedPayslipId" AND "tenantId"=NEW."tenantId" AND "employeeId"=NEW."employeeId" AND status::text<>'DISTRIBUTED' AND "distributedAt" IS NULL) THEN
   RAISE EXCEPTION 'Attendance adjustment target is paid or outside employee or tenant scope';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_rule_adjustment_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_payroll_adjustments
 FOR EACH ROW EXECUTE FUNCTION hr_rule_adjustment_guard();
