-- HR-IMPORT-01 — the label HR's workbook uses for a person.
--
-- Reconciling against the workbook matched employees by fuzzy token overlap.
-- "G Rasool" also matched Abdul Rasool Junejo; "M. Yaseen" is two different
-- people in two tenants; "Hasaam", "Shokat", "Jafri" and "Jamshed" matched
-- nobody at all. Every one of those was settled by a human reading tenants and
-- shift times, and the failure mode is silent: a wrong match moves one person's
-- attendance onto another person's payslip.
--
-- Recording the alias makes the match a lookup instead of a guess. Nullable,
-- because most people's sheet label already equals their name and only the
-- awkward ones need mapping.
--
-- Additive and reversible: no existing row changes meaning, and dropping the
-- column restores the previous behaviour exactly.

ALTER TABLE "Employee"
    ADD COLUMN IF NOT EXISTS "sheet_alias" VARCHAR(120);
