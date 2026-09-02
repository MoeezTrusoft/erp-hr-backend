-- HR-PAYROLL-EOBI-01 — Pakistani EOBI as configuration, disabled everywhere.
--
-- EOBI was hardcoded as 1% of GROSS with no cap, under a comment claiming a
-- PKR 17,000 ceiling that was never implemented. On a PKR 200,000 salary that
-- is PKR 2,000 a month instead of PKR 170.
--
-- These columns make the assessable base and rate configurable per tenant.
-- eobiEnabled DEFAULTS TO FALSE so every existing tenant backfills to "off":
-- the figures below are the ones the original comment named, not ones anyone
-- has confirmed against a filed return, and a plausible default that silently
-- deducts is worse than no deduction line at all. Turning it on is deliberate.
--
-- Additive only. Safe against the still-running previous image, which simply
-- does not select these columns.
ALTER TABLE "payroll_rule_config"
  ADD COLUMN IF NOT EXISTS "eobiEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "eobiEmployeeRatePct" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "eobiWageCeilingMinor" INTEGER NOT NULL DEFAULT 1700000;
