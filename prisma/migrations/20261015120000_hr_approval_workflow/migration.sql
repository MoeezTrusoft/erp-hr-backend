ALTER TABLE attendance_time_credits ALTER COLUMN state SET DEFAULT 'PENDING';
-- AlterTable
ALTER TABLE "loans" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "HrApprovalRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'INITIATOR',
    "version" INTEGER NOT NULL DEFAULT 0,
    "round" INTEGER NOT NULL DEFAULT 0,
    "managerCode" TEXT,
    "managerActorCode" TEXT,
    "hrActorCode" TEXT,
    "recommendation" TEXT,
    "verification" TEXT,
    "sourceHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "execution" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HrApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrApprovalAudit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "approvalRef" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "actorCode" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrApprovalAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrApprovalReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestKey" UUID NOT NULL,
    "actorCode" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrApprovalReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HrApprovalRequest_tenantId_stage_id_idx" ON "HrApprovalRequest"("tenantId", "stage", "id");

-- CreateIndex
CREATE INDEX "HrApprovalRequest_tenantId_employeeCode_idx" ON "HrApprovalRequest"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "HrApprovalRequest_tenantId_kind_sourceRef_key" ON "HrApprovalRequest"("tenantId", "kind", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "HrApprovalRequest_tenantId_id_key" ON "HrApprovalRequest"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HrApprovalAudit_tenantId_approvalRef_version_key" ON "HrApprovalAudit"("tenantId", "approvalRef", "version");

-- CreateIndex
CREATE UNIQUE INDEX "HrApprovalReceipt_tenantId_requestKey_key" ON "HrApprovalReceipt"("tenantId", "requestKey");

-- Approval security guards (also installed by the isolated DB test bootstrap).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['HrApprovalRequest','HrApprovalAudit','HrApprovalReceipt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY hr_approval_company ON %I USING ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',t);
 END LOOP;
END $$;
ALTER TABLE "HrApprovalRequest" ADD CONSTRAINT hr_approval_stage CHECK (stage IN ('INITIATOR','LINE_MANAGER','HR','MANAGEMENT','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE "HrApprovalRequest" ADD CONSTRAINT hr_approval_positive_version CHECK (version>=0 AND round>=0);
ALTER TABLE "HrApprovalAudit" ADD CONSTRAINT hr_approval_audit_parent FOREIGN KEY ("tenantId","approvalRef") REFERENCES "HrApprovalRequest"("tenantId",id);
CREATE FUNCTION hr_approval_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'HR-4202: Approval history and receipts are immutable'; END $$;
CREATE TRIGGER hr_approval_audit_immutable BEFORE UPDATE OR DELETE ON "HrApprovalAudit" FOR EACH ROW EXECUTE FUNCTION hr_approval_history_immutable();
CREATE TRIGGER hr_approval_receipt_immutable BEFORE UPDATE OR DELETE ON "HrApprovalReceipt" FOR EACH ROW EXECUTE FUNCTION hr_approval_history_immutable();

-- Protect every status write, including legacy REST/MCP/generic update paths.
CREATE FUNCTION hr_approval_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb; requested text; expected text; rec record; field text; changed boolean:=false;
BEGIN
 IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
 requested:=n->>TG_ARGV[1];
 IF requested IN ('CANCELLED','WITHDRAWN') AND (TG_OP='INSERT' OR requested IS DISTINCT FROM o->>TG_ARGV[1]) AND EXISTS(SELECT 1 FROM "HrApprovalRequest" r WHERE r."tenantId"=(n->>'tenantId')::uuid AND r.kind=TG_ARGV[0] AND split_part(r."sourceRef",'@',1)=n->>'id') THEN
  IF current_setting('app.hr_approval_finalizing',true) IS DISTINCT FROM TG_ARGV[0]||':'||(n->>'id') OR NOT EXISTS(SELECT 1 FROM "HrApprovalRequest" r WHERE r."tenantId"=(n->>'tenantId')::uuid AND r.kind=TG_ARGV[0] AND r."sourceRef"=n->>'id' AND r.stage='WITHDRAWN') THEN RAISE EXCEPTION 'HR-4201: Withdraw the request through HR Approval Centre'; END IF;
 END IF;
 IF requested=ANY(string_to_array(TG_ARGV[2],',')) THEN expected:='APPROVED';
 ELSIF requested=ANY(string_to_array(TG_ARGV[3],',')) THEN expected:='REJECTED'; END IF;
 IF expected IS NOT NULL AND (TG_OP='INSERT' OR requested IS DISTINCT FROM o->>TG_ARGV[1]) THEN
  IF current_setting('app.hr_approval_finalizing',true) IS DISTINCT FROM TG_ARGV[0]||':'||(n->>'id')
    OR NOT EXISTS(SELECT 1 FROM "HrApprovalRequest" r WHERE r."tenantId"=(n->>'tenantId')::uuid AND r.kind=TG_ARGV[0] AND split_part(r."sourceRef",'@',1)=n->>'id' AND r.stage=expected)
  THEN RAISE EXCEPTION 'HR-4201: Complete the staged approval in HR Approval Centre'; END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  -- The initiator cannot be substituted after submission.
  IF n->TG_ARGV[4] IS DISTINCT FROM o->TG_ARGV[4]
   AND NOT (TG_ARGV[4]='employeeCode' AND EXISTS(SELECT 1 FROM "AssessmentCodeChange" c WHERE c.id=nullif(current_setting('app.assessment_code_change',true),'')::uuid AND c."tenantId"=(n->>'tenantId')::uuid AND c."oldCode"=o->>TG_ARGV[4] AND c."newCode"=n->>TG_ARGV[4]))
   AND EXISTS(SELECT 1 FROM "HrApprovalRequest" r WHERE r."tenantId"=(n->>'tenantId')::uuid AND r.kind=TG_ARGV[0] AND split_part(r."sourceRef",'@',1)=n->>'id') THEN RAISE EXCEPTION 'HR-4203: A submitted request cannot change its initiator'; END IF;
  FOR rec IN SELECT stage FROM "HrApprovalRequest" r WHERE r."tenantId"=(n->>'tenantId')::uuid AND r.kind=TG_ARGV[0] AND split_part(r."sourceRef",'@',1)=n->>'id' AND r.stage='APPROVED' LOOP
   FOREACH field IN ARRAY string_to_array(TG_ARGV[5],',') LOOP
    IF n->field IS DISTINCT FROM o->field THEN changed:=true; END IF;
   END LOOP;
   IF changed AND current_setting('app.hr_approval_finalizing',true) IS DISTINCT FROM TG_ARGV[0]||':'||(n->>'id') THEN RAISE EXCEPTION 'HR-4204: Approved request content is immutable; create a new request'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "leave_requests" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('LEAVE','status','APPROVED','REJECTED','employeeId','startDate,endDate,totalDays,reason,notes,leavePolicyId');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "overtime_requests" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('OVERTIME','status','APPROVED','REJECTED','employeeId','date,hours,rate,project,reason,fromTime,toTime,source');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "reimbursement_claims" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('CLAIM','status','APPROVED','REJECTED','employeeId','title,description,amount,currency,category,receiptMediaId,notes');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "loans" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('LOAN','status','ACTIVE','REJECTED','employeeId','principalMinor,interestRatePct,tenureMonths,disbursementDate,kind,monthlyInstallmentMinor,reason');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "Timesheet" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('TIMESHEET','status','APPROVED','REJECTED','employeeId','period_start,period_end,total_hours');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "shift_swap_requests" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('SHIFT_SWAP','status','APPROVED','REJECTED','requesterId','targetId,fromDate,toDate,shiftType,reason');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "Goal" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('GOAL','status','APPROVED','REJECTED','employeeId','title,description,category,start_date,end_date,target_value');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "JobRequisition" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('REQUISITION','status','APPROVED','REJECTED','requestedById','title,description,departmentId,positionId,openings,priority,requirements');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "payroll_runs" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('PAYROLL','status','APPROVED','REJECTED','processedBy','periodStart,periodEnd,countryCode,currencyCode,totalGross,totalDeductions,totalNet,employeeCount,ruleVersion,ratesEffectiveAt');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "attendance_anomalies" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('ATTENDANCE','status','APPROVED','REJECTED','employeeId','type,reason,detail,date,fromTime,toTime,rulesVersion,sessionKey,factHash,evidenceState,attachments,manualDeductionDays');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "PerformanceReview" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('PERFORMANCE','status','FINALIZED','','employeeId','cycleId,period_start,period_end,overall_rating,comments,type');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "offers" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('OFFER','status','SENT','','createdById','applicationId,candidateId,jobRequisitionId,salary,currency,startDate,expiryDate,notes,offerType,employmentType,terms,compensation');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON "EmployeeCategoryConversion" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('CATEGORY_CONVERSION','state','APPROVED','REJECTED','employeeCode','category,effectiveAt,reason');

-- Existing unsigned, never-repaid loans need a fresh employee submission.
UPDATE loans l SET status='PENDING' WHERE status='ACTIVE' AND "approvedById" IS NULL AND NOT EXISTS(SELECT 1 FROM loan_repayments r WHERE r."loanId"=l.id);

CREATE TRIGGER hr_approval_guard_writeoff BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('LOAN_WRITEOFF','status','WRITTEN_OFF','','employeeId','principalMinor,outstandingMinor,kind,reason');

CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON attendance_time_credits FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('TIME_CREDIT','state','APPROVED','REJECTED','employeeId','date,kind,start,end,fromSiteId,toSiteId,paid,reason');
CREATE TRIGGER hr_approval_revoke_guard BEFORE UPDATE ON attendance_time_credits FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('TIME_CREDIT_REVOCATION','state','REVOKED','','employeeId','date,kind,start,end,fromSiteId,toSiteId,paid,reason');

-- A parent approval also freezes the financial/evidence lines that were reviewed.
-- Operational payslip status/distribution changes remain available.
CREATE FUNCTION hr_approval_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb; o jsonb; field text; approval record; changed boolean:=false;
BEGIN
 IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;
 IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF;
 IF TG_OP<>'UPDATE' THEN changed:=true;
 ELSE
  FOREACH field IN ARRAY string_to_array(TG_ARGV[2],',') LOOP
   IF n->field IS DISTINCT FROM o->field THEN changed:=true; END IF;
  END LOOP;
 END IF;
 IF changed THEN
  -- Serialize line edits with the parent's decision. Do not filter by stage
  -- before locking: an approval may be committing while this edit waits.
  FOR approval IN SELECT r.stage FROM "HrApprovalRequest" r WHERE r."tenantId"=coalesce(n->>'tenantId',o->>'tenantId')::uuid AND r.kind=TG_ARGV[0] AND r."sourceRef" IN (n->>TG_ARGV[1],o->>TG_ARGV[1]) ORDER BY r.id FOR UPDATE LOOP
   IF approval.stage='APPROVED' THEN RAISE EXCEPTION 'HR-4204: Approved request lines are immutable; create a new request'; END IF;
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_approval_line_guard BEFORE INSERT OR UPDATE OR DELETE ON claim_items FOR EACH ROW EXECUTE FUNCTION hr_approval_line_guard('CLAIM','claimId','claimId,tenantId,name,description,amount,mediaId');
CREATE TRIGGER hr_approval_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "TimeEntry" FOR EACH ROW EXECUTE FUNCTION hr_approval_line_guard('TIMESHEET','timesheetId','timesheetId,tenantId,employeeId,work_date,start_time,end_time,duration_minutes,work_type,entry_type,note');
CREATE TRIGGER hr_approval_line_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_payslips FOR EACH ROW EXECUTE FUNCTION hr_approval_line_guard('PAYROLL','payrollRunId','payrollRunId,tenantId,employeeId,grossAmount,totalDeductions,netAmount,ruleVersion');
