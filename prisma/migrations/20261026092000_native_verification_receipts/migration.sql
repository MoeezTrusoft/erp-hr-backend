CREATE UNIQUE INDEX "system_account_provisioning_tenantId_id_key" ON system_account_provisioning("tenantId",id);
CREATE TABLE "NativeVerificationGrant" (
 id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "runId" TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), plan JSONB NOT NULL,
 "bootstrapUserId" INTEGER NOT NULL CHECK("bootstrapUserId">0 AND "bootstrapUserId"<>8),
 "operatorReceiptId" TEXT NOT NULL CHECK(length("operatorReceiptId")>0),
 "operatorReceiptFingerprint" TEXT NOT NULL CHECK("operatorReceiptFingerprint" ~ '^[a-f0-9]{64}$'),
 "issuedAt" TIMESTAMPTZ(3) NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "cancelledAt" TIMESTAMPTZ(3), "cancellationRef" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT native_grant_tenant CHECK("tenantId"='066dd015-2820-47b5-b2fc-1e9704f0f420'::uuid),
 CONSTRAINT native_grant_lifetime CHECK("expiresAt">"issuedAt" AND "expiresAt"-"issuedAt"<=interval '1 hour'),
 CONSTRAINT native_grant_cancel CHECK(("cancelledAt" IS NULL AND "cancellationRef" IS NULL) OR ("cancelledAt" IS NOT NULL AND length("cancellationRef") BETWEEN 16 AND 200))
);
CREATE UNIQUE INDEX "NativeVerificationGrant_tenantId_id_key" ON "NativeVerificationGrant"("tenantId",id);
CREATE UNIQUE INDEX "NativeVerificationGrant_tenantId_runId_key" ON "NativeVerificationGrant"("tenantId","runId");
CREATE TABLE "NativeVerificationEntry" (
 "entryId" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "grantId" UUID NOT NULL,
 "employeeId" INTEGER NOT NULL, "provisioningId" UUID NOT NULL, "idempotencyKey" UUID NOT NULL,
 "payloadFingerprint" TEXT NOT NULL CHECK("payloadFingerprint" ~ '^[a-f0-9]{64}$'),
 "requestFingerprint" TEXT NOT NULL CHECK("requestFingerprint" ~ '^[a-f0-9]{64}$'),
 "actorUserId" INTEGER NOT NULL CHECK("actorUserId">0 AND "actorUserId"<>8),
 "deactivatedAt" TIMESTAMPTZ(3), "deactivationReceiptId" UUID,
 CONSTRAINT native_deactivation_complete CHECK(("deactivatedAt" IS NULL)=("deactivationReceiptId" IS NULL)),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "NativeVerificationEntry_tenantId_grantId_fkey" FOREIGN KEY("tenantId","grantId") REFERENCES "NativeVerificationGrant"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "NativeVerificationEntry_tenantId_employeeId_fkey" FOREIGN KEY("tenantId","employeeId") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "NativeVerificationEntry_tenantId_provisioningId_fkey" FOREIGN KEY("tenantId","provisioningId") REFERENCES system_account_provisioning("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "NativeVerificationEntry_deactivationReceiptId_key" ON "NativeVerificationEntry"("deactivationReceiptId");
CREATE UNIQUE INDEX "NativeVerificationEntry_provisioningId_key" ON "NativeVerificationEntry"("provisioningId");
CREATE UNIQUE INDEX "NativeVerificationEntry_tenantId_grantId_entryId_key" ON "NativeVerificationEntry"("tenantId","grantId","entryId");
CREATE UNIQUE INDEX "NativeVerificationEntry_tenantId_employeeId_key" ON "NativeVerificationEntry"("tenantId","employeeId");
CREATE UNIQUE INDEX "NativeVerificationEntry_tenantId_provisioningId_key" ON "NativeVerificationEntry"("tenantId","provisioningId");
CREATE UNIQUE INDEX "NativeVerificationEntry_tenantId_idempotencyKey_key" ON "NativeVerificationEntry"("tenantId","idempotencyKey");
ALTER TABLE "NativeVerificationGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeVerificationGrant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "NativeVerificationEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeVerificationEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY native_grant_company ON "NativeVerificationGrant" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
CREATE POLICY native_entry_company ON "NativeVerificationEntry" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
CREATE FUNCTION hr_native_grant_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HR-0310: native grant audit must be retained'; END IF;
 IF (to_jsonb(NEW)-'cancelledAt'-'cancellationRef') IS DISTINCT FROM (to_jsonb(OLD)-'cancelledAt'-'cancellationRef') OR
  (OLD."cancelledAt" IS NOT NULL AND ROW(NEW."cancelledAt",NEW."cancellationRef") IS DISTINCT FROM ROW(OLD."cancelledAt",OLD."cancellationRef")) THEN
  RAISE EXCEPTION 'HR-0310: native grant is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_grant_immutable BEFORE UPDATE OR DELETE ON "NativeVerificationGrant" FOR EACH ROW EXECUTE FUNCTION hr_native_grant_immutable();
CREATE FUNCTION hr_native_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'deactivatedAt'-'deactivationReceiptId') IS DISTINCT FROM (to_jsonb(OLD)-'deactivatedAt'-'deactivationReceiptId') OR
  (OLD."deactivatedAt" IS NOT NULL AND ROW(NEW."deactivatedAt",NEW."deactivationReceiptId") IS DISTINCT FROM ROW(OLD."deactivatedAt",OLD."deactivationReceiptId")) THEN
  RAISE EXCEPTION 'HR-0310: native ownership receipt is immutable';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM "NativeVerificationGrant" WHERE id=NEW."grantId" AND "tenantId"=NEW."tenantId" AND "cancelledAt" IS NOT NULL) OR
  NOT EXISTS(SELECT 1 FROM "Employee" WHERE id=NEW."employeeId" AND tenant_id=NEW."tenantId" AND status='Inactive' AND employement_status='Inactive') THEN
  RAISE EXCEPTION 'HR-0310: native deactivation is not committed';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_entry_immutable BEFORE UPDATE OR DELETE ON "NativeVerificationEntry" FOR EACH ROW EXECUTE FUNCTION hr_native_entry_immutable();
