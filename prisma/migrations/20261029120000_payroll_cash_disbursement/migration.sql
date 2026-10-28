-- Banking paused: a company that pays in cash does not need employee bank details to finalize payroll.
ALTER TABLE "payroll_rule_config" ADD COLUMN "cashDisbursement" BOOLEAN NOT NULL DEFAULT false;
