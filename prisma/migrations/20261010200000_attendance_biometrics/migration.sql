ALTER TABLE attendance_capture_devices
  ADD COLUMN "biometricPublicKey" TEXT,
  ADD COLUMN "biometricSite" TEXT,
  ADD COLUMN "fingerprintPadLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fingerprintPadValidated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance_capture_events
  ADD COLUMN "biometricApprovedBy" TEXT,
  ADD COLUMN "biometricApprovedAt" TIMESTAMP(3);
ALTER TABLE attendance_device_punches ADD COLUMN "directionVerified" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE attendance_biometric_profiles (
  id UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL REFERENCES "Employee"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  modality TEXT NOT NULL CHECK (modality IN ('FACE','FINGERPRINT')),
  slot TEXT NOT NULL,
  engine TEXT NOT NULL,
  "engineVersion" TEXT NOT NULL,
  "encryptedTemplate" TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  "enrolledBy" TEXT NOT NULL,
  "enrolledDeviceId" UUID NOT NULL REFERENCES attendance_capture_devices(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3)
);
CREATE INDEX attendance_biometric_profiles_lookup ON attendance_biometric_profiles ("tenantId", "employeeId", modality, active);
CREATE UNIQUE INDEX attendance_biometric_profiles_active_slot ON attendance_biometric_profiles ("tenantId", "employeeId", modality, slot) WHERE active;

CREATE TABLE attendance_biometric_challenges (
  id UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL REFERENCES "Employee"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "deviceId" UUID NOT NULL REFERENCES attendance_capture_devices(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "expectedProfileId" UUID,
  "deviceConfigHash" TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('FACE','FINGERPRINT')),
  purpose TEXT NOT NULL CHECK (purpose IN ('ENROL','VERIFY')),
  slot TEXT NOT NULL,
  direction INTEGER CHECK (direction IN (0, 1)),
  "actorId" TEXT,
  reason TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "payloadHash" TEXT,
  result JSONB
);
CREATE INDEX attendance_biometric_challenges_device ON attendance_biometric_challenges ("tenantId", "deviceId", "createdAt");
CREATE INDEX attendance_biometric_challenges_expiry ON attendance_biometric_challenges ("expiresAt");
DO $$ DECLARE tab TEXT; BEGIN
  FOREACH tab IN ARRAY ARRAY['attendance_biometric_profiles','attendance_biometric_challenges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')', tab);
  END LOOP;
END $$;
