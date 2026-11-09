-- T1: a published attendance setup is the record of which policy judged which days, and so which
-- deductions were charged. The publish tool calls it "immutable" but nothing enforced it: the app role
-- could rewrite or delete a release and silently change how past days were evaluated. Code only ever
-- inserts releases, so they become append-only. (Same guard function as the X4 audit tables.)
CREATE OR REPLACE FUNCTION audit_row_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HR-4203: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

DROP TRIGGER IF EXISTS attendance_setup_releases_immutable ON attendance_setup_releases;
CREATE TRIGGER attendance_setup_releases_immutable BEFORE UPDATE OR DELETE ON attendance_setup_releases
  FOR EACH ROW EXECUTE FUNCTION audit_row_immutable();
