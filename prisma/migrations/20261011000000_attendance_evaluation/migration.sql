-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StatusAttendance" ADD VALUE 'PENDING_ATTENDANCE';
ALTER TYPE "StatusAttendance" ADD VALUE 'PUNCH_CONFLICT';

-- AlterEnum
ALTER TYPE "AnomalyStatus" ADD VALUE 'RESOLVED';

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "calculation" JSONB,
ADD COLUMN     "evaluationHash" TEXT,
ADD COLUMN     "evaluationVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finalizedAt" TIMESTAMP(3),
ADD COLUMN     "nextEvaluationAt" TIMESTAMP(3),
ADD COLUMN     "processingState" TEXT NOT NULL DEFAULT 'AWAITING_DATA';

-- AlterTable
ALTER TABLE "attendance_device_punches" ADD COLUMN     "assurance" JSONB,
ADD COLUMN     "siteId" TEXT;

-- AlterTable
ALTER TABLE "attendance_anomalies" ADD COLUMN     "evidenceState" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "attendance_capture_devices" ADD COLUMN     "siteId" TEXT;

-- CreateTable
CREATE TABLE "attendance_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "attendanceId" INTEGER NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "shiftStart" TIMESTAMP(3),
    "shiftEnd" TIMESTAMP(3),
    "processingState" TEXT NOT NULL,
    "intervals" JSONB NOT NULL,
    "calculation" JSONB NOT NULL,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_evaluations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "attendanceId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_evaluation_jobs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_evaluation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_evaluation_cursors" (
    "tenantId" UUID NOT NULL,
    "plannedThrough" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_evaluation_cursors_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "attendance_time_credits" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "fromSiteId" TEXT,
    "toSiteId" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'APPROVED',
    "reason" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "revokedBy" TEXT,
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_time_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_tenantId_attendanceId_sessionKey_key" ON "attendance_sessions"("tenantId", "attendanceId", "sessionKey");

-- CreateIndex
CREATE INDEX "attendance_evaluations_tenantId_createdAt_idx" ON "attendance_evaluations"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_evaluations_tenantId_attendanceId_version_key" ON "attendance_evaluations"("tenantId", "attendanceId", "version");

-- CreateIndex
CREATE INDEX "attendance_evaluation_jobs_state_nextAttemptAt_idx" ON "attendance_evaluation_jobs"("state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_evaluation_jobs_tenantId_employeeId_date_key" ON "attendance_evaluation_jobs"("tenantId", "employeeId", "date");

-- CreateIndex
CREATE INDEX "attendance_time_credits_tenantId_employeeId_date_state_idx" ON "attendance_time_credits"("tenantId", "employeeId", "date", "state");

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_evaluations" ADD CONSTRAINT "attendance_evaluations_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE attendance_device_punches ADD COLUMN "excludedAt" TIMESTAMP(3),
ADD COLUMN "excludedBy" TEXT, ADD COLUMN "exclusionReason" TEXT,
ADD COLUMN "exclusionVersion" INTEGER NOT NULL DEFAULT 0;

-- Tenant isolation applies to every new calculation/evidence table.
DO $$ DECLARE tab TEXT; BEGIN
  FOREACH tab IN ARRAY ARRAY['attendance_sessions','attendance_evaluations','attendance_evaluation_jobs',
    'attendance_evaluation_cursors','attendance_time_credits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')',tab);
  END LOOP;
END $$;

ALTER TABLE "Attendance" ADD CONSTRAINT attendance_processing_state_check
  CHECK ("processingState" IN ('OPEN','AWAITING_DATA','NEEDS_REVIEW','FINALIZED'));

-- Shared attendance / exclusive payroll locks serialize the protected-period check
-- with period creation, including callers outside the capture service.
CREATE FUNCTION hr_attendance_protected_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant UUID; work_date TIMESTAMP;
BEGIN
  tenant := CASE WHEN TG_OP='DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
  work_date := CASE WHEN TG_OP='DELETE' THEN OLD.date ELSE NEW.date END;
  IF TG_OP='UPDATE' AND (NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW.date IS DISTINCT FROM OLD.date OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId") THEN
    RAISE EXCEPTION 'Attendance identity and work date are immutable';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext(tenant::text || ':attendance-period'));
  IF EXISTS (SELECT 1 FROM payroll_runs WHERE "tenantId"=tenant AND
    "periodStart"<=work_date+INTERVAL '1 day'-INTERVAL '1 millisecond' AND "periodEnd">=work_date AND
    status::text NOT IN ('CANCELLED','FAILED')) THEN
    RAISE EXCEPTION 'PERIOD_PROTECTED: recall or cancel payroll before changing attendance';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_protected_period BEFORE INSERT OR UPDATE OR DELETE ON "Attendance"
  FOR EACH ROW EXECUTE FUNCTION hr_attendance_protected_period();

CREATE FUNCTION hr_payroll_attendance_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW."tenantId"::text || ':attendance-period'));
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_attendance_lock BEFORE INSERT OR UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION hr_payroll_attendance_lock();

-- Existing multi-level overtime approvals invalidate the calculation in the same
-- transaction; no separate HR time-credit route can bypass that workflow.
CREATE FUNCTION hr_overtime_evaluation_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant UUID; employee INTEGER; work_date TIMESTAMP;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'APPROVED' THEN RETURN OLD; END IF;
    tenant:=OLD."tenantId";employee:=OLD."employeeId";work_date:=OLD.date;
  ELSE
    IF NEW.status<>'APPROVED' AND (TG_OP='INSERT' OR OLD.status<>'APPROVED') THEN RETURN NEW; END IF;
    tenant:=NEW."tenantId";employee:=NEW."employeeId";work_date:=NEW.date;
    IF TG_OP='UPDATE' AND (NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId" OR NEW.date IS DISTINCT FROM OLD.date) THEN
      RAISE EXCEPTION 'Approved overtime identity and work date are immutable';
    END IF;
  END IF;
  IF tenant IS NULL THEN RAISE EXCEPTION 'Approved overtime requires a tenant'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext(tenant::text || ':attendance-period'));
  IF EXISTS (SELECT 1 FROM payroll_runs WHERE "tenantId"=tenant AND "periodStart"<=work_date+INTERVAL '1 day'-INTERVAL '1 millisecond' AND "periodEnd">=work_date AND status::text NOT IN ('CANCELLED','FAILED')) THEN
    RAISE EXCEPTION 'PERIOD_PROTECTED: recall or cancel payroll before changing overtime';
  END IF;
  INSERT INTO attendance_evaluation_jobs (id,"tenantId","employeeId",date,state,"nextAttemptAt",attempts,"updatedAt")
    VALUES (gen_random_uuid(),tenant,employee,work_date,'PENDING',now(),0,now())
    ON CONFLICT ("tenantId","employeeId",date) DO UPDATE SET state='PENDING',"nextAttemptAt"=now(),attempts=0,"lastError"=NULL,"completedAt"=NULL,"updatedAt"=now();
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER overtime_evaluation_job AFTER INSERT OR UPDATE OR DELETE ON overtime_requests
  FOR EACH ROW EXECUTE FUNCTION hr_overtime_evaluation_job();
