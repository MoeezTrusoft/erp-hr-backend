-- PM availability snapshots (ported from HR PR #22, originally dated
-- 20261009011000; re-stamped after 20261015120000_hr_approval_workflow so it
-- applies in order on current main).
--
-- WHAT IS EMITTED
--   hr.availability.changed.v1 (contracts events/pm-execution
--   HrAvailabilityChangedV1), one FULL SNAPSHOT per (tenant, employee):
--     { employeeId, userId|null, available, sourceVersion, exceptions[],
--       exceptionsFrom, exceptionsTruncated }
--   The dispatcher routes this name to the pm:source-events stream. PM keeps
--   the snapshot with the highest sourceVersion and replaces its projection,
--   so every event carries everything PM needs; there are no deltas.
--
-- SNAPSHOT BOUNDS (documented cap)
--   * exceptions only include approved leave and assigned holidays whose end
--     date is on or after exceptionsFrom = CURRENT_DATE - 90 days. Older items
--     cannot affect forward scheduling and would grow the payload forever.
--   * at most 1000 exceptions, nearest first (startDate, then source). When
--     more exist, exceptionsTruncated is true and the furthest-future items are
--     left out until earlier ones age out of the window. The contracts schema
--     allows 20000; 1000 keeps one stream entry well under ~150 KB.
--   * legacy "Leave" rows that mirror an approved leave_request (same
--     employee and dates, written by upsertLegacyLeaveMirror) are skipped so a
--     half-day request is not widened into a precise full-day duplicate.
--
-- COALESCING
--   Row triggers only record (txid, tenant, employee) in
--   hr_pm_availability_pending (ON CONFLICT DO NOTHING). A DEFERRABLE
--   INITIALLY DEFERRED constraint trigger on that table publishes once per
--   employee per transaction at commit, from the final committed state. A bulk
--   holiday load for a calendar of N employees therefore emits N events, not
--   N x holidays, and an approval that touches leave_requests and the legacy
--   mirror in one transaction emits one snapshot.
--
-- Trigger functions run as the invoking role (no SECURITY DEFINER), so FORCE
-- RLS applies exactly as for the source write. hr_outbox_wake() is a LISTEN
-- wake for src/jobs/outbox-wake.job.js; durable outbox rows stay authoritative.
BEGIN;
SELECT set_config('app.tenant_bypass','on',true);

CREATE TABLE hr_pm_availability_versions(
  "tenantId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY("tenantId","employeeId")
);
CREATE TABLE hr_pm_availability_pending(
  txid BIGINT NOT NULL,
  "tenantId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  PRIMARY KEY(txid,"tenantId","employeeId")
);

-- PM availability triggers (tests apply the migration from this marker on a
-- schema generated from prisma/schema.prisma, which already has both tables).
DO $$ DECLARE tab TEXT; BEGIN
  FOREACH tab IN ARRAY ARRAY['hr_pm_availability_versions','hr_pm_availability_pending'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',tab);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hr_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app',tab);
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION hr_publish_pm_availability(tid UUID, eid INTEGER) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  max_items CONSTANT INTEGER := 1000;
  window_from DATE := CURRENT_DATE - 90;
  rev BIGINT;
  event_id TEXT := gen_random_uuid()::TEXT;
  occurred TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  items JSONB;
  item_count INTEGER;
  account_id INTEGER;
  available BOOLEAN;
