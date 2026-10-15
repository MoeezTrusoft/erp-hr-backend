# HR Task Assessment v2.1 — implementation and release record

Source: `HR_Task_Assessment_Implementation_Guide_v2_1.docx`, supplied by the owner on 15 October 2026. SHA-256: `2ac26589cdae800b8109d5003970c853881bd3e7b3672252b3585f39cafa14ed`.

This is a coordinated change across HR, frontend, shared contracts, PM, RBAC and Gateway, on `codex/hr-task-assessment-v21`. The implementation has **not been deployed**. Local automated checks do not constitute business UAT, production source acceptance or permission to enable autonomous commitments.

## Implemented flow

1. Verify company-scoped employee codes, categories and department ownership. Import a source catalogue as drafts, review task applicability, scope, evidence policy, guide and benchmarks, then publish through separate SME and HR decisions. Approve the employee's effective-dated position profile.
2. Prepare and independently approve calibration reference cases. Raters complete a separate exercise without seeing reference scores. Agreement is calculated per dimension; scope, expiry and a passed exercise govern qualification. Reference authors/reviewers cannot calibrate on their own reference.
3. Assign a qualified, independent rater and reviewer. Configured triggers use hold windows, workload limits, calendar capacity, leave checks and owned exceptions. Initial assessment is due within the initial/probation window. Campaigns and accepted opportunities use the same assignment service.
4. The rater confirms context, opens the versioned guide separately, verifies practical evidence and deliberately records task-level K/S. V is calculated from confirmed attributable timing and an approved comparable benchmark, then explicitly confirmed. All numeric values start blank. Independent N/A and pending states retain null scores.
5. Submission freezes a revision. Full-review rules override sampling. Routine packets can be explicitly selected for batch approval; any packet can be opened and pulled into full review. An employee acknowledges receipt or disputes. HR publication is a distinct permission and transaction.
6. Publication creates current capability, immutable appraisal inputs and development proposals, and emits a transactional outbox event. Existing appraisal finalization remains authoritative. Development closes only against a later approved observation; course completion triggers reassessment without changing ratings. JD changes remain proposals until owner and HR approval.
7. PM obtains a fresh HR snapshot before proposing or committing work. It checks K/S, current profile/version or explicit equivalence, restrictions, credentials, site, tools, dependencies, calendars, existing work and supervisor capacity. Estimates use comparable observed **minutes**, or a reviewed fallback; V is never an hours multiplier. Atomic allocation guards prevent concurrent overbooking.
8. Withdrawals, disputes, restrictions, expiry, code corrections and employment/profile changes preserve signed history and invalidate affected future planning. Work already committed is flagged for planner review rather than silently reassigned. Offboarding and position changes fail closed before the hourly registry refresh.

## Source and module boundaries

- `src/services/assessment/` contains catalogue, calibration, evidence, workflow, HR output, planning, governance and automation services. `src/mcp/tools/assessmentTools.js` is the authenticated application boundary.
- The frontend has an HR workbench, section/task stepper, approval queues and administration forms, plus the PM Resource Assignment Studio panel. The versioned rater guide has its own searchable route, a complete HTML download and a print view. Employee profile navigation uses employee code.
- Appraisal inputs retain separate requirements, observed gaps, pending evidence, restrictions, evidence age and scope-compatible trends. Publishing or replaying an input does not change a finalized appraisal or its overall rating. Development actions use separate stable keys for evidence gaps and capability gaps.
- Workforce forecasts count employees per task scope and site for current, 90-day and 180-day windows, retaining missing profiles, uncertain calendars, expiry and scheduled renewals. A scheduled renewal never becomes assumed capability. Calendar availability is reported separately from PM's final capacity checks.
- Calibration monitoring reports per-family score distributions, level-4 share, N/A reasons, active form duration, unchanged drafted-note share, shared-case agreement and reviewed-reference agreement. Thresholds require a minimum sample and produce review flags and owner notifications. They never modify scores or create rater targets.
- Three HR migrations add the data model, FORCE RLS, tenant-safe references, immutable signatures/audit, frozen submitted content, approved code correction and evidence-based development closure. Two PM migrations add code-based planning, reservation/allocation ledgers, RLS and database capacity guards.
- Shared contracts define the 0–4 rubric, strict inputs, evidence/timing calculations, eligibility, events and exact permissions. Unsupported employeeId/userId business identifiers are rejected by the new contracts. Internal legacy row IDs are used only inside verified HR adapters.
- RBAC creates dedicated roles and exact capability resources. Installation does not assign users to rater/reviewer roles, qualify raters or approve calibration. Gateway preserves the distinction between read, approve and release.
- The included libraries contain 106 network engineering, 93 network operations and 216 software tasks: **415 draft criteria** with source provenance. The attachment says 49 families but enumerates **41**; the implementation uses the enumerated list and company coverage gates instead of inventing eight families.
- PM accepted actuals and upcoming supervised work have private-stream adapters. Registered systems can also use authenticated scheduled HTTPS extracts, with typed field-selection mappings for native evidence records, bounded pages, transactional cursor checkpoints, replay-safe event IDs, leases, backoff and owned exceptions. Company/employee attribution is never inferred from names. Live endpoints, credentials and mappings require source-owner configuration and acceptance. A factual, score-free note assistant is included; no external AI provider is enabled.
- Development matching searches upcoming scoped work, proposes qualified assessors/supervisors using current K/S, restrictions, credentials and shared calendar minutes, and revalidates a manager's selection. It retains an explicit controlled-case alternative when evidence or opportunity is missing. A practice proposal does not reserve capacity; PM's normal proposal and commitment service rechecks all allocations, dependencies and tools.

