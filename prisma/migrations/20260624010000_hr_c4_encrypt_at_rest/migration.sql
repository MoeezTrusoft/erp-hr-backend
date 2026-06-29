-- HR-01 / HR-10 (Roadmap T-P4.2) — encrypt C4 columns at rest.
--
-- The C4 (most-sensitive) salary/bank columns change from Float (double
-- precision) to text so they can hold the AES-256-GCM envelope string the
-- app-layer C4 extension produces. Existing numeric values are cast to their
-- string form (USING "col"::text) so no data is lost; the idempotent
-- backfill (scripts/backfill-c4-encryption.js) then replaces each plaintext
-- string with its ciphertext envelope. routingNumber / nationality_id_no are
-- already text and only need the backfill, not a type change.
--
-- BankDetail uniqueness moves off the (now-encrypted, random-IV) accountNumber
-- to a deterministic blind-index column (accountNumberBidx, HMAC of the
-- plaintext). The old unique index is dropped and the new one added.

-- ---- EmploymentTerms: salary/comp Float -> text ----
ALTER TABLE "employment_terms"
  ALTER COLUMN "baseSalary" TYPE TEXT USING "baseSalary"::text,
  ALTER COLUMN "bonusTarget" TYPE TEXT USING "bonusTarget"::text;

-- ---- Offer: offered salary Float -> text ----
ALTER TABLE "offers"
  ALTER COLUMN "salary" TYPE TEXT USING "salary"::text;

-- ---- BankDetail: blind index + drop old unique on plaintext account ----
ALTER TABLE "bank_details" ADD COLUMN "accountNumberBidx" TEXT;

-- Drop the old unique constraint on the (now-encrypted) plaintext account.
DROP INDEX IF EXISTS "bank_details_employeeId_accountNumber_key";

-- New uniqueness on the deterministic blind index. (DB is provisioned empty in
-- dev/test; in an environment with existing rows the backfill computes the
-- blind index before this migration's CREATE UNIQUE would be reachable — see
-- the rollout note in scripts/backfill-c4-encryption.js.)
CREATE UNIQUE INDEX "bank_details_employeeId_accountNumberBidx_key"
  ON "bank_details"("employeeId", "accountNumberBidx");
