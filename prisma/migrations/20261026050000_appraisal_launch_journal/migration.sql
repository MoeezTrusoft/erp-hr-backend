CREATE TABLE "PerfLaunchRun" (
  id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "cycleId" UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','PAUSED','SUCCEEDED','CANCELLED')),
  version INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL CHECK(total>0),
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed>=0 AND processed<=total),
  "batchNo" INTEGER NOT NULL DEFAULT 0, "jobId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3), UNIQUE("tenantId",id), UNIQUE("tenantId","cycleId"),
  FOREIGN KEY("tenantId","cycleId") REFERENCES "PerfCycle"("tenantId",id)
);
CREATE TABLE "PerfLaunchBatch" (
  id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "runId" UUID NOT NULL,
  "batchNo" INTEGER NOT NULL CHECK("batchNo">0), "firstParticipantId" UUID NOT NULL,
  "lastParticipantId" UUID NOT NULL, count INTEGER NOT NULL CHECK(count>0 AND count<=250),
  digest TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("tenantId","runId","batchNo"),
  FOREIGN KEY("tenantId","runId") REFERENCES "PerfLaunchRun"("tenantId",id),
  FOREIGN KEY("tenantId","firstParticipantId") REFERENCES "PerfParticipant"("tenantId",id),
  FOREIGN KEY("tenantId","lastParticipantId") REFERENCES "PerfParticipant"("tenantId",id)
);
ALTER TABLE "PerfLaunchRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfLaunchRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY perf_tenant ON "PerfLaunchRun" USING ("tenantId"=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK ("tenantId"=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE "PerfLaunchBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfLaunchBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY perf_tenant ON "PerfLaunchBatch" USING ("tenantId"=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK ("tenantId"=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER perf_launch_batch_immutable BEFORE UPDATE OR DELETE ON "PerfLaunchBatch"
 FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE FUNCTION perf_launch_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."tenantId"<>OLD."tenantId" OR NEW."cycleId"<>OLD."cycleId" OR NEW.total<>OLD.total
    OR NEW."jobId"<>OLD."jobId" OR NEW.version<>OLD.version+1 OR NEW.processed<OLD.processed
    OR OLD.state IN ('SUCCEEDED','CANCELLED') THEN
    RAISE EXCEPTION 'Frozen launch identity, monotonic progress and version required' USING ERRCODE='23514';
  END IF;
  IF NEW.state='SUCCEEDED' AND (NEW.processed<>NEW.total OR NEW."completedAt" IS NULL) THEN
    RAISE EXCEPTION 'Complete roster required before launch success' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perf_launch_run_guard BEFORE UPDATE ON "PerfLaunchRun" FOR EACH ROW EXECUTE FUNCTION perf_launch_run_guard();
