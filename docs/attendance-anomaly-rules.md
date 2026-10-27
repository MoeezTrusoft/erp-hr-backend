# Attendance anomaly rules

Implementation of the business rules supplied in `Attendance_Anomaly_Rules.docx` on 12 October 2026. This supersedes the earlier automatic penalties, arbitrary manual deduction amounts, whole-day waivers, and WFH-only missing-time restriction.

## Operating flow

1. The published employee roster, leave/holiday calendar and accepted capture evidence identify each scheduled shift. Device outages, conflicting punches, ambiguous timestamps and missing setup remain holds.
2. Evaluation creates one case for each applicable anomaly on each shift. Multiple shifts and multiple anomalies remain independent. No IN/OUT produces absence; one boundary produces the other missing-boundary case. Available boundaries are also tested for lateness/early departure.
3. The employee may explain; their actual line manager may recommend an outcome. HR records verification. Management decides after HR has verified the current evidence. A changed fact invalidates that verification. Stale edits are rejected using the displayed version.
4. Only a verified `Management` role may approve or disapprove. Administrator privileges and ordinary HR roles cannot substitute. A Management employee cannot decide their own case. Approval excuses only that anomaly.
5. HR may supply missing IN, OUT or both on any published scheduled shift without Management approval. Original device boundaries cannot be overwritten. Entries record the actor, timestamp, direction, shift and reason as append-only evidence. Times are evaluated by the same rules; entering one boundary does not credit a full day automatically. Existing payroll-period protection still applies to manual evidence changes.
6. Only active, Management-disapproved cases enter payroll pricing. Pending cases are reviewed through the normal workflow. Management decisions finalize attendance only when every case on the shift is settled and all capture/setup holds are cleared.

## Grace and deduction rules

Check-in and check-out grace resolve separately: **shift → employee → team → department → company → zero**. Blank means inherit; zero explicitly supplies no grace. Each rule and group membership is dated and versioned. Shift keys are the roster's `graceKey` when supplied, otherwise the clock span, such as `09:00-17:00`. Department/team keys are tenant-local identifiers shared between the dated membership editor and grace editor.

| Disapproved anomaly | Deduction |
|---|---:|
| Late or early by more than 30 minutes | 0.5 day for each anomaly |
| Late or early by at most 30 minutes | One day for every three pooled minor anomalies per employee and payroll period |
| Missing check-in or missing check-out | 0.5 day each |
| Absent | 1 day |

Timing is measured from the scheduled boundary, including seconds; grace determines whether a case exists and is never subtracted before applying the 30-minute threshold. Minor remainders expire at period end. Different shifts are not capped into one daily penalty. Existing salary-basis, calendar-day divisor and whole-currency-unit rounding conventions are preserved; the basis/divisor are frozen on each newly processed payslip. Attendance deductions do not change the existing engine's taxable-earnings calculation.

Past-dated grace or membership edits enqueue durable employee/date jobs from the effective date. Missing historical setup is surfaced as a hold rather than silently skipping earlier dates. A case that becomes in-grace is closed, its previous decision is retained in the immutable audit, and its financial contribution is reversed. Newly out-of-grace cases require normal review. Unchanged missing/absent facts retain their existing decisions.

## Payroll revisions

- Unpaid payroll, including finalized payroll, is recalculated in place with an audit of totals and day quantities.
- Disbursed payslips and deduction lines stay immutable. Revisions create signed, uniquely numbered adjustments against the original payslip. Repeating the same evaluation adds nothing.
- An existing next unpaid payroll receives the adjustment immediately. Otherwise its next processing run claims it atomically with the payslip. Reprocessing includes already-claimed adjustments exactly once. Cancelled/deleted or failed unpaid target runs release the claim for a later run; the source adjustment remains auditable.
- Payroll processing and attendance financial revisions use the same tenant advisory lock. A decision that encounters a processing run is rejected for retry, with no partial attendance or payroll writes.

## UI and API

Timesheet and Leave Management use the same per-shift review. The review shows source times, manual provenance, grace, timing severity, explanations, verification and decision history. Lists are server-paginated. Payroll Setup → attendance readiness contains grace, dated team/department membership, evaluation-job errors and historical pricing adoption.

The `hr_attendance_rules_*` tools enforce tenant/employee scope and server-side roles. Retired mutation routes return HTTP-style status 410 with a pointer to the new workflow; historical records/attachments remain readable. Legacy imports and decisions cannot become a new rule deduction merely by setting a status or amount.

## Deployment and adoption

Deploy after the attendance-evaluation migrations and the corresponding frontend change. Run `prisma migrate deploy`, regenerate the Prisma client, and restart API and attendance workers together. No live database changes are performed by this source revision.

Before enabling payroll on an existing tenant:

1. Back up the database and validate migration and representative historical periods in staging.
2. Queue attendance evaluation for the open period. Re-evaluate past periods through dated grace edits or historical pricing adoption as applicable.
3. Review historical manual corrections. Single-shift entries that agree with device boundaries or fill missing boundaries are preserved automatically, including an audit of the original row. Conflicting corrections or ambiguous split-shift day-level corrections return `LEGACY_MANUAL_REVIEW` and remain unchanged. Resolve those legacy source conflicts explicitly before replay; they cannot be silently mapped to a shift or overwrite device evidence.
4. Published legacy company/profile grace remains attributable default configuration. A new dated rule replaces the legacy default at the same scope, including an explicit blank to inherit. New settings should use the grace editor.
5. Historical payslips without a saved salary basis are held for pricing adoption. Management must enter the documented original salary basis and evidence reference in Payroll Setup. The original period supplies the divisor; legacy attendance deduction lines are retained in the adoption audit. Current salary is never guessed as a historical rate. Paid amounts remain unchanged.
6. Confirm unresolved setup/capture holds and failed jobs are cleared before payroll submission. Do not interpret a queued change as completed reconciliation.

## Verification

Pure rule tests cover grace inheritance, zero, dates, seconds, overnight shifts, mixed minor pools, independent cases and Management-only charging. Workflow tests cover role and tenant scope, stale writes, immutable manual times, old-correction preservation, evidence holds, case reversal and split shifts. Payroll tests cover in-place revision, paid refunds/recoveries, target-run application, failed-run release, frozen historical pricing and transaction rollback.

`scripts/test-attendance-evaluation-postgres.py` applies both the evaluation and anomaly migrations to an empty, explicitly named disposable PostgreSQL database and checks RLS, append-only evidence, period protection, payroll locks and paid-record guards. The GitHub attendance-evaluation workflow runs this integration check.
