# Attendance evaluation and finalization

This change is stacked on the attendance setup, capture and biometric branches. Deploy the backend migration `20261011000000_attendance_evaluation` before the matching application code and frontend. It has not been applied to a live tenant by this change.

## Calculation contract

- Explicit IN/OUT evidence forms intervals. Two verified INs cannot manufacture an OUT; a return after a completed interval requires its own checkout. Time outside recorded intervals is not physical presence.
- Scheduled unpaid exclusions intersect actual presence. Paid breaks and approved paid travel fill eligible gaps without double counting. Regular work, potential overtime, approved overtime, payable minutes and physical presence remain separate in the calculation snapshot. Published lateness, short-day and occurrence deduction rules retain their existing meanings.
- Existing overtime requests and their approval chain remain authoritative. Attendance uses approved request windows/hours, capped by recorded overtime and a daily approval budget. The payroll earning bridge still uses those approved requests; these attendance metrics do not introduce another earning line. Overtime changes enqueue reevaluation in the same database transaction.
- OPEN, AWAITING_DATA, NEEDS_REVIEW and FINALIZED describe processing independently of the displayed attendance result. Missing punch credit stays undetermined until evidence or the existing HR process resolves it.
- Existing civil `punchedAt` values are retained for compatibility. Real capture instants are normalized into the published timezone, and deadlines are converted back to real instants. Ambiguous legacy timestamps or shift deadlines are held for review. Pakistan-time cutoff and mixed legacy/current timestamp cases are covered by tests.
- Fixed and explicit split shifts share one employee/work-date summary. The summary weights session day credits by scheduled duration and retains individual intervals. A legacy rotation with no known window and no punch is a setup hold rather than an invented absence.
- Historical positional direction inference remains an explicit legacy-policy option; verified biometric direction is always authoritative. Recalculation can legitimately change old inferred results, so preview open periods first.

## Operations

1. In Payroll Setup, configure stable site codes, effective-dated employee permissions and device-to-site mappings. Add directional minimum travel times. Save, validate and publish the draft. Site rules become active when sites are published; existing deployments without sites remain compatible.
2. Configure device heartbeats in Attendance Capture. A no-punch date is held when its mapped/primary device is inactive or stale, or relevant unresolved capture evidence exists. A heartbeat is not proof that a device has uploaded every historical record: confirm backlog delivery during an outage recovery.
3. In Time and Attendance, inspect processing readiness and choose Preview recalculation. Queue recalculation for the open dates, then refresh processing to observe durable job progress. HR corrections are preserved. Use this queue for a fleet/month backfill instead of calling the synchronous internal writer for the entire fleet.
4. Open a day's Why? view for policy/version, sessions, minutes, source/PAD assurance, exceptions and the latest 20 calculation revisions. The database retains all revisions. Excluding/restoring a conflicting punch requires another identified HR reviewer, a reason and the observed record version; original evidence and capture audit remain intact.
5. Approve site travel only when the employee has an OUT at departure and an IN at arrival. Impossible travel time remains a hold even if approval is attempted. Travel approval/revocation is attributed and replayed. Continue using the existing overtime request/approval screen for overtime.
6. Resolve setup, capture and calculation issues before payroll submission. Readiness covers every expected employee/date, including missing rows and pending evaluation jobs. A final HR request decision can settle missing-punch payroll treatment; it cannot waive device, site or clock evidence conflicts. Timing overrides do not bypass completeness.

## Worker and protection

The attendance capture worker also plans and drains finalization jobs. Keep `ATTENDANCE_CAPTURE_WORKER_ENABLED` enabled. `ATTENDANCE_EVALUATION_CONCURRENCY` defaults to 2 and is capped at 4. The planner persists its last planned work date, catches up at most seven days per tick, and starts with yesterday/today on first deployment. Older open periods need an explicit queued backfill. Jobs retry with a delay capped at one hour; failed/protected jobs remain visible. OPEN jobs wake at their own shift end plus checkout allowance, including overnight shifts. Evidence holds retry after 15 minutes.

All automatic attendance writes share the period lock with payroll submission. Database triggers also reject insert/update/delete in active payroll periods, including legacy writers. Approved overtime mutations have the same guard. Recall/cancel an unprocessed submission before authorized changes; unsubmit re-arms protected evaluation jobs. Late capture evidence for a protected shift is retained for review. A closed previous month does not block an unrelated new-month shift.

## Verification and rollout

The behavioural suite covers intervals, split shifts, old/current timestamps, Pakistan deadlines, outage holds, delayed evidence, human decisions, site travel, exclusions, payroll month boundaries, 550 employees/seven sites and the existing setup/capture/overtime rules. Frontend interaction tests cover preview/queue, protected periods and versioned evidence review; the production build is also checked.

The `Attendance evaluation database safeguards` workflow runs PostgreSQL 16 against a disposable database: migration/schema changes, forced tenant RLS, protected attendance mutations, immutable identity, overtime invalidation and concurrent payroll locking. Its bootstrap isolates this migration rather than rehearsing all historical migrations. Before production rollout, rehearse the entire migration chain on a staging copy, preview the first open payroll month, and verify real device upload/recovery at Head Office and each site. Synthetic scale tests validate batching, not a production latency SLA. Biometric recognition and PAD deployment requirements from `attendance-biometrics-rollout.md` still apply.
