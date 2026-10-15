CREATE TABLE "HrSetupTask" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "taskKey" TEXT NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1, "payload" JSONB NOT NULL,
 "editorUserIds" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "HrSetupTask_tenantId_taskKey_key" ON "HrSetupTask"("tenantId","taskKey");
CREATE TABLE "HrSetupEvidence" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "taskKey" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "content" TEXT NOT NULL, "uploadedByCode" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HrSetupEvidence_tenantId_taskKey_idx" ON "HrSetupEvidence"("tenantId","taskKey");
-- TRACKER_SECURITY: loaded after generated tables in isolated regression tests.
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['HrSetupTask','HrSetupEvidence'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY setup_tenant ON %I USING ("tenantId" = public.hr_current_tenant()) WITH CHECK ("tenantId" = public.hr_current_tenant())',tab);
 END LOOP;
END $$;
CREATE TRIGGER setup_evidence_immutable BEFORE UPDATE OR DELETE ON "HrSetupEvidence" FOR EACH ROW EXECUTE FUNCTION hr_setup_append_only();
CREATE FUNCTION hr_setup_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Setup action history cannot be deleted'; END IF;
 IF NEW."tenantId" <> OLD."tenantId" OR NEW."taskKey" <> OLD."taskKey" THEN RAISE EXCEPTION 'Setup action subject is immutable'; END IF;
 IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'Action version must advance exactly once'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER setup_task_guard BEFORE UPDATE OR DELETE ON "HrSetupTask" FOR EACH ROW EXECUTE FUNCTION hr_setup_task_guard();
