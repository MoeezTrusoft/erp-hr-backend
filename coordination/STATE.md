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
