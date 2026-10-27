-- Empty-install rollback only. Never discard actual operator/employee receipts.
BEGIN;
LOCK TABLE "NativeVerificationGrant", "NativeVerificationEntry" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "NativeVerificationGrant") OR EXISTS(SELECT 1 FROM "NativeVerificationEntry") THEN
  RAISE EXCEPTION 'Native verification has durable history; retain schema and disable the lane';
 END IF;
END $$;
DROP TRIGGER native_intent_immutable ON system_account_provisioning;
DROP TABLE "NativeVerificationEntry";
DROP TABLE "NativeVerificationGrant";
DROP FUNCTION hr_native_intent_immutable();
DROP FUNCTION hr_native_entry_bind();
DROP FUNCTION hr_native_entry_immutable();
DROP FUNCTION hr_native_grant_immutable();
DROP INDEX "system_account_provisioning_tenantId_id_key";
COMMIT;
