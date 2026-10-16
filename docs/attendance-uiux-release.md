# Attendance UX implementation and validation

Specification: **TruSoft Time and Attendance UI UX Specification v1.0**, 16 October 2026. This record distinguishes implemented changes, automated evidence and acceptance still requiring people or equipment. It is not a production deployment certificate.

## Implemented behavior

- Employee-code selectors search the permitted company/reporting scope, page results, rank an exact code first and never silently select a partial match. Audit actors resolve by employee code or verified account linkage, never by treating an account ID as an employee ID.
- Timesheet filtering uses the published employee-day site, department and shift. Evaluated historical setup snapshots take precedence over later setup edits. Calendar-only days remain visible, unknown hours remain unknown, and an unevaluated working day does not become absent merely because there are no punches.
- Anomaly cards and review rows come from one filtered response, including total counts and observation time. Resolved absence history does not override the current daily outcome.
- A four-step employee correction form saves incomplete drafts separately from submission. Unknown factual times start blank. Supported missing times require reason category, evidence reference and source date. Duplicate active requests are prevented per company, employee, date and session.
- `ATTENDANCE_CORRECTION` uses the existing approval service: employee submission, manager recommendation, HR verification and Management decision. Management returns to HR. HR can resolve unchanged facts or return to the initiator. Final application and approval are atomic; a changed attendance evaluation prevents a stale approval from applying.
- The old direct missing-time write tool returns an actionable retirement response. Approval is mandatory for application. A draft write cannot change attendance.
- Roster writes have a read-only impact preview. The preview token binds the proposed change and affected current state. A changed proposal or changed underlying assignment requires a new preview. Existing cutoff validation, department/shift supervisor mapping and reassignment audit remain authoritative.
- Period readiness includes submitted/returned corrections and their current stage. Unsubmitted drafts are not represented as pending approvals. The screen can use a real payroll-run period; a manually selected attendance window is explicitly distinct from payroll readiness.
- Exports are company and role scoped, separately require `hr.attendance.export`, exclude biometric artifacts and carry a durable job and audit reference. The permission is checked at generation and every download page. Durable jobs expose queue/processing/ready/failed/expired states, recover after a worker lease expires, retain results for one hour, and reject a download when the employee scope changes. PostgreSQL slices large artifacts into 1,000-row download pages. CSV cells are protected against formula injection; print output is constructed with text nodes, not executable HTML.
- Named saved views are private to the authenticated account within the selected company. They save only supported filters, require a current version to replace/delete and never grant access to records.
- Frontend changes add URL-backed filters and sorting, a My Attendance summary, correction status links, separate calendar/outcome/processing fields, worked duration labels, desktop pinned identity columns, a usable narrow-screen scroll region, and stream renewal after token/company changes. Polling reconciles attendance when the event stream is unavailable.

## Rules retained

Grace configuration is not changed. Late means strictly after start plus grace; early means strictly before end minus grace. Equality is on time. The cutoff is measured against the **employee's next scheduled shift**, with a gap of at least 60 minutes; a different team's shift is not the reference. Verified OUT events retain their direction. Department and supervisor remain on the existing shift table. No missing reporting line, administrator label or negative manager recommendation grants final approval authority.

## Screen coverage

| Specification screens | Implementation surface |
| --- | --- |
| TA01–TA05 overview, own attendance, daily records, explanation and anomaly review | Timesheet, MyAttendanceOverview, AttendanceFilters, AttendanceEvaluationPanel, AttendanceRulesPanel |
| TA06 correction | CorrectionStepper; correction draft service and approval adapter |
| TA07–TA08 approval and evidence review | Existing ApprovalCentre, version checks, return destinations and separate request evidence |
| TA09–TA12 capture, review, enrolment and devices | Existing capture and biometric services; code selectors, event/receipt distinction and preserved source/PAD states |
| TA13–TA14 roster and shifts | Work schedules, shift master and preview-bound roster commit |
| TA15–TA17 calendar, leave, overtime and related requests | Existing calendar/leave/overtime services and shared approval chain; code-only display changes |
| TA18 readiness and policy activation | Existing company setup tracker, evidence, Management approval and version-bound activation |
| TA19 period reconciliation | Actual payroll-period selection and correction blockers in completeness |
| TA20 audit and exports | Actor-code projection, review dialog, scoped export and durable audit receipt |

This table maps surfaces, not a claim that every proposed design or service target is certified. The acceptance limits below remain explicit.

## Automated acceptance evidence

All database/browser fixtures use an isolated loopback PostgreSQL database with synthetic companies and employee codes. Production data and policy values were not changed.