BEGIN
  IF tid IS NULL OR eid IS NULL THEN RETURN; END IF;
  SELECT CASE WHEN e."userId" > 0 THEN e."userId" END,
         concat_ws(' ', e.status, e.employement_status) !~* '(inactive|terminated|exited|offboard|separated|suspended)'
           AND (e."separatedAt" IS NULL OR e."separatedAt" > CURRENT_TIMESTAMP)
    INTO account_id, available
    FROM "Employee" e WHERE e.id = eid AND e.tenant_id = tid;
  IF NOT FOUND THEN account_id := NULL; available := false; END IF;

  INSERT INTO hr_pm_availability_versions("tenantId","employeeId") VALUES (tid, eid)
  ON CONFLICT ("tenantId","employeeId") DO UPDATE SET version = hr_pm_availability_versions.version + 1
  RETURNING version INTO rev;

  SELECT COALESCE(jsonb_agg(item ORDER BY start_on, source) FILTER (WHERE rn <= max_items), '[]'::jsonb),
         count(*)
    INTO items, item_count
    FROM (
      SELECT source, start_on, item, row_number() OVER (ORDER BY start_on, source) rn
        FROM (
          SELECT 'request:' || r.id AS source, r."startDate"::date AS start_on,
                 jsonb_build_object('source', 'request:' || r.id, 'kind', 'LEAVE',
                   'startDate', r."startDate"::date::text, 'endDate', r."endDate"::date::text,
                   'precise', r."totalDays" = floor(r."totalDays")) AS item
            FROM leave_requests r
           WHERE r."tenantId" = tid AND r."employeeId" = eid AND r.status = 'APPROVED'
             AND r."endDate"::date >= window_from AND r."endDate" >= r."startDate"
          UNION ALL
          SELECT 'leave:' || l.id, l.start_date::date,
                 jsonb_build_object('source', 'leave:' || l.id, 'kind', 'LEAVE',
                   'startDate', l.start_date::date::text, 'endDate', l.end_date::date::text,
                   'precise', true)
            FROM "Leave" l
           WHERE l."tenantId" = tid AND l."employeeId" = eid AND l.status = 'APPROVED'
             AND l.end_date::date >= window_from AND l.end_date >= l.start_date
             AND NOT EXISTS (
               SELECT 1 FROM leave_requests m
                WHERE m."tenantId" = tid AND m."employeeId" = eid AND m.status = 'APPROVED'
                  AND m."startDate" = l.start_date AND m."endDate" = l.end_date)
          UNION ALL
          SELECT DISTINCT 'holiday:' || h.id, h.date::date,
                 jsonb_build_object('source', 'holiday:' || h.id, 'kind', 'HOLIDAY',
                   'startDate', h.date::date::text, 'endDate', h.date::date::text,
                   'precise', h."fullDay")
            FROM holidays h
            JOIN employee_holiday_calendars c
              ON c."holidayCalendarId" = h."holidayCalendarId" AND c."tenantId" = h."tenantId"
           WHERE h."tenantId" = tid AND c."employeeId" = eid AND h.date::date >= window_from
             AND h.date::date >= c."effectiveFrom"::date
             AND (c."effectiveTo" IS NULL OR h.date::date <= c."effectiveTo"::date)
        ) inputs
    ) ranked;

  INSERT INTO outbox_events(id, "tenantId", "eventName", "aggregateType", "aggregateId", payload)
  VALUES (event_id, tid, 'hr.availability.changed.v1', 'Employee', eid::text,
    jsonb_build_object(
      'id', event_id, 'name', 'hr.availability.changed.v1', 'tenantId', tid::text, 'version', 1,
      'occurredAt', occurred, 'actor', jsonb_build_object('type', 'service', 'id', 'erp-hr-backend'),
      'correlationId', event_id,
      'payload', jsonb_build_object(
        'employeeId', eid, 'userId', account_id, 'available', COALESCE(available, false),
        'sourceVersion', rev::text, 'exceptions', items,
        'exceptionsFrom', window_from::text, 'exceptionsTruncated', item_count > max_items)));
END $$;

-- Record one pending (tx, tenant, employee); the deferred trigger publishes it.
CREATE FUNCTION hr_queue_pm_availability(tid UUID, eid INTEGER) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF tid IS NULL OR eid IS NULL THEN RETURN; END IF;
  INSERT INTO hr_pm_availability_pending(txid, "tenantId", "employeeId")
  VALUES (txid_current(), tid, eid) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION hr_pm_availability_flush() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM hr_publish_pm_availability(NEW."tenantId", NEW."employeeId");
  DELETE FROM hr_pm_availability_pending
   WHERE txid = NEW.txid AND "tenantId" = NEW."tenantId" AND "employeeId" = NEW."employeeId";
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER hr_pm_availability_flush AFTER INSERT ON hr_pm_availability_pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hr_pm_availability_flush();

CREATE FUNCTION hr_pm_availability_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rows_seen JSONB[];
  data JSONB;
  tid UUID;
