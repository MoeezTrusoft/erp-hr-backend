-- HR-ATT-POLICY-01 — half-day threshold as a share of the rostered shift.
--
-- Policy differs per tenant: Trusoft uses a fixed 30 minutes, the other four use
-- "half the shift". Half a shift is 90 minutes for EMG (15:30-18:30) and 360 for
-- Homenet (22:00-10:00), so a single integer cannot express it.
--
-- NULL keeps the existing fixed-minutes behaviour, so this is additive.
ALTER TABLE "attendance_policy_config"
    ADD COLUMN IF NOT EXISTS "halfDayAfterPercentOfShift" DOUBLE PRECISION;
