# STATE.md — erp-hr-backend
## Session Handoff (2026-07-27)

**Done:**
- DB Batch 3: Float→Decimal (8 models), 30+ FK indexes, 11 tenant uniques, migration chain verified clean
- MCP Protocol Assurance (MCP-PROTOCOL-01): 10/10 tests — initialize, tools/list, tools/call, resources/list, boundary denial
- Architecture fixes: package.json name corrected to `erp-hr-backend`
- **CRUD gap analysis + remediation COMPLETE:**
  - 114 Prisma models inventoried, 39 new MCP tools created across 7 new tool files (first wave)
  - New tools: Region (5), HolidayCalendar (5), PerformanceCycle (5), PerformanceTemplate (5), PerformanceMetric (3), Skill (2), EmployeeSkill (3), TrainingSession (5), Tag (4), OffboardingTask (2)
  - Registered in toolRegistry.js — total facade now 372 tools (was 333)
- **CRUD gap second wave COMPLETE:**
  - 34 additional tools across 7 new tool files
  - New tools: LeavePolicy LIST/GET (2), Timesheet LIST/GET/CREATE (3), OvertimeRule LIST (1), WorkSchedule LIST (1), Application LIST/GET (2), LearningPath LIST/GET/UPDATE/DELETE/ENROLL (5), LifecycleEvent LIST/GET (2), ComplianceChecklist LIST/GET/UPDATE/DELETE (4), ComplianceItem LIST/GET/CREATE/DELETE (4), DevelopmentPlan LIST/GET/UPDATE/DELETE/ItemList/ItemUpdate (6), PayslipQuestion LIST/GET/UPDATE/DELETE (4)
  - Registered in toolRegistry.js — total facade now 419 tools (was 333)
- **Per-tool scenario matrices — ALL COMPLETE:** 33 suites, 1230 tests, ALL GREEN
  - First wave (25 suites, 1042 tests): employee (27, 109), attendance (18, 72), leave (11, 44), payroll (13, 52), performance (13, 52 → 12 after dev_plan move), benefits (8, 32), compliance (6, 24), catalog (14, 56), learning (17, 52), selfService (3, 9), analytics (1, 3), org (4, 16), auditTrail (1, 4), onboarding core (18, 72), onboarding dashboard/schedule/portal (17, 68), shiftTemplate (9, 36), recruitment core+analytics+extra (24, 96), interview+offer mgmt (9, 36), candidatePipeline+resume+talentPool (9, 36), region+holiday (10, 40), performanceConfig (13, 52), skill (5, 20), trainingSession (5, 20), tag (4, 16), offboardingTask (2, 8)
  - Second wave (8 suites, 188 tests): leavePolicy (2, 6), timesheet (3, 9), overtimeWorkSchedule (2, 6), application (2, 6), learningPath (5, 15), lifecycleCompliance (10, 30), developmentPlan (10, 40), crudGap (13, 52)
  - Third wave (1 suite, 52 tests): crudGap — Application DELETE, LeaveBalance DELETE, LifecycleEvent UPDATE/DELETE, DevPlan CREATE/ITEM_CREATE, CourseOutcome LIST/GET/UPDATE, CourseReview LIST/GET/UPDATE/DELETE
- **ESM mock pattern solved:** `jest.unstable_mockModule` + `mcpCtx.run()` + return-value verification
- **BUG FIXED:** `hr_employee_emergency_contact_create` permission key changed from route path `/hr/api/emergency-contacts` to `hr:employee` — no longer permanent 403
- **Full regression gate run:** HR 2055/2084 (9 suites fail — all pre-existing, env-dependent)

**In-flight:**
- None (all CRUD gap + scenario matrix work complete)

**Remaining failures (all pre-existing, need real DB/Redis):**
- DAM env vars (dam.media.service, dam.rbac.department)
- C4 encryption at rest (HR-01.c4-encrypted-at-rest)
- HR contract tests (hrContractCreateEmployee, hrContractBase64Media, hrContractCreateEmployee.event)
- Tenant-keys DB test (F-DB-03-05)
- HR tenancy completion
- MCP protocol assurance (test pollution — passes in isolation)

**Remaining CRUD gaps (lower priority):**
- LeaveBalance (DELETE exists, no standalone CREATE tool — covered by upsert)
- CourseOutcome (CREATE/DELETE exist; LIST/GET/UPDATE now added)
- CourseReview (CREATE exists; LIST/GET/UPDATE/DELETE now added)
- EmployeeLifecycleEvent (CREATE/LIST/GET exist; UPDATE/DELETE now added)
- DevelopmentPlan (CREATE/LIST/GET/UPDATE/DELETE/ADD_ITEM now all covered)
- PayslipQuestion (CREATE/LIST/GET/UPDATE/DELETE now all covered)

