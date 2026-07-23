-- API-2 · optimistic concurrency (X-07 / ARCH-01 §3.4).
--
-- Adds an integer `version` column to the seven aggregate roots that expose an
-- `hr_*_update` MCP tool. Every _update write bumps it (version = version + 1);
-- a caller-supplied `expectedVersion` that no longer matches the row's current
-- version is rejected with HR-4120 (412) → JSON-RPC -32009.
--
-- Fully additive: NOT NULL DEFAULT 0 backfills every existing row to 0, no FK,
-- no enum, no data migration. Physical table names use each model's @@map:
--   Employee        → "Employee"        (no @@map — PascalCase)
--   Position        → "Position"        (no @@map — PascalCase)
--   Goal            → "Goal"            (no @@map — PascalCase)
--   JobRequisition  → "JobRequisition"  (no @@map — PascalCase)
--   Candidate       → "Candidate"       (no @@map — PascalCase)
--   Offer           → "offers"          (@@map)
--   LeavePolicy     → "leave_policies"  (@@map)
--
-- These tables are under FORCE-RLS; this DDL runs as the schema owner, for which
-- FORCE ROW LEVEL SECURITY does not gate ALTER TABLE, so the ADD COLUMN applies
-- to all rows regardless of tenant.

ALTER TABLE "Employee"       ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Position"       ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Goal"           ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "JobRequisition" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Candidate"      ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "offers"         ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "leave_policies" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