BEGIN
  rows_seen := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[to_jsonb(NEW)]
    WHEN 'DELETE' THEN ARRAY[to_jsonb(OLD)]
    ELSE ARRAY[to_jsonb(OLD), to_jsonb(NEW)] END;
  FOREACH data IN ARRAY rows_seen LOOP
    tid := COALESCE(data->>'tenantId', data->>'tenant_id')::UUID;
    IF tid IS NULL THEN CONTINUE; END IF;
    IF TG_TABLE_NAME = 'holidays' THEN
      INSERT INTO hr_pm_availability_pending(txid, "tenantId", "employeeId")
      SELECT DISTINCT txid_current(), tid, c."employeeId"
        FROM employee_holiday_calendars c
       WHERE c."tenantId" = tid AND c."holidayCalendarId" = (data->>'holidayCalendarId')::INTEGER
      ON CONFLICT DO NOTHING;
    ELSIF TG_TABLE_NAME = 'Employee' THEN
      PERFORM hr_queue_pm_availability(tid, (data->>'id')::INTEGER);
    ELSE
      PERFORM hr_queue_pm_availability(tid, (data->>'employeeId')::INTEGER);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Leave only changes availability while approved (before or after the write).
CREATE TRIGGER hr_pm_leave_ins AFTER INSERT ON leave_requests FOR EACH ROW
  WHEN (NEW.status = 'APPROVED') EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_leave_upd AFTER UPDATE ON leave_requests FOR EACH ROW
  WHEN ((OLD.status = 'APPROVED' OR NEW.status = 'APPROVED') AND (
    OLD.status IS DISTINCT FROM NEW.status OR OLD."startDate" IS DISTINCT FROM NEW."startDate"
    OR OLD."endDate" IS DISTINCT FROM NEW."endDate" OR OLD."totalDays" IS DISTINCT FROM NEW."totalDays"
    OR OLD."employeeId" IS DISTINCT FROM NEW."employeeId" OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"))
  EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_leave_del AFTER DELETE ON leave_requests FOR EACH ROW
  WHEN (OLD.status = 'APPROVED') EXECUTE FUNCTION hr_pm_availability_change();

CREATE TRIGGER hr_pm_legacy_leave_ins AFTER INSERT ON "Leave" FOR EACH ROW
  WHEN (NEW.status = 'APPROVED') EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_legacy_leave_upd AFTER UPDATE ON "Leave" FOR EACH ROW
  WHEN ((OLD.status = 'APPROVED' OR NEW.status = 'APPROVED') AND (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.start_date IS DISTINCT FROM NEW.start_date
    OR OLD.end_date IS DISTINCT FROM NEW.end_date OR OLD."employeeId" IS DISTINCT FROM NEW."employeeId"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"))
  EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_legacy_leave_del AFTER DELETE ON "Leave" FOR EACH ROW
  WHEN (OLD.status = 'APPROVED') EXECUTE FUNCTION hr_pm_availability_change();

CREATE TRIGGER hr_pm_holiday_insdel AFTER INSERT OR DELETE ON holidays FOR EACH ROW
  EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_holiday_upd AFTER UPDATE ON holidays FOR EACH ROW
  WHEN (OLD.date IS DISTINCT FROM NEW.date OR OLD."fullDay" IS DISTINCT FROM NEW."fullDay"
    OR OLD."holidayCalendarId" IS DISTINCT FROM NEW."holidayCalendarId"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
  EXECUTE FUNCTION hr_pm_availability_change();

CREATE TRIGGER hr_pm_calendar AFTER INSERT OR UPDATE OR DELETE ON employee_holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION hr_pm_availability_change();

CREATE TRIGGER hr_pm_employee_insdel AFTER INSERT OR DELETE ON "Employee" FOR EACH ROW
  EXECUTE FUNCTION hr_pm_availability_change();
CREATE TRIGGER hr_pm_employee_upd AFTER UPDATE ON "Employee" FOR EACH ROW
  WHEN (OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD.employement_status IS DISTINCT FROM NEW.employement_status
    OR OLD.status IS DISTINCT FROM NEW.status OR OLD."separatedAt" IS DISTINCT FROM NEW."separatedAt"
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION hr_pm_availability_change();

CREATE FUNCTION hr_outbox_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('hr_outbox', 'changed');
  RETURN NULL;
END $$;
CREATE TRIGGER hr_outbox_immediate AFTER INSERT ON outbox_events FOR EACH STATEMENT
  EXECUTE FUNCTION hr_outbox_wake();

-- Initial projection: one snapshot per tenant-owned employee.
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT id, tenant_id FROM "Employee" WHERE tenant_id IS NOT NULL ORDER BY id LOOP
    PERFORM hr_publish_pm_availability(r.tenant_id, r.id);
  END LOOP;
END $$;
COMMIT;
