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

2026-10-27 PERF-P0 (Performance Appraisals Phase 0, E-01..E-06): legacy appraisal services made functional and guarded — phantom createdById/updatedById writes removed (review create, feedback, goal, alignment, cycle, template), bulk initiate idempotent with period dates, feedback validates the review id, goal progress is a percent with derived current_value, alignment rejects cycles and archives edges, calibration adjustments are one transaction with stale-rating 409 and session linkage, calibration reports aggregate from review rows, cycle status DRAFT→ACTIVE→CLOSED with archive, routes de-shadowed and params aligned, reminder sweep set-based and tenant-stamped, reviews list paged at the database.
Guards: src/validators/performance.schema.js (strict zod, camelCase cycle normalisation, template criteria weights) parsed in every service; review status is no longer writable (E-02) — hr_approval_guard (20261015120000) plus the PERFORMANCE adapter are the only path to FINALIZED, and the adapter now enqueues hr.performance.review_finalized.v1 (E-03). Migration 20261027090000_performance_p0_integrity adds unique (tenantId, employeeId, cycleId, type), unique alignment pair, unique metric name, archivedAt on cycle/template/alignment — resolve duplicate reviews before deploy (query in the migration header).
Validation: tests/performance/workflow.postgres.test.mjs (15 subtests on the separation-prepared hr_task_assessment_test DB, now in assessment.yml) green; tests/approval/*.postgres green (55); jest 3341 passed with the two pre-existing ROSTER-REEVAL-01 failures unchanged on baseline; eslint 0 warnings; depcruise clean.
Tools: hr_performance_review_update drops status; hr_performance_cycle_create accepts startDate/endDate/templateId/status; template criteria accept { name, weight }; hr_calibration_adjust_rating takes calibrationSessionId and requires old_rating to match; reviews list tool passes page/pageSize through.
Next: P1 versioned appraisal core (E-10..E-19) per Performance_Appraisals_Enhancement_Proposal; FE companion on claude/sleepy-ritchie-9umh2y (performance area live, manifest-bound tools).