## Configuration and activation order

1. Release the shared contracts change first, or set the CI repository variable `ASSESSMENT_CONTRACTS_REF` to the reviewed contracts branch/commit. HR/PM CI requires the existing read-only `CONTRACTS_DEPLOY_KEY`. Confirm the file-dependency checkout locations (`../contracts`) before installation. Do not deploy a backend against the old contracts package.
2. Back up HR and PM databases and rehearse migration/restore in staging. Apply migrations with the deployment role; run the application with a non-superuser, non-BYPASSRLS role. Generate Prisma clients after the coordinated schema change.
3. Deploy Gateway/RBAC permission support. The RBAC installer `scripts/install-assessment-permissions.mjs` defaults to dry run and requires the existing module identifier. Review its result, then use `--apply` in the authorized environment. Assign roles separately; do not assign service ingestion/synchronization permissions to ordinary users.
4. Deploy HR and PM with workers disabled. `HR_ASSESSMENT_WORKER_ENABLED=true` enables the 15-second HR worker and PM evidence bridge; `PM_ASSESSMENT_WORKER_ENABLED=true` enables PM consumption and outbox delivery. Private event bridges require the configured Redis service. Scheduled extracts and development matching use separate bounded worker loops so source latency does not block critical workflow processing. Keep these flags off until company mappings and source ownership are verified.
5. Register the company, employee codes, position/category/profile bindings, data owners, source principals, source read permissions, work-type mappings, evidence classifications and retention. Import catalogues as drafts and replace scope placeholders. Publish approved profiles and separate guides. Configure optional `en`/`ur` guide translations and interface labels without changing rubric values.
6. Prepare reviewed calibration cases and qualify raters only from passed exercises. Configure evidence minimums, benchmarks, SLA/hold windows, capacity shares, consistency tolerances and escalation ownership. No source acceptance or UAT reference should be invented merely to advance a stage.
7. Establish the PM company UUID mapping with `scripts/bootstrap-assessment.mjs`. It defaults to read-only verification using a short-lived scoped token and `HR_SERVICE_URL`; `--apply` creates a verified mapping in RECOMMEND mode only. Never infer a UUID from an integer company ID or matching employee codes.
8. Advance each company through FOUNDATION → EVIDENCE_SHADOW → PILOT → HR_INTEGRATION → PM_SHADOW → CONTROLLED → AUTOMATIC only after its recorded gate evidence has been accepted. Start all PM classes at recommend. Reservation and automatic commitment require the configured acceptance history, owner approval, health stability and undo window.

`ASSESSMENT_SCAN_PRINCIPAL` must identify the trusted scanning service. An uploaded evidence reference remains quarantined until that service confirms the exact content hash, allowed MIME type and size. The assessment service does not accept a rater's claim that a file is clean.

## Operations and recovery

- Use the workbench's evidence event, exception, notification, audit, benchmark, calibration and opportunity views. Source integrity spikes and identity quality failures create owned circuit-breaker exceptions. Unavailable sources create pending work, never employee failures.
- `scripts/assessment-backfill.mjs` validates NDJSON against the same evidence contract, limits the backfill period and defaults to dry run. Live ingestion requires a registered authenticated producer. Reuse event IDs on retries; do not create a new event ID for the same source version.
- Failed inbox records are retried with backoff and then dead-lettered. Resolve the underlying source/mapping issue before `REPLAY_EVENT`. Record recovery evidence and allow the configured healthy period before resuming automation. The worker's append-only AutomationRun and notification keys provide reconciliation evidence.
- Private Redis bridge dead letters and outbox delivery failures require operator investigation; do not delete stream history to force a retry. A separate production replay/restore drill is required before launch.
- Pause the relevant worker and autonomy class before rollback. Preserve signed revisions, audit, outbox and allocation history. Restore the rehearsed database backup only through the approved recovery procedure; do not drop assessment tables or rewrite old scores to make an older application start. Roll forward when signed records have already been produced.

## Validation and release gates

