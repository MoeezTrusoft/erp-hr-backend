2026-10-28 Performance Appraisals: strict legacy cycle/template/metric validation and atomic review-item replacement added to the existing draft lifecycle.
Validation: 45 native appraisal/database checks pass, including malformed REST payload preservation, concurrent whole-list replacement and injected-write rollback; full HR regression gate is rerun for this follow-up.
Dependencies: contracts 0.19.0 remains pinned to e2263981b04e88ac6f9fa34f51051363e85db026; coordinated draft gateway #34, RBAC #35 and frontend #115 remain required.
Release: prior HR head passed remote CI; this follow-up requires its own checks. Other repository workflows previously could not start. No production migration, deployment or role assignment performed.
Handover: user will pull manually when qualified; notification/DAM, downstream execution, AI governance, remaining legacy validation and operational acceptance remain open. This is not the completed 69-enhancement release.
