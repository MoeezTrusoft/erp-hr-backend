-- Recruitment Phase 6: a kiosk crash resume is recorded as its own integrity
-- event type, KIOSK_RESUME (PROCTOR-sourced). It stays on the sitting's
-- timeline but is not one of the candidate's flags (FLAG_INTEGRITY_TYPES in
-- src/lib/test-band.util.js), so a crash cannot push a sitting into REVIEW.
ALTER TABLE "candidate_test_integrity_events" DROP CONSTRAINT "candidate_test_integrity_events_type_check";
ALTER TABLE "candidate_test_integrity_events" ADD CONSTRAINT "candidate_test_integrity_events_type_check"
    CHECK ("type" IN ('FOCUS_LOST', 'FULLSCREEN_EXIT', 'NETWORK_LOSS', 'RAPID_ANSWER', 'DEVICE_CHANGE',
                      'PROCTOR_PAUSE', 'PROCTOR_VOID', 'KIOSK_RESUME'));