Automated fixtures use fictional company UUIDs and employee codes on local PostgreSQL 17. The test bootstrap refuses non-local or differently named databases and requires an explicit `--reset`. Application tests run through a separate non-owner role to exercise FORCE RLS.

Commands:

```text
# Shared contracts
node --test test/assessment-rules.test.mjs
pnpm test

# HR (after preparing hr_task_assessment_test)
node --test tests/assessment/*.test.mjs
# Legacy attendance fixtures require TZ=UTC (PowerShell: $env:TZ = 'UTC')
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit --maxWorkers=2 --workerIdleMemoryLimit=512MB

# PM (after preparing pm_task_assessment_test)
node --experimental-test-module-mocks --test tests/assessment/*.test.mjs
node scripts/run-smoke-tests.mjs

# Frontend
pnpm test
pnpm test:assessment:browser
pnpm build
```

The PM smoke runner isolates each file's ESM mocks without Node's nested test IPC, and keeps the smoke gate independent of a real database. The assessment browser harness mounts the actual components with mocked authenticated API boundaries; it is not a production end-to-end browser test.

See [acceptance traceability](task-assessment-v21-acceptance.md) for the attachment's A01–A25 and I01–I29 scenarios. Passing a unit test is not evidence that a source adapter, deployment or recovery procedure has been accepted.

**Launch remains gated** by company master-data/profile approvals, source-specific adapters and credentials, scanner verification, actual calendar/capacity reconciliation, business-owner UAT, live propagation/SLO checks, backup/restore and replay drills, projection rebuild validation, and realistic multi-company load tests. The broad RBAC run also reports 113 failures in authentication/tenant and other test fixtures; the focused assessment permission tests pass, but the entire RBAC suite must not be reported green.

## Source configuration and remaining acceptance work

A registered source may declare up to four `extracts`, each with a unique uppercase `key`, `kind` (`EVIDENCE` or `OPPORTUNITY`), polling interval, record/cursor/checkpoint paths and an optional typed evidence `mapping`. The source endpoint and its scoped credential are server-side environment settings `HR_ASSESSMENT_SOURCE_<KEY>_URL` and `HR_ASSESSMENT_SOURCE_<KEY>_TOKEN`. URLs must use HTTPS, redirects are refused, requests time out after ten seconds, and pages are limited to 100 records / 2 MiB. Tokens and source response bodies are never written to logs.

The endpoint receives `companyUuid`, `limit`, optional `cursor` and incremental `since` checkpoint. It returns `{ "items": [], "nextCursor": null, "checkpoint": "opaque-source-checkpoint" }`. A checkpoint advances only when the full page has passed strict validation and its events are durably queued. Failed pages retain the prior checkpoint. Native mappings select explicit paths and literal non-identity metadata; there are no executable expressions. Employee codes and company UUID must come from verified source fields. Canonical opportunity extracts follow `WorkOpportunityEvent`; they do not create capability or work authorization.

PM publishes available low-risk, explicitly supervision-permitted tasks with an approved minute estimate and dated work window. It refreshes freshness leases and withdraws offers when work is locked, started, closed or assigned. HR ignores older revisions, removes withdrawn/expired offers from matching and retains provenance. Manager-approved selections remain `AWAITING_PM_RECHECK` until the PM allocation workflow books them; the HR selection alone must never be presented as a committed assignment.

The code supports these connections, but this task has not configured or exercised live source endpoints, deployed migrations, activated workers or approved company profiles. Source-owner attribution/withdrawal checks, scanner acceptance, business UAT, private-stream recovery/replay, projection rebuild, migration/backup restore and realistic load/SLO exercises remain release gates. The attachment's operational acceptance targets cannot be certified from local tests alone.

## Recorded local results

The [machine-readable validation record](task-assessment-v21-validation.json) contains repository baselines, test boundaries and the unaccepted release gates. Final feature checks passed: 34 HR assessment tests, 11 PM assessment checks, 8 Chromium browser scenarios, 494 contract Vitest tests and 25 contract Node tests. The production frontend build passed with bundle-size warnings; changed HR, PM and frontend files passed lint.

The latest full HR unit run passed 3,096 tests and failed 11 assertions in five timezone-sensitive attendance suites when invoked in local time. Rerunning all five suites with the required `TZ=UTC` passed all 54 tests without product-code changes. The earlier correctly configured full run passed 3,107 tests. The frontend broad run's failing files passed after corrected tool-count assertions, moving expensive imports outside measured test bodies and focused reruns. These records distinguish focused reruns from a single fresh all-green full-suite run.

Assessment-specific Gateway and RBAC checks passed. The broad RBAC run remains at 564 passed, 113 failed and 68 skipped. No claim is made that full cross-module CI or production acceptance is green. No code was committed, pushed or deployed in this task; the six local branches remain available for review.
