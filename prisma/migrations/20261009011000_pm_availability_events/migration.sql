BEGIN;
SELECT set_config('app.tenant_bypass','on',true);
CREATE TABLE hr_pm_availability_versions("tenantId" UUID NOT NULL,"employeeId" INTEGER NOT NULL,version BIGINT NOT NULL DEFAULT 1,PRIMARY KEY("tenantId","employeeId"));
ALTER TABLE hr_pm_availability_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_pm_availability_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY hr_pm_availability_tenant ON hr_pm_availability_versions USING ("tenantId"::text=current_setting('app.tenant_id',true) OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"::text=current_setting('app.tenant_id',true) OR current_setting('app.tenant_bypass',true)='on');

CREATE FUNCTION hr_publish_pm_availability(tid UUID,eid INTEGER) RETURNS void LANGUAGE plpgsql AS $$
DECLARE rev BIGINT; event_id TEXT:=gen_random_uuid()::TEXT; exceptions JSONB; account_id INTEGER; available BOOLEAN;
BEGIN
 IF tid IS NULL THEN RETURN; END IF;
 SELECT "userId",lower(COALESCE(employement_status,'active'))='active' AND lower(COALESCE(status,'active')) NOT IN ('inactive','terminated','suspended') INTO account_id,available FROM "Employee" WHERE id=eid AND tenant_id=tid;
 IF NOT FOUND THEN available:=false; END IF;
 INSERT INTO hr_pm_availability_versions("tenantId","employeeId") VALUES(tid,eid)
 ON CONFLICT("tenantId","employeeId") DO UPDATE SET version=hr_pm_availability_versions.version+1 RETURNING version INTO rev;
 SELECT COALESCE(jsonb_agg(item ORDER BY source),'[]'::jsonb) INTO exceptions FROM (
   SELECT 'request:'||id source,jsonb_build_object('source','request:'||id,'kind','LEAVE','startDate',"startDate"::date::text,'endDate',"endDate"::date::text,'precise',"totalDays"=floor("totalDays")) item
   FROM leave_requests WHERE "tenantId"=tid AND "employeeId"=eid AND status='APPROVED'
   UNION ALL
   SELECT 'leave:'||id,jsonb_build_object('source','leave:'||id,'kind','LEAVE','startDate',start_date::date::text,'endDate',end_date::date::text,'precise',true)
   FROM "Leave" WHERE "tenantId"=tid AND "employeeId"=eid AND status='APPROVED'
   UNION ALL
   SELECT 'holiday:'||h.id,jsonb_build_object('source','holiday:'||h.id,'kind','HOLIDAY','startDate',h.date::date::text,'endDate',h.date::date::text,'precise',h."fullDay")
   FROM holidays h JOIN employee_holiday_calendars c ON c."holidayCalendarId"=h."holidayCalendarId" AND c."tenantId"=h."tenantId"
   WHERE h."tenantId"=tid AND c."employeeId"=eid AND h.date>=c."effectiveFrom"::date AND (c."effectiveTo" IS NULL OR h.date<=c."effectiveTo")
 ) inputs;
 INSERT INTO outbox_events(id,"tenantId","eventName","aggregateType","aggregateId",payload)
 VALUES(event_id,tid,'hr.availability.changed.v1','Employee',eid::text,jsonb_build_object('id',event_id,'name','hr.availability.changed.v1','tenantId',tid::text,'version',1,'occurredAt',CURRENT_TIMESTAMP,'actor',jsonb_build_object('type','service','id','erp-hr-backend'),'correlationId',event_id,
 'payload',jsonb_build_object('employeeId',eid,'userId',account_id,'available',available,'sourceVersion',rev::text,'exceptions',exceptions)));
END $$;

CREATE FUNCTION hr_pm_availability_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data JSONB; old_data JSONB; tid UUID; eid INTEGER; r RECORD;
BEGIN
 row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 tid:=COALESCE(row_data->>'tenantId',row_data->>'tenant_id')::UUID;
 IF tid IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_TABLE_NAME='holidays' THEN
   FOR r IN SELECT DISTINCT "employeeId" FROM employee_holiday_calendars WHERE "tenantId"=tid AND "holidayCalendarId"=(row_data->>'holidayCalendarId')::INTEGER LOOP PERFORM hr_publish_pm_availability(tid,r."employeeId"); END LOOP;
 ELSE
   eid:=CASE WHEN TG_TABLE_NAME='Employee' THEN (row_data->>'id')::INTEGER ELSE (row_data->>'employeeId')::INTEGER END;
   PERFORM hr_publish_pm_availability(tid,eid);
 END IF;
 IF TG_OP='UPDATE' THEN
   old_data:=to_jsonb(OLD);
   IF old_data->>'employeeId' IS DISTINCT FROM row_data->>'employeeId' THEN PERFORM hr_publish_pm_availability(COALESCE(old_data->>'tenantId',old_data->>'tenant_id')::UUID,(old_data->>'employeeId')::INTEGER); END IF;
   IF TG_TABLE_NAME='holidays' AND old_data->>'holidayCalendarId' IS DISTINCT FROM row_data->>'holidayCalendarId' THEN
     FOR r IN SELECT DISTINCT "employeeId" FROM employee_holiday_calendars WHERE "tenantId"=tid AND "holidayCalendarId"=(old_data->>'holidayCalendarId')::INTEGER LOOP PERFORM hr_publish_pm_availability(tid,r."employeeId"); END LOOP;
   END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER hr_pm_leave AFTER INSERT OR UPDATE OR DELETE ON leave_requests FOR EACH ROW EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_legacy_leave AFTER INSERT OR UPDATE OR DELETE ON "Leave" FOR EACH ROW EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_holiday AFTER INSERT OR UPDATE OR DELETE ON holidays FOR EACH ROW EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_calendar AFTER INSERT OR UPDATE OR DELETE ON employee_holiday_calendars FOR EACH ROW EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_employee AFTER INSERT OR UPDATE OF "userId",employement_status,status OR DELETE ON "Employee" FOR EACH ROW EXECUTE FUNCTION hr_pm_availability_change();
CREATE FUNCTION hr_outbox_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('hr_outbox','changed'); RETURN NEW; END $$;
CREATE TRIGGER hr_outbox_immediate AFTER INSERT ON outbox_events FOR EACH STATEMENT EXECUTE FUNCTION hr_outbox_wake();
DO $$ DECLARE r RECORD; BEGIN FOR r IN SELECT id,tenant_id FROM "Employee" WHERE tenant_id IS NOT NULL ORDER BY id LOOP PERFORM hr_publish_pm_availability(r.tenant_id,r.id); END LOOP; END $$;
COMMIT;
