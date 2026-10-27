CREATE TABLE "CandidateTestItemExposure" (
 "tenantId" uuid NOT NULL,
 "itemId" integer NOT NULL,
 period date NOT NULL,
 "servedCount" integer NOT NULL CHECK ("servedCount">=0),
 PRIMARY KEY ("tenantId","itemId",period),
 CONSTRAINT "CandidateTestItemExposure_item_fk" FOREIGN KEY ("tenantId","itemId") REFERENCES "CandidateTestItem"("tenantId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
-- Count historical issued item versions from actual started sessions, never from
-- lifetime counters (which cannot identify the month in which an item was served).
INSERT INTO "CandidateTestItemExposure" ("tenantId","itemId",period,"servedCount")
 SELECT s."tenantId", (item->>'itemId')::integer, date_trunc('month',s."startedAt")::date, count(*)::integer
 FROM "CandidateTestSession" s CROSS JOIN LATERAL jsonb_array_elements(s."itemOrder") item
 JOIN "CandidateTestItem" i ON i.id=(item->>'itemId')::integer AND i."tenantId"=s."tenantId"
 WHERE s."startedAt" IS NOT NULL AND s."tenantId" IS NOT NULL
 GROUP BY s."tenantId", (item->>'itemId')::integer, date_trunc('month',s."startedAt")::date;
ALTER TABLE "CandidateTestItemExposure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestItemExposure" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestItemExposure_tenant_policy" ON "CandidateTestItemExposure"
 USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
 WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
