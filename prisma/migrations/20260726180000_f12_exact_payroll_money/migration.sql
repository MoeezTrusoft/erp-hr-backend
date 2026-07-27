-- F-12 / ARCH-01 §2.3, §5.1 / ARCH-06 C-06.
-- Explicit staged in-place conversion: preflight first, then one widening exact
-- numeric conversion per table. No columns/constraints are dropped or renamed.
-- Existing finite Float values are preserved at the governed 4-decimal scale
-- using PostgreSQL numeric ROUND, and out-of-range data aborts before any DDL.

DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM (
    SELECT "totalGross" AS value FROM "payroll_runs" WHERE "totalGross" IS NOT NULL
    UNION ALL SELECT "totalDeductions" FROM "payroll_runs" WHERE "totalDeductions" IS NOT NULL
    UNION ALL SELECT "totalNet" FROM "payroll_runs" WHERE "totalNet" IS NOT NULL
    UNION ALL SELECT "grossAmount" FROM "payroll_payslips"
    UNION ALL SELECT "totalDeductions" FROM "payroll_payslips"
    UNION ALL SELECT "netAmount" FROM "payroll_payslips"
    UNION ALL SELECT "amount" FROM "payroll_earnings"
    UNION ALL SELECT "amount" FROM "payroll_deductions"
    UNION ALL SELECT "amount" FROM "payroll_assignments" WHERE "amount" IS NOT NULL
    UNION ALL SELECT "bracketMin" FROM "tax_rates"
    UNION ALL SELECT "bracketMax" FROM "tax_rates" WHERE "bracketMax" IS NOT NULL
    UNION ALL SELECT "baseTax" FROM "tax_rates"
    UNION ALL SELECT "thresholdAmount" FROM "payroll_approval_matrix" WHERE "thresholdAmount" IS NOT NULL
  ) monetary
  WHERE value::text IN ('NaN', 'Infinity', '-Infinity')
     OR abs(value) > 99999999999999.9999;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'F-12 migration blocked: % non-finite/out-of-range monetary values', invalid_count;
  END IF;
END $$;

ALTER TABLE "payroll_runs"
  ALTER COLUMN "totalGross" TYPE DECIMAL(18,4) USING ROUND("totalGross"::numeric, 4),
  ALTER COLUMN "totalDeductions" TYPE DECIMAL(18,4) USING ROUND("totalDeductions"::numeric, 4),
  ALTER COLUMN "totalNet" TYPE DECIMAL(18,4) USING ROUND("totalNet"::numeric, 4);

ALTER TABLE "payroll_payslips"
  ALTER COLUMN "grossAmount" TYPE DECIMAL(18,4) USING ROUND("grossAmount"::numeric, 4),
  ALTER COLUMN "totalDeductions" TYPE DECIMAL(18,4) USING ROUND("totalDeductions"::numeric, 4),
  ALTER COLUMN "netAmount" TYPE DECIMAL(18,4) USING ROUND("netAmount"::numeric, 4);

ALTER TABLE "payroll_earnings"
  ALTER COLUMN "amount" TYPE DECIMAL(18,4) USING ROUND("amount"::numeric, 4);

ALTER TABLE "payroll_deductions"
  ALTER COLUMN "amount" TYPE DECIMAL(18,4) USING ROUND("amount"::numeric, 4);

ALTER TABLE "payroll_assignments"
  ALTER COLUMN "amount" TYPE DECIMAL(18,4) USING ROUND("amount"::numeric, 4);

ALTER TABLE "tax_rates"
  ALTER COLUMN "bracketMin" TYPE DECIMAL(18,4) USING ROUND("bracketMin"::numeric, 4),
  ALTER COLUMN "bracketMax" TYPE DECIMAL(18,4) USING ROUND("bracketMax"::numeric, 4),
  ALTER COLUMN "baseTax" TYPE DECIMAL(18,4) USING ROUND("baseTax"::numeric, 4);

ALTER TABLE "payroll_approval_matrix"
  ALTER COLUMN "thresholdAmount" TYPE DECIMAL(18,4) USING ROUND("thresholdAmount"::numeric, 4);
