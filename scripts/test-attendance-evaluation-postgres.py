"""Destructive only to an explicitly named disposable test database.
Exercises the evaluation migration, RLS and real PostgreSQL period locks.
Run with ATTENDANCE_TEST_DATABASE_URL; requires the psql client.
"""
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

url = os.environ["ATTENDANCE_TEST_DATABASE_URL"]
assert urlparse(url).path == "/hr_attendance_evaluation_test", "Disposable database name required"
assert urlparse(url).hostname in ("localhost", "127.0.0.1"), "Local test database required"
command = ["psql", url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]

def sql(statement, error=None):
    result = subprocess.run(command, input=statement, text=True, capture_output=True, timeout=15)
    if error:
        assert result.returncode != 0 and error in result.stderr, result.stderr
    else:
        assert result.returncode == 0, result.stderr
    return result.stdout.strip()

tenant = "10000000-0000-4000-8000-000000000001"
other = "20000000-0000-4000-8000-000000000002"
# Require an empty scratch database. Never drop or truncate an existing schema.
assert sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'") == "0"
sql('''CREATE TYPE "StatusAttendance" AS ENUM ('PRESENT','ABSENT');
CREATE TYPE "AnomalyStatus" AS ENUM ('PENDING','APPROVED');
CREATE TABLE "Attendance" (id SERIAL PRIMARY KEY, "tenantId" UUID NOT NULL,
 "employeeId" INTEGER NOT NULL, date TIMESTAMP NOT NULL, status "StatusAttendance" NOT NULL);
CREATE TABLE attendance_device_punches (id SERIAL PRIMARY KEY);
CREATE TABLE attendance_anomalies (id SERIAL PRIMARY KEY);
CREATE TABLE attendance_capture_devices (id UUID PRIMARY KEY);
CREATE TABLE overtime_requests (id SERIAL PRIMARY KEY,"tenantId" UUID,"employeeId" INTEGER,date TIMESTAMP,status TEXT);
CREATE TABLE payroll_runs (id SERIAL PRIMARY KEY,"tenantId" UUID NOT NULL,
 "periodStart" TIMESTAMP NOT NULL,"periodEnd" TIMESTAMP NOT NULL,status TEXT NOT NULL);
CREATE FUNCTION public.hr_current_tenant() RETURNS UUID LANGUAGE SQL STABLE AS
 $$ SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid $$;
CREATE ROLE attendance_evaluation_test_actor NOLOGIN;
''')
sql(Path("prisma/migrations/20261011000000_attendance_evaluation/migration.sql").read_text())
sql("GRANT USAGE ON SCHEMA public TO attendance_evaluation_test_actor; GRANT ALL ON ALL TABLES IN SCHEMA public TO attendance_evaluation_test_actor;")
context = f"SET ROLE attendance_evaluation_test_actor; SELECT set_config('app.tenant_id','{tenant}',false);"
sql(f'''INSERT INTO "Attendance" ("tenantId","employeeId",date,status) VALUES ('{tenant}',1,'2026-10-01','PRESENT');''')
sql(context + f'''INSERT INTO attendance_evaluation_cursors ("tenantId","plannedThrough","updatedAt") VALUES ('{tenant}','2026-10-01',now());''')
assert sql(f"SET ROLE attendance_evaluation_test_actor; SELECT set_config('app.tenant_id','{other}',false); SELECT count(*) FROM attendance_evaluation_cursors").splitlines()[-1] == "0"
sql(context + f'''INSERT INTO attendance_evaluation_cursors ("tenantId","plannedThrough","updatedAt") VALUES ('{other}','2026-10-01',now());''', "row-level security")
assert sql("SELECT count(*) FROM pg_class WHERE relname IN ('attendance_sessions','attendance_evaluations','attendance_evaluation_jobs','attendance_evaluation_cursors','attendance_time_credits') AND relrowsecurity AND relforcerowsecurity") == "5"
sql(f'''INSERT INTO payroll_runs ("tenantId","periodStart","periodEnd",status) VALUES ('{tenant}','2026-10-01','2026-10-31 23:59:59','PENDING');''')
for statement in [
    '''UPDATE "Attendance" SET status='ABSENT' WHERE id=1''',
    'DELETE FROM "Attendance" WHERE id=1',
    f'''INSERT INTO "Attendance" ("tenantId","employeeId",date,status) VALUES ('{tenant}',2,'2026-10-02','PRESENT')''',
]:
    sql(statement, "PERIOD_PROTECTED")
sql('UPDATE "Attendance" SET "employeeId"=2 WHERE id=1', "immutable")
sql("UPDATE payroll_runs SET status='CANCELLED' WHERE id=1")
sql('''UPDATE "Attendance" SET status='ABSENT' WHERE id=1''')
sql(f"INSERT INTO overtime_requests (\"tenantId\",\"employeeId\",date,status) VALUES ('{tenant}',1,'2026-10-01','APPROVED')")
assert sql("SELECT count(*) FROM attendance_evaluation_jobs WHERE state='PENDING'") == '1'
# Prove submission cannot race a running attendance write.
holder = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
holder.stdin.write('''BEGIN; UPDATE "Attendance" SET status='PRESENT' WHERE id=1; SELECT pg_sleep(3); COMMIT;''')
holder.stdin.close()
try:
    for _ in range(30):
        if sql("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND mode='ShareLock' AND granted") != "0":
            break
        time.sleep(0.05)
    else:
        raise AssertionError("Attendance write did not acquire its shared lock")
    sql(f'''SET lock_timeout='100ms'; INSERT INTO payroll_runs ("tenantId","periodStart","periodEnd",status) VALUES ('{tenant}','2026-10-01','2026-10-31','PENDING');''', "lock timeout")