| Criteria | Evidence |
| --- | --- |
| AT01–AT02 cutoff equality, next scheduled shift and source direction | Existing attendance enhancement/processor unit tests and `tests/attendance/enhancements.test.mjs` |
| AT03–AT07 calendar rows, absence uncertainty and second-precision boundaries | Attendance enhancement/evaluation tests, native PostgreSQL projection test and browser IN/OUT/correction scenarios |
| AT08 roster, supervisor and no-supervisor behavior | Native roster test, preview-without-write assertion, changed-proposal rejection, audit and rollback assertions |
| AT09 case count parity | Native correction test plus frontend attendance enhancement tests; shared filtered snapshot exercised across pages |
| AT10–AT13 authority, returns, stale versions and repeated submissions | Shared approval native tests and browser acceptance; correction draft and final-application PostgreSQL tests |
| AT14 setup evidence and activation | Five company-setup browser scenarios, including changed-version activation block and approved identity application |
| AT15–AT17 capture uncertainty, retry/deduplication and evidence/import recovery | Existing capture, biometric and import regression tests; physical-device validation remains outstanding |
| AT18 reconnect and company isolation | Realtime core tests, added company/token restart test, server scope rejection and live row refresh browser scenario |
| AT19 responsive and keyboard behavior | Chromium 320px overflow check, focusable controls/stepper and desktop pinned-column check; assistive-technology certification is not claimed |
| AT20 employee-code identity and exports | Native paginated exact-code test, actor mapping tests, server export denial, browser export receipt and minimal export projection |
| AT21 locked periods and stale application | Existing period/approval regression and PostgreSQL stale-evaluation test proving no partial approval or manual-time write |

The full HR Jest run passed **270 suites / 3,237 tests**, with two suites and eleven tests already skipped by their environment guards. Subsequent focused tests cover the final export gate and daily correction projection. The frontend full run passed **387 files / 3,036 tests** with one image-paste timeout; that existing test passed in the focused rerun. Three frontend tests remain intentionally skipped. The shared contracts passed 501 Vitest tests and 40 Node tests. The lint gate passed with no errors or new warning fingerprints; existing warning debt remains visible.

The release evidence directory contains individual command logs, browser traces on failure and synthetic screenshots. Browser review covered all existing approval source kinds (27 scenarios, with one isolated timeout rerun), five company-setup scenarios and the attendance workflow scenarios. See the frontend companion report for the final browser/build result.

## Migration and release sequence

1. Use contracts commit `f40f1784ba1a7ec60bb204baa8e5fea9af28d419` (contracts PR 13) or its merged descendant containing the correction kind. CI references the immutable commit.
2. Take the normal database backup and deploy the HR artifact with its matching Prisma client. Apply `20261019090000_attendance_correction_workflow` and then `20261020090000_attendance_workspace` with the repository migration process, after existing approval and shift migrations. Do not run the disposable-test reset script on a server.
3. The migration creates correction storage, the active-request unique index, clock constraints, FORCE RLS and the existing approval source guard. It does not assign supervisors, populate employee data, change grace or invent company policy.
4. Retain verified grants: attendance read for visible records; `hr.approvals.self` for employee drafts/submission; manager/verify/approve grants for the corresponding stages. Export needs the separate attendance export grant. Do not grant Management authority to resolve a missing manager.
5. Deploy the frontend only after the HR schema/tool registry and contracts are available. The gateway's normal HR tool discovery must expose the thirteen new attendance tools; refresh its manifest cache through the existing deployment procedure if needed. The in-process export worker starts with HR outside tests, unless `ATTENDANCE_EXPORT_WORKER_ENABLED=false`. At least one HR worker must run it. Multiple replicas claim jobs using row locks and lease tokens. Expired artifacts are removed by that worker; job/audit metadata remains for traceability.
6. Run smoke checks using synthetic authorized records, including a negative export test, one return from Management to HR and an approved correction. Check attendance stream recovery and the new table's migration visibility.
7. If rollback is required, revert the frontend first and preserve correction requests/audits. Do not drop the table or restore a legacy direct-write bypass as a recovery mechanism.

This task has not applied a production migration, changed live role grants, merged branches or deployed to `erp.trusoft.ai`.

## Remaining acceptance and product limits

- Background exports accept at most 92 days and 100,000 filtered daily rows, with two active jobs per account/company. A larger result fails visibly without a partial file. One-hour artifact expiry is a technical download limit, not a policy governing the original attendance or evidence records. The legacy synchronous export tool remains for compatibility with its existing 20,000-row limit.
- Named views are capped at twenty per account/company. Supported filters and sort remain bookmarkable URLs; no employee or biometric data is saved in a view.
- The new correction form uses the specification's **evidence-reference** option. It does not introduce a new binary attachment/scanning subsystem. Existing evidence attachment services remain in their established workflows.
- Device/PAD capability, seven-site network conditions, peak capture-to-render latency, screen-reader use, 200% browser zoom across the complete shell, and the proposed 90% unassisted HR/employee usability target require a supervised pilot. A 550-person/seven-site synthetic projection test is functional scale coverage, not a P95 latency measurement.
- HR must still supply real reporting lines, cutoff/supervisor decisions, absence-finalization rules, device capability evidence and evidence-governance decisions identified in section 36 of the specification. These are not inferred from sample names or device labels.

The software implementation and automated workflow checks do not certify the physical-device, assistive-technology or production service targets. Record those pilot results before claiming full operational acceptance of every target in the specification.