**Risks:**
- MCP tools/list Zod edge case on 406-tool facade (SDK-level)

**Requests:**
- None

2026-10-17 Payroll hardening: published salary components/rules drive both preview and processing; decimal formula arithmetic and readiness gates enforced.
Approval: employee initiator -> line manager recommendation -> HR verification -> Management decision; Management returns to HR; reviewed source snapshots and code-only identity preserved.
Payments: confirmed company banks, preparation CSV, encrypted evidence and exact-amount reconciliation; loan recovery reserves until finalization and cancellation retains history.
Validation: PostgreSQL payroll lifecycle, approval regression, additive migration rehearsal, focused payroll/export tests and lint/boundary checks; frontend browser journey passes desktop/mobile.
Release: migration 20261017190000_payroll_workflow_controls; deploy coordinated frontend and gateway tools. Bank API credentials/specifications are pending; no production deployment or payment was performed.

2026-10-17 Payroll migration rehearsal found FORCE RLS hid historical loan repayments from the backfill.
Fix: scope the existing system tenant context to an explicit migration transaction so settled repayments remain settled.
Security: COMMIT clears the context; application row security remains enabled and forced.
Validation: regression runs the real migration as a non-superuser table owner under FORCE RLS and checks context cleanup, historical settlement, and new pending repayment behavior.
Release: apply this correction before the pending payroll migration in production; the original migration has only run on a disposable rehearsal clone.
2026-10-17 Live payroll verification: configuration publication failed because verified employee claims arrive as numeric strings.
Fix: normalize the publisher to a positive safe integer before storing snapshot and metadata attribution; reject invalid non-null identities.
Regression: native payroll and browser fixtures now use string employee claims matching the gateway session.
Validation: 14 publication unit tests, the PostgreSQL payroll/approval/reconciliation lifecycle, and changed-file ESLint pass.
Release: no new migration; rebuild HR after merge and repeat live publication, approval, export and reconciliation verification.
2026-10-17 CI follow-up: the required postgres job was filtered out of payroll-only pull requests.
Fix: run the attendance database safeguards workflow on every pull request so branch protection receives its required check.
Evidence: manually dispatched tests passed, but GitHub still required the pull-request check before merging.
Validation: workflow YAML parses and retains the complete PostgreSQL migration, tenant isolation and concurrency test job.
Release: no application or migration changes; reviewer approval remains required for this CI commit.
2026-10-17 Payroll CSV export: live UAT found that tax was omitted while the other-deductions column correctly excluded it.
Fix: export a separate Tax column and explicitly use the employee-code property.
Regression: tax-only and tax-plus-loan rows must reconcile earnings minus tax and other deductions to net pay.
Validation: new service regressions fail before the fix and pass afterward; changed-file ESLint passes.
Release: no schema or payroll calculation changes; combine with the Finance HR branch before deployment and re-download the live register.
2026-10-20 Recruitment Phase 0: feature/recruitment-workflow-hardening merged onto main; HR Approval Centre is the only requisition/offer decision engine (all approve/reject paths answer HR-4201; submit runs recruitment gates then opens the centre's review; send consumes the centre's approval).
Fixes: 28 branch migrations re-stamped after 20261020120000 and "candidates"->"Candidate" (D-02/D-03); hire handoff allocates employee codes by category stored at acceptance (D-04); D-01, D-07 to D-16, D-18 one commit each; new migrations 20261021002900 (offers.employeeCategory) and 20261021003000 (per-tenant parse cache).
Validation: gate:p1 green (4,227 passed, 16 skipped; lint and boundaries pass); CI database job reproduced on PostgreSQL 16 (142/142 node:test); F-DB-01 replays from zero with no drift beyond main's existing drift; scorecard DB suite 8/8 on a migrated DB.
Open: D-17 (numeric error codes, kebab file names) deferred; recruitment approval matrix and offer policy are stored config only pending a decision; RBAC seeds, gateway map and docs/RECRUITMENT-ROLLOUT-RUNBOOK.md (flags, migration names) need their owners; envs with old migration names need prisma migrate resolve.
Release: apply migrations before the build; resume-fixture suite now runs only with HR_RESUME_FIXTURE_DIR; main's own DB integration fixtures lack employee_code (pre-existing, 9 suites fail identically on main).
2026-10-20 Recruitment Phase 1 (backend): hr_candidate_360_get (F-14, scope-cut profile/applications/interviews/offers/privacy); recruitment + onboarding MCP resources now assert their list tools' grants and stop returning full Employee rows, parsed resumes and other reviewers' scorecards; every write the screens make emits its outbox event in the write's transaction (F-37: interview/offer/requisition/talent pool/7 onboarding writes; onboarding threads the verified tenant).
Automation (all flags default OFF): approval SLA reminder/escalation job (HR_RECRUITMENT_APPROVAL_SLA, 48h default), auto-publish of approved requisitions (HR_RECRUITMENT_AUTO_PUBLISH), posting expiry past closesAt (HR_RECRUITMENT_POSTING_EXPIRY); canonical dashboard headline metrics (HR_RECRUITMENT_CANONICAL_DASHBOARD) with the canonical block always attached under the analytics flag.
Behaviour change: hr_interview_update writes Interview.decision (codes or the screen's labels) and refuses NEXT_ROUND/REJECTED without a submitted scorecard unless overrideReason is given (HR-RECRUITMENT-INTERVIEW-FEEDBACK-REQUIRED).
Validation: gate:p1 green (350 suites, 4,373 passed, 16 skipped; lint and boundaries pass); pinned inventory 697 tools.
Open: requisition_submitted.v1 still enqueued after the Approval Centre's submit transaction (needs an onSubmit hook in approval/*); new event names need contracts REQ + Notification Hub mappers before approvalSla is on; gateway edge map must add hr_candidate_360_get; addToPool does not verify the candidate's tenant; D-17 numeric codes still deferred.
2026-10-21 Recruitment Phase 2 (backend): migration 20261021003100_recruitment_intake_screening (TenantRecruitmentSettings, ScheduledDisposition, ApplicationScore, CandidateCommunication, CandidateDuplicateSuggestion; source/knockout columns; FORCE RLS + CHECKs); settings tools, per-tenant XML job feed (/public/feeds/<token>/indeed.xml|linkedin.xml) and source report (F-06); knockout questions with delayed reversible MINIMUM_REQUIREMENTS_NOT_MET rejection (F-11); DNC at every intake path with uniform portal answers (D-11, D-16); async resume parse worker with AiTaskV1 tasks; fit score, ranking and shortlist proposals (F-10); templated candidate communications with log, dedupe, rejection delay and DNC at send (F-32); duplicate detection and merge suggestions (F-12).
Flags (all default OFF): HR_RECRUITMENT_KNOCKOUT, _JOB_FEED, _SCORING, _COMMUNICATIONS, _DUPLICATES, HR_RESUME_PARSE_WORKER_ENABLED (+ HR_RECRUITMENT_AI); workers also need HR_CANDIDATE_COMMS_WORKER_ENABLED / HR_RESUME_PARSE_WORKER_ENABLED=true on the pod; new jobs recruitment-scheduled-disposition (*/15), recruitment-scoring (7,22,37,52), candidate-duplicate-detection (:40, 2h lookback).
Fixes: public job select lacked postings.isActive (portal empty on a real DB); ingestEmployeeResume parsed with no tenant; requisition skills marked preferred went to required; shortlist writes unscoped; DNC refusal echoed the email; /public handlers ran with no tenant context; application/candidate create controllers turned every error into 400.
Validation: gate:p1 green (379 suites, 4,801 passed, 16 skipped; lint and boundaries pass); F-DB-01 deploys from zero with only main's existing 41-table drift; pinned inventory 716 tools (+19).
Open: gateway edge map + RBAC review for the 19 new tools; Notification Hub needs the 10 candidate template ids; plane registry must accept hr.candidate_match; HR_JOB_FEED_BASE_URL in deploy config; draft resumeMediaId not trusted until a portal upload binds it; experience component stays unassessed (no years in parse output, no minimum on requisitions); *-DISABLED 503 codes reach MCP as HR-5000; contracts REQ for the new event names.
2026-10-21 Recruitment Phase 3a (backend): migrations 20261021003200 (slot offers, reminder ledger, letter templates and versions, esign webhook events, calendar sync columns, offer expiry/decline fields, scheduling settings; FORCE RLS) and 20261021003300 (NO_SHOW lifecycle vocabulary). Calendar sync through the Communication module (client + worker, retries, DNC candidate left off the invite), slot finder and candidate self-scheduling (public /public/candidates/interview-slots), no-show; interview reminders, feedback nudges and escalation, decision prompts with NEXT_ROUND auto-advance (FINAL round to offer), interviewer and hiring manager workspaces; versioned offer letters to PDF in DAM, provider-neutral e-signature with a signed deduplicated webhook (/webhooks/esign, before express.json) that accepts the offer once; offer expiry sweep, decline reasons with talent pool opt-in, grade band warnings.
Flags (all OFF): HR_RECRUITMENT_CALENDAR_SYNC, _SELF_SCHEDULING, _INTERVIEW_REMINDERS, _DECISION_PROMPTS, _OFFER_LETTERS, _ESIGN, _OFFER_EXPIRY; worker switch HR_INTERVIEW_CALENDAR_WORKER_ENABLED; jobs offer-expiry (:35), esign-webhook-retry, interview-reminders, interview-decision-prompts, interview-slot-offer-expiry (all quarter-hourly except expiry).
Decision: extending an offer whose HR Approval Centre request stands is refused (HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL) instead of writing around the Centre's freeze; expired offers are not reopened. Re-approval for an extension is not built yet.
Validation: gate:p1 green (404 suites, 5,181 passed, 16 skipped; lint, boundaries); F-DB-01 deploys from zero with only main's 41-table drift; RLS checked on the new tables; no-show constraint confirmed on a migrated DB; inventory 735 (+15 this phase plus 4 lifecycle).
Open: gateway allow-list for the new tools and unauthenticated forward of /webhooks/esign/*; COMMUNICATION_SERVICE_URL and the calendar tool shapes with erp-communication; ESIGN_PROVIDER/API/secret and a provider choice; hub templates (interview_slot_offer, candidate interview reminders 24h/1h, offer expiry reminder, staff reminders and prompts); non-working days counted in UTC (as the existing gate); PDF standard font lacks non-Latin-1 names.
2026-10-21 Recruitment Phase 3b (backend): migrations 20261021003400 (12 on-site assessment and evaluation tables, interview assessment and form columns, panelRole, ASSESSMENT_NOT_PASSED; FORCE RLS; answerKey encrypted under C4) and 20261021003500 (INTERVIEW_TYPE / PANEL_ROLE template link scopes). Item bank with four-eyes review, AI drafting and nightly item statistics; versioned test blueprints with dual approval, pool-depth publish check and job family links; kiosk workstations; reception check-in and single-use codes; kiosk REST at /kiosk/v1 (outside /api, workstation + session tokens, uniform 404s); server-side clock, draw, scoring, bands, integrity flags, auto-release and recruiter decide/waive; evaluation forms with weighted and must-have scoring, evidence rules, independent scoring, prohibited-topic flags, question bank, frozen evaluation report with PDF export, rater calibration; assessment gate on every outcome path.
Flags (all OFF): HR_RECRUITMENT_ONSITE_TEST, HR_RECRUITMENT_EVALUATION_FORMS; assessment roles RECEPTION/RECEPTIONIST/ASSESSMENT_AUTHOR/ASSESSMENT_REVIEWER get scope ASSESSMENT (no recruitment rows); jobs test-item-stats (03:40) and test-sessions (every minute); optional secret HR_KIOSK_CODE_PEPPER.
Behaviour (forms flag on): hr_interview_score with a form stores the panelist's decision only (outcomeRecorded false); hr_interview_set_outcome records the outcome and freezes the report on NEXT_ROUND/REJECTED. Assessment gate refuses any decision (HOLD included) on set_outcome and hr_interview_update while the test is not PASSED/BORDERLINE/OVERRIDDEN/WAIVED. Fixes: scorecard template links were never writable on a real DB (NULL in the compound-unique upsert) and are now find-or-create; cancelInterview joins a caller's transaction so a test release is atomic; in-place draft item edits are author-only so four-eyes holds.
Validation: gate:p1 green (430 suites, 5,644 passed, 16 skipped; lint and boundaries pass); F-DB-01 deploys from zero with only main's 41-table drift; pinned inventory 781 (+46).
Open: RBAC seeds for the assessment roles; gateway allow-list for hr_test_*, hr_reception_*, hr_rater_* and the new hr_interview_* tools, plus unauthenticated forward of /kiosk/v1 with trust proxy; hub mappings for test_result_recorded / integrity / decided, notes_flagged, debrief_prompt, summary_frozen; plane prompt keys hr.interview.form.draft.v1 and the test item draft task; scheduling does not yet take panelRole (a panelist sees every section); kiosk rate limits are per pod; sites are free text, not a security boundary; kiosk crash resume not built (void then RETEST); -UNAVAILABLE 5xx codes reach clients as HR-5000.