finally:
    holder.wait(timeout=10)
    assert holder.returncode == 0, holder.stderr.read()
print("PASS: migration, enum/schema changes, tenant RLS, protected insert/update/delete, immutable identity and concurrent payroll lock")

# Stage four: run the new migration against the actual stage-three schema.
sql('''CREATE ROLE hr_app NOLOGIN;
CREATE TABLE payroll_payslips (id SERIAL PRIMARY KEY,"tenantId" UUID NOT NULL,"employeeId" INTEGER,
 "payrollRunId" INTEGER,"grossAmount" NUMERIC,"netAmount" NUMERIC,"totalDeductions" NUMERIC,
 "distributedAt" TIMESTAMP,status TEXT NOT NULL,"payableDays" NUMERIC);
CREATE TABLE payroll_deductions (id SERIAL PRIMARY KEY,"tenantId" UUID,"payslipId" INTEGER NOT NULL,amount NUMERIC);
GRANT SELECT ON payroll_payslips TO hr_app;
''')
sql(Path("prisma/migrations/20261012000000_attendance_anomaly_rules/migration.sql").read_text())
assert sql("SELECT count(*) FROM pg_class WHERE relname IN ('attendance_grace_rules','attendance_grace_memberships','attendance_manual_times','attendance_rule_audit','attendance_payroll_adjustments') AND relrowsecurity AND relforcerowsecurity") == "5"
app = f"SET ROLE hr_app; SELECT set_config('app.tenant_id','{tenant}',false);"
sql(app + f'''INSERT INTO attendance_grace_rules ("tenantId",scope,"scopeKey","effectiveFrom","checkInMinutes","actorId",reason) VALUES ('{tenant}','COMPANY','*','2026-10-01',0,'hr','Explicit zero');''')
assert sql(f"SET ROLE hr_app; SELECT set_config('app.tenant_id','{other}',false); SELECT count(*) FROM attendance_grace_rules").splitlines()[-1] == '0'
sql(app + f'''INSERT INTO attendance_grace_rules ("tenantId",scope,"scopeKey","effectiveFrom","actorId",reason) VALUES ('{other}','COMPANY','*','2026-10-01','hr','Cross tenant');''', 'row-level security')
sql(app + f'''INSERT INTO attendance_manual_times ("tenantId","employeeId",date,"sessionKey",direction,timestamp,"actorId",reason) VALUES ('{tenant}',1,'2026-10-01','s1','IN','2026-10-01 09:00','hr','Verified');
INSERT INTO attendance_rule_audit ("tenantId",action,"actorId",data) VALUES ('{tenant}','MANUAL_TIME_ENTERED','hr','{{}}');''')
for table in ['attendance_manual_times','attendance_rule_audit']:
    sql(app + f"DELETE FROM {table}",'append-only')
    sql(app + f"UPDATE {table} SET \"actorId\"='tampered'",'append-only')
sql('''UPDATE payroll_runs SET status='FINALIZED' WHERE id=1;''')
sql('''UPDATE "Attendance" SET calculation='{"algorithmVersion":"anomaly-rules-v2"}' WHERE id=1;''','PERIOD_PROTECTED')
sql('''BEGIN; SELECT set_config('app.attendance_rules_reconciliation','on',true);
UPDATE "Attendance" SET calculation='{"algorithmVersion":"anomaly-rules-v2"}',status='PRESENT' WHERE id=1; COMMIT;''')
sql('''BEGIN; SELECT set_config('app.attendance_rules_reconciliation','on',true); DELETE FROM "Attendance" WHERE id=1; COMMIT;''','PERIOD_PROTECTED')
sql(f'''INSERT INTO payroll_payslips ("tenantId","employeeId","payrollRunId","grossAmount","netAmount","totalDeductions",status)
 VALUES ('{tenant}',1,1,30000,29000,1000,'FINALIZED');
 INSERT INTO payroll_deductions ("tenantId","payslipId",amount) VALUES ('{tenant}',1,1000);
 UPDATE payroll_payslips SET status='DISTRIBUTED',"distributedAt"=now() WHERE id=1;''')
for change in ['UPDATE payroll_payslips SET "netAmount"=30000 WHERE id=1',
               "DELETE FROM payroll_payslips WHERE id=1",
               "UPDATE payroll_deductions SET amount=0 WHERE id=1",
               "DELETE FROM payroll_deductions WHERE id=1"]:
    sql(change,'Disbursed payroll')
# Historical adoption can add metadata, but never modify the paid money.
sql('''UPDATE payroll_payslips SET "attendanceBasisMinor"='3000000',"attendancePeriodDays"=30 WHERE id=1;''')
sql(app+f'''INSERT INTO attendance_payroll_adjustments ("tenantId","employeeId","sourcePayslipId","sourcePeriodEnd","currencyCode","amountMinor",revision)
 VALUES ('{tenant}',1,1,'2026-10-31','PKR','-100000',1);''')
sql(app+f'''INSERT INTO attendance_payroll_adjustments ("tenantId","employeeId","sourcePayslipId","sourcePeriodEnd","currencyCode","amountMinor",revision)
 VALUES ('{tenant}',1,1,'2026-10-31','PKR','-100000',1);''','duplicate key')
print("PASS: anomaly migration, grace/manual/audit RLS, append-only evidence, paid-money guards, reconciliation bypass and adjustment uniqueness")
