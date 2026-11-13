-- Consolidated employee profile — additive nullable columns.
-- All columns are NULLABLE so this is a safe, non-breaking change on the prod
-- erp-hr DB (prod migrations are gated / applied manually).
--
-- Employee.ntn and BankDetail.iban are C4-encrypted at rest by the prisma C4
-- extension (see src/lib/c4Encryption.js C4_FIELDS). The column type stays TEXT;
-- the app stores/reads the AES-256-GCM envelope transparently. Any values must
-- be written THROUGH the app (never a raw SQL INSERT of plaintext) so they are
-- encrypted; existing rows stay NULL until re-saved.

-- Pakistan National Tax Number (C4-encrypted at rest).
ALTER TABLE "Employee" ADD COLUMN "ntn" TEXT;

-- Bank block for the profile: A/C Title, IBAN (C4-encrypted), branch, disbursement method.
ALTER TABLE "bank_details" ADD COLUMN "accountTitle" TEXT;
ALTER TABLE "bank_details" ADD COLUMN "iban" TEXT;
ALTER TABLE "bank_details" ADD COLUMN "branch" TEXT;
ALTER TABLE "bank_details" ADD COLUMN "disbursementMethod" TEXT;
