-- T-P1: a published payroll config snapshot is the record of the rules a payroll run was priced with. It is
-- described as immutable, but nothing enforced it. Code only ever inserts snapshots and the table has no
-- foreign keys in either direction, so they become append-only. (Same guard function as the X4 audit tables.)
CREATE OR REPLACE FUNCTION audit_row_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HR-4203: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

DROP TRIGGER IF EXISTS payroll_config_snapshots_immutable ON payroll_config_snapshots;
CREATE TRIGGER payroll_config_snapshots_immutable BEFORE UPDATE OR DELETE ON payroll_config_snapshots
  FOR EACH ROW EXECUTE FUNCTION audit_row_immutable();
