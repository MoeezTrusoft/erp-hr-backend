-- HR-LOAN-WITHDRAW-01 (2026-11-27): an employee may withdraw their own loan or
-- salary advance request while it waits for approval, as they can a leave,
-- overtime or claim request. Additive only: nothing writes the value until the
-- release that allows the withdrawal ships.
ALTER TYPE "LoanStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';
