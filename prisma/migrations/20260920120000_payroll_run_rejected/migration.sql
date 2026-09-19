-- HR-PAY-REJECT-01: preserve rejected payroll batches for correction and audit.
ALTER TYPE "PayrollRunStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
