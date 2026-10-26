# Performance Appraisals — implementation and release record

27 October 2026 · Development candidate for the existing HR Module

## Release status

Deployment is authorized by the user. **The implementation is not yet qualified for a release claiming full compliance with all 69 enhancements.** No production rollout, production migration, user role assignment or employee notification has been performed. The existing HR deployment connection has been found and verified; access is not the blocker.

Changes are in five isolated `codex/performance-appraisals` worktrees. Employee Directory, Recruitment, Timesheets and Payroll are treated as existing HR components. Their worktrees and deployment state are preserved.

The user will pull the coordinated changes manually when ready. **Do not pull this candidate into the live HR installation yet.** Draft branches are for review; pulling `main` will not include these unmerged changes. No protected-branch rule has been bypassed. Contracts CI run [40380096967](https://github.com/MoeezTrusoft/erp-contracts/actions/runs/40380096967) did not start because GitHub reported failed account payments or a spending-limit restriction. Local checks are evidence, not a replacement for required protected CI and independent review.

Published dependencies: [contracts PR 19](https://github.com/MoeezTrusoft/erp-contracts/pull/19), [gateway PR 34](https://github.com/MoeezTrusoft/erp-gateway-backend/pull/34), and [RBAC PR 35](https://github.com/MoeezTrusoft/erp-rbac-backend/pull/35). The delivery folder's `RELEASE-MANIFEST.json` records the complete coordinated set, including the HR and frontend candidates after publication.

## Implemented and verified

- Twenty-six tenant-scoped domain tables and seven additive migrations with FORCE RLS, tenant composite foreign keys, immutable records and guarded transitions.
- Thirty-three strict shared REST/MCP commands and queries. Mutations use serializable transactions, expected-version checks and durable actor-scoped command receipts.
- Frozen roster and HRIS assignment snapshot; self/manager responses; exact-revision Approval Centre senior and release approval; independent calibration, release, acknowledgement, appeals and successor corrections.
- Durable launch journal, immutable batch receipts, stable BullMQ jobs, lost-job reconciliation and pause/resume/cancel-unstarted controls. A real Redis recovery test created 501 reviews exactly once across three batches after simulated post-commit failure.
- Peer nomination and independent approval, confidential responses, fixed window, immutable aggregate summary, minimum five responses, per-criterion suppression and hidden participation. Employee visibility follows release.
- Basic goals, measured key results, alignment graph checks, dual-confirmed check-ins, audience-scoped feedback, published Assessment evidence and staged decision records. Consequential execution remains SHADOW-only.
- Cycle analytics with frozen denominator, first-release timing, overdue work, appeals, correction tracking and immutable closure comparison. Released rating distributions suppress small groups. Aggregate CSV exports are scoped, audited, replayable and protected against spreadsheet formula injection.
- Shared canonical performance events, minimal outbox payloads and realtime query invalidation; capability definitions and eleven unassigned roles.
- Gateway canonicalization preserves dedicated three-part appraisal capabilities, rejects unknown appraisal tools and prevents automation from impersonating human appraisal signoffs.
- Real-transport React workspace, pagination, autosave/conflict retention, peer inbox, launch controls and analytics. Shared ERP controls/colour tokens, labelled tables and partial Urdu/RTL support.

## Existing HR integration

| Existing component | Implemented dependency | Remaining release acceptance |
|---|---|---|
| Employee Directory | Existing employee identity and current reporting line authorize access; frozen participant snapshots preserve appraisal context | Effective-dated assignment history, eligibility exceptions and lifecycle handover automation |
| Recruitment | Uses employees created through the established HR onboarding path; no duplicate candidate/employee master | Formal probation/onboarding-triggered appraisal automation |
| Timesheets | Existing module remains authoritative; manually entered external measurements are rejected | Authenticated approved-timesheet evidence adapter and reconciliation |
| Payroll | Compensation case is anchored to a released revision with independent staged actors and appeal hold | Employee-specific effective-dated receiver, real Finance budget reservation, execution/reconciliation; shared salary-component configuration must never be changed for one employee |
| Approval Centre | Existing PERFORMANCE requests bind exact appraisal stage, revision digest and expected version; direct and centre actions share transactions | Consequential decision approval stages and deployed role-matrix acceptance |

## Validation

All database scenarios use synthetic identities in an isolated loopback PostgreSQL database. Runtime role is not an owner, superuser or RLS-bypass role. The recovery test used a disposable Redis pod without a public service or persistent volume, and removed it afterwards.

| Check | Evidence | Limit |
|---|---|---|
| Existing HR Jest suites | 278 passed; 3,354 tests passed; two suites/11 tests retain their existing skips | Tests do not certify every production integration |
| Appraisal workflow and metric regressions | 41 Node test entries passed | Synthetic identities; not deployed gateway end-to-end acceptance |
| Exact SQL migration files | All seven applied unchanged to a clean pinned pre-appraisal schema; 26 FORCE-RLS tables checked | No production-volume legacy import rehearsal |
| BullMQ + real Redis | 501-review post-commit crash/retry recovery passed; temporary pod removed | No production scale, disaster-recovery or HA certification |
| Browser | Nine Playwright journeys passed, including automated WCAG checks on employee, peer and analytics views | Fixture transport; complete manual accessibility and Urdu review remain |
| Shared contracts | 32 Vitest files / 712 tests and 57 Node tests passed; ESLint passed | Protected CI could not start because of the account restriction |
| Gateway and RBAC | Nine gateway permission tests and three unassigned-role tests passed | Full service gates and real RBAC database acceptance remain |
| HR frontend regressions | 71 of 73 files / 913 tests passed in the broader run; both affected files / 12 tests passed on focused recheck | The original run had one timing failure and an existing missing Attendance approval-chain shortcut; the shortcut was restored and rechecked |
| Frontend bundle and lint | Production bundle passed; appraisal and repaired attendance files linted separately | Wider all-domain Vitest run was interrupted after failures outside the appraisal journeys; no claim of a full green frontend gate |

## Reproduction and rollout order

1. Keep `contracts` adjacent to all four consumer repositories for their tracked local dependency. Use the tracked lockfiles and Node 24. The contracts candidate is version 0.19.0 at `e2263981b04e88ac6f9fa34f51051363e85db026`; all consumer CI workflows pin that commit. The manual pull runbook and exact source manifest are in the delivery folder. A Git source revision is not a built image digest.
2. Provision a disposable PostgreSQL cluster at 127.0.0.1:55443 with administrator `appraisal_admin`. `tests/appraisals/prepare.mjs` refuses a nonempty schema and installs the pinned baseline, seven unchanged migrations and restricted runtime grants. It is not a production deployment script.
3. Run `node --test tests/appraisals/*.test.mjs`; run the real Redis test separately with `APPRAISAL_TEST_REDIS_URL=redis://127.0.0.1:56379` and `node --test tests/appraisals/worker-recovery.mjs`. Contracts use `pnpm test`; frontend uses `pnpm test:appraisals:browser` and its production build.
4. Complete the requirements below and the checked-in release-readiness record. Obtain passing protected-branch CI and the required independent review. Do not bypass branch protection or deploy an unreviewed working tree.
5. Apply the seven additive migrations through the established deployment process, after backup/restore and preflight rehearsal. Install unassigned RBAC roles through `scripts/install-appraisal-permissions.mjs`; preview is read-only and `--apply` performs installation. Assign named actors through existing HR/RBAC administration.
6. Deploy the HR service, dedicated worker, gateway and frontend from the coordinated immutable artifacts. Worker requires explicit `APPRAISAL_TENANT_IDS` and Redis; no allowlist means no scan. Legacy reminders separately require `APPRAISAL_LEGACY_TENANT_IDS`.
7. Bind the approved tenant policy/calendar/retention settings, publish a reviewed template and enable the tenant only after role-separated end-to-end acceptance. Policy test values are examples, not approved company policy.
8. Verify employee/manager/current-line access, peer privacy, stale-write rejection, Approval Centre release, correction continuity, worker retry, notification delivery and all downstream receipts before declaring full compliance.

## Material work still required

Full legacy uniqueness/soft-archive/validation and released-cycle reporting; all phase dates and eligibility/deferral/delegation; Notification Hub channel delivery and escalations; calendar/leave handover; DAM/quarantine/legal hold and PDF release packet; full evidence timeline and authenticated PM/Timesheet feeds; seven AI assistants with governance and evaluation; calibration cohort workbench and rater qualification; real budget/payroll/promotion/PIP/LMS execution; competency profiles, advanced fairness/search/trends; legacy import, load/recovery and complete bilingual/accessibility UAT remain in scope.

The register below distinguishes delivered parts from outstanding acceptance. “Partial” is not full acceptance; “Open” means the business capability is not delivered. Reserved enums, prompt IDs and decision records do not count as downstream execution.

## Requirement register

| ID | Requirement | Status | Evidence and remaining work |
|---|---|---|---|
| E-01 | Fix the confirmed defects D1 to D17 | Partial | Legacy create/launch, feedback references, goal arithmetic/atomicity, graph cycles, calibration transaction/math, reminders and report fields repaired. Complete D1–D17 route/scope acceptance remains. |
| E-02 | Freeze direct FINALIZED writes | Partial | Generic FINALIZED writes rejected; finalization requires an approved request in the database. New core senior/release approvals bind exact revision hash and version. Complete legacy approval-version binding remains. |
| E-03 | Emit the finalised event | Partial | Legacy approval adapter emits finalization event in its transaction. Hub delivery/replay acceptance and legacy approval fixture remain. |
| E-04 | Zod validators for every legacy payload | Partial | New domain has strict Zod schemas; legacy cycle/template writes allowlisted. A complete shared legacy validator pack remains. |
| E-05 | Uniqueness and soft delete | Open | Legacy duplicate cleanup, review/edge/metric unique indexes and archival replacement are not complete. |
| E-06 | Real tests | Partial | Real PostgreSQL isolation, concurrency, rollback, exact migrations, peer privacy, correction metrics, CSV export and legacy calibration regressions pass. Full legacy route/scope matrix remains. |
| E-07 | Frontend data truth | Partial | Removed five-row limit, fabricated analytics fallbacks and missing-rating default. Complete legacy chart/mapping/accessibility replacement remains. |
| E-08 | Add the performance tools to the manifest and go live | Partial | 33 shared strict commands/queries bind contracts, backend, gateway and frontend. Full legacy tool census and deployed gateway acceptance remain. |
| E-10 | Appraisal cycle and participant | Partial | UUID cycle, frozen included roster, due dates, immutable launch snapshot and denominator. All phase dates, exclusions, deferrals and eligibility rules remain. |
| E-11 | Employee assignment snapshot | Partial | Participant JSON freezes employee, manager, position, grade, unit and HRIS version. Effective-dated jurisdiction and assignment history integration remain. |
| E-12 | Immutable form template versions | Partial | Published template immutable; anchored scales and exact basis-point weights. Section hierarchy, descriptors and complete bilingual publication validation remain. |
| E-13 | Review, revision and response | Partial | Immutable submitted responses/revisions and confidential peer responses; successor corrections preserve the released packet. Full revision browsing and senior narrative response type remain. |
| E-14 | Transition service and state machine | Partial | Serializable CAS, independent signoffs and exact-revision Approval Centre senior/release binding, transactional audit/outbox, calibration and acknowledgement. Delegation and deferred routing remain. |
| E-15 | Idempotent, resumable cycle launch | Partial | Durable launch-run and immutable batch receipts, 250-row batches, stable BullMQ job IDs, reconciliation, pause/resume/cancel-unstarted controls. Redis recovery proof created 501 reviews once after post-commit failure. Partial-roster cancellation/deferral policy and production-scale rehearsal remain. |
| E-16 | Evidence items for appraisal | Partial | Verified published Assessment revision linking. DAM, quarantine, legal hold, goal evidence and full audience adapters remain. |
| E-17 | Contracts package schemas | Partial | 33 strict contracts, deterministic scoring and canonical hr.performance.* events with minimal payloads. Version 0.19.0 published on draft PR 19 at e2263981b04e88ac6f9fa34f51051363e85db026; all four consumer CI workflows pin this commit. Protected review, CI and receiver acceptance remain. |
| E-18 | Capability permissions | Partial | Dedicated capabilities and 11 unassigned role definitions. Current HRIS manager scope, exact gateway capability matching and human-only sensitive commands verified. Nine gateway and three RBAC role tests pass. Independent RBAC database acceptance and policy ratification remain. |
| E-19 | Legacy migration | Open | No legacy history import, identity/cycle map, reconciliation or migration rehearsal delivered. |
| E-20 | Deadline engine | Partial | Bounded tenant worker, due reminder intents, schedule versions and cancellation; appeal clocks use frozen working calendar. Full phase/calendar/leave/hub scheduling remains. |
| E-21 | Escalation ladder | Open | Configurable working-day escalation ladder and HR exception tasks remain. |
| E-22 | Hub templates and channels | Open | Notification hub templates, channel routing, digest policy and receipt reconciliation remain. |
| E-23 | Manager transfer handover | Partial | Former manager access revokes immediately; manual evaluator reassignment verifies current HRIS manager. Lifecycle consumer and handover notices remain. |
| E-24 | Delegation with bounds | Open | Bounded delegation model, authority checks and effective-actor attestations remain. |
| E-25 | Cycle auto progression and close checks | Partial | Explicit close readiness and immutable closing metric snapshot; acknowledgement/correction after close supported. Auto-progression, exceptions and closing report remain. |
| E-26 | Realtime invalidation | Partial | Canonical transaction outbox events and frontend appraisal/Approval Centre query invalidation rules implemented. Deployed gateway delivery/replay acceptance remains. |
| E-27 | Dedicated HR worker Deployment and CronJobs | Partial | Dedicated BullMQ worker, explicit tenant allowlist and PostgreSQL launch reconciliation. Real Redis crash/retry test passes. Platform manifest integration, autoscaling and deployment acceptance remain. |
| E-30 | Check ins | Partial | Scheduled agenda, actions and matching dual-confirmed notes. Policy cadence, typed action ownership/dates and automatic agenda preparation remain. |
| E-31 | One on ones with calendar sync | Open | External calendar sync, recovery, consented recording and ASR remain. |
| E-32 | Structured feedback | Partial | Immutable employee/manager/HR audience-scoped feedback. Structured behaviour fields, drafts, request/response and full audience policy remain. |
| E-33 | Recognition integration | Open | Recognition evidence integration remains. |
| E-34 | 360 and peer nominations | Partial | Independent peer nomination approval, current-identity invitations, immutable responses, fixed close window and frozen aggregate summary. Five-response/per-criterion suppression, hidden participation and anonymous events tested. Narrative redaction, broader policy and operational acceptance remain. |
| E-35 | Evidence timeline | Open | Unified paginated evidence timeline across all source systems remains. |
| E-40 | Goal model upgrade | Partial | Approved goals, weighted key results, increasing/decreasing/binary formulas and versioned measurements. Typed goal hierarchy, units, target amendments, freshness and richer UI remain. |
| E-41 | Alignment graph | Partial | Tenant/cycle graph lock, duplicate/cycle guards and independent reapproval. Strategic objectives, contribution weights, depth limit and scoped trace remain. |
| E-42 | Task evidence from PM | Open | PM authenticated event consumer and replay reconciliation remain; user calls cannot submit external-source measurements. |
| E-43 | Generalised KPI feed | Open | Visual Studio authenticated evidence consumer remains. |
| E-44 | Goal quality assistant | Open | AI goal-quality assistance remains; only the prompt identifier is reserved. |
| E-45 | Governance (prerequisite) | Open | AI governance, consent, authorized source selection, provenance, human review, evaluation and kill-switch acceptance remain. No AI execution is enabled. |
| E-46 | hr.performance.review.summarize.v1 | Open | Grounded review summary assistant, source citations, provenance and evaluation remain. |
| E-47 | hr.performance.feedback.themes.v1 | Open | Confidential feedback-theme assistant with authorized source selection, privacy suppression and evaluation remains. |
| E-48 | hr.performance.insight.v1 | Open | Performance insight assistant with grounded explanations, source authorization and evaluation remains. |
| E-49 | hr.performance.one_on_one.summarize.v1 | Open | Consented one-on-one summarization, recording/transcription controls and evaluation remain. |
| E-50 | hr.performance.calibration.narrative.v1 | Open | Calibration narrative assistance, human approval, provenance and evaluation remain. |
| E-51 | hr.performance.rubric.consistency.v1 | Open | Rubric consistency assistance and evaluation remain. All seven reserved prompts require AI Plane adapters and governance acceptance. |
| E-55 | Weighted composite engine | Partial | Versioned weighted-scale scoring, rational calculation, NA handling, unrounded band mapping and worked example tested. Section-level rules and broader property suite remain. |
| E-56 | Calibration workbench service | Partial | Adjustment successor, original score preserved, distinct approval and explicit no-change calibration. Cohort workbench, suppression, reasons catalogue and report reconciliation remain. |
| E-57 | Appeals case | Partial | Working-day appeal windows, independent adjudicator, transactional decision hold and successor correction tested. Assigned reviewer queue and detailed evidence/extension policy remain. |
| E-58 | Rater qualification reuse | Open | Assessment rater qualification and reference-case reuse remain. |
| E-59 | Release packet | Partial | Frozen released JSON packet and independent acknowledgement. PDF generation, DAM retention/classification and versioned delivery remain. |
| E-60 | Decision case framework | Partial | Released-revision decision cases and distinct HR/budget/execution actors. Approval Centre stages, typed downstream case models and cancellation reconciliation remain. |
| E-61 | Compensation planning and HR payroll handoff | Partial | Typed compensation instruction, separate visibility, appeal lock and SHADOW-only handoff. Salary matrix, real budget reservation, receiver execution and reconciliation remain. |
| E-62 | Promotion and succession | Open | A promotion case can be recorded; position validation, effective-dated HRIS application and succession workflows remain. |
| E-63 | Performance improvement plan | Open | A PIP decision can be recorded; observable improvement plan, support commitments, check-in cadence and outcomes remain. |
| E-64 | Development plan loop | Open | A development decision can be recorded; training referral and independently verified gap closure remain. |
| E-65 | Competency catalog and role profiles | Open | Competency catalogue, proficiency profiles, observation expiry and career workflow remain. |
| E-70 | Cycle health metrics | Partial | Metric v2 uses frozen roster, first-release/self-submission timing, overdue work, acknowledgements, open appeals and corrections. HR screen compares immutable closure figures. Remaining phase health/SLA measures remain. |
| E-71 | Real nine box and distributions | Partial | Calculated-versus-released rating bands use only latest released revisions and suppress small groups. Potential remains unavailable without independent evidence. Multi-cycle trends and approved potential/nine-box workflow remain. |
| E-72 | Exports | Partial | Scoped, audited aggregate CSV export with replay receipt, current authorization, content digest and formula neutralization. Detailed Excel/PDF and retained export jobs remain. |
| E-73 | Operational dashboards | Open | Dedicated Prometheus/Grafana metrics, alert rules and operations acceptance remain. |
| E-74 | Fairness diagnostics in a restricted area | Open | Restricted fairness diagnostics, group suppression and investigation workflows remain. |
| E-75 | Search projection | Open | Permission-aware search projection remains. |
| E-80 | Employee workspace /hr/performance/me | Partial | Unified employee workspace: self response, autosave, retained conflicts, release/acknowledgement, appeals and basic continuous records. Complete timeline/development/career journeys remain. |
| E-81 | Manager inbox /hr/performance/team | Partial | Scoped report reviews and manager form, goal approval, check-ins and decisions. Priority inbox, bulk operations and AI evidence panel remain. |
| E-82 | HR cycle console /hr/performance/cycles | Partial | Template/cycle setup, roster launch progress and pause/resume/cancel-unstarted controls, state actions and cycle analytics. Full phase/exception/deferral console remains. |
| E-83 | Calibration workbench /hr/performance/calibration | Partial | Review-level calibration propose/approve actions. Cohort workbench and minutes export remain. |
| E-84 | Template and rubric builder | Partial | Criteria/weight/anchor builder with immutable publication. Sections, complete translations, version copying and preview remain. |
| E-85 | Decision queues | Partial | Basic staged decision queue. Compensation planner, rich case forms and handoff exception UI remain. |
| E-86 | Analytics | Partial | HR cycle health, closure comparison, suppressed rating-band tables and audited aggregate CSV download. Trends, approved potential/nine-box, virtualised large tables and broader exports remain. |
| E-87 | Accessibility and conformance | Partial | Shared ERP colour tokens and controls, labelled semantic tables, responsive layout and Urdu navigation/RTL. Automated WCAG checks pass on employee, peer and analytics screens. Full Urdu content, manual screen-reader and all-role conformance UAT remain. |