CREATE FUNCTION hr_native_entry_bind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row "NativeVerificationGrant"; intent_row system_account_provisioning;
BEGIN
 SELECT * INTO grant_row FROM "NativeVerificationGrant" WHERE id=NEW."grantId" AND "tenantId"=NEW."tenantId" FOR UPDATE;
 IF grant_row.id IS NULL OR grant_row."cancelledAt" IS NOT NULL OR grant_row."expiresAt"<=clock_timestamp() OR
  grant_row."bootstrapUserId"<>NEW."actorUserId" OR NEW."deactivatedAt" IS NOT NULL OR NEW."deactivationReceiptId" IS NOT NULL OR
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(grant_row.plan->'accounts') a WHERE a->>'entryId'=NEW."entryId"::text) THEN
  RAISE EXCEPTION 'HR-0310: native grant cannot bind this entry';
 END IF;
 SELECT * INTO intent_row FROM system_account_provisioning WHERE id=NEW."provisioningId" AND "tenantId"=NEW."tenantId" FOR UPDATE;
 IF intent_row.id IS NULL OR intent_row."employeeId"<>NEW."employeeId" OR intent_row."idempotencyKey"<>NEW."idempotencyKey" OR
  intent_row."payloadFingerprint"<>NEW."payloadFingerprint" OR intent_row.actor->>'userId' IS DISTINCT FROM NEW."actorUserId"::text THEN
  RAISE EXCEPTION 'HR-0310: native intent ownership mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_entry_bind BEFORE INSERT ON "NativeVerificationEntry" FOR EACH ROW EXECUTE FUNCTION hr_native_entry_bind();
CREATE FUNCTION hr_native_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "NativeVerificationEntry" WHERE "tenantId"=OLD."tenantId" AND "provisioningId"=OLD.id) AND
  ROW(NEW.id,NEW."tenantId",NEW."employeeId",NEW."idempotencyKey",NEW."payloadFingerprint",NEW.payload,NEW.actor) IS DISTINCT FROM
  ROW(OLD.id,OLD."tenantId",OLD."employeeId",OLD."idempotencyKey",OLD."payloadFingerprint",OLD.payload,OLD.actor) THEN
  RAISE EXCEPTION 'HR-0310: native intent is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_intent_immutable BEFORE UPDATE ON system_account_provisioning FOR EACH ROW EXECUTE FUNCTION hr_native_intent_immutable();
