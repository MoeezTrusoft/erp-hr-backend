# Attendance shift cutoffs, reporting lines and timesheets

The next shift means **this employee's next scheduled shift**, including dated assignments and roster rotations. Another team's shift does not constrain the employee's checkout.

## Behaviour

- The existing shift master (`ShiftTemplate`, physical table `shift_templates`) holds `departmentId`, `supervisorId`, `checkoutCutoffTime` and `checkoutCutoffDayOffset`. There is no separate mapping table. The offset distinguishes the shift's start date from the following date.
- An explicit cutoff must be at or after shift end and at least one hour before the next scheduled start. Writes validate recurring patterns, roster version transitions and dated assignments. Invalid writes roll back. An unused template can be configured before a roster exists; its first assignment validates the employee's sequence.
- A punch exactly at the cutoff is allowed. Later evidence cannot close the earlier shift. It is assigned to an eligible later shift or retained for review with its original timestamp and direction. An authenticated OUT is never silently changed to IN.
- Legacy shifts with no explicit cutoff retain the configured checkout leniency, bounded by the employee's next start minus one hour.
- Reports To uses the existing `Employee.managerId`. Assigning a department's shift applies that shift's supervisor; no configured supervisor leaves the current manager unchanged. Future changes apply on the company's civil date through the attendance planner. Company boundaries, inactive supervisors, self reporting and reporting cycles are guarded. Each actual reassignment records employee codes, previous/new supervisor codes, shift, department, effective date and actor in the attendance audit.
- The timesheet includes weekly-off and holiday rows from published calendars, preserving recorded check-in/out and hours. Absence cases are attached to their employee/date row. These display rows do not create payroll credits or rewrite stored financial decisions.
- The anomaly review response supplies both the paginated records and all four card counts, with the same employee/date/status scope. Legacy cases remain visible through their existing review workflow.
- Attendance capture events invalidate the timesheet and anomaly queries. Reconnection refreshes the data; a visible tab polls every five seconds while the stream is unavailable. The review panel additionally refreshes every fifteen seconds.
- Grace settings remain unchanged. Comparisons retain seconds: late means `IN > start + grace`; early means `OUT < end - grace`. Equality is on time, for both zero and nonzero grace.

## Release and HR configuration

1. Back up the target database and apply migration `20261018090000_shift_checkout_supervisor` with the normal Prisma migration deployment process. The migration is additive and does not update grace values or assign supervisors to employees.
2. Generate the Prisma client and release the backend, then its companion frontend change. Keep the existing attendance capture, evaluation, planner and event-stream workers running. No new role grants are introduced; existing shift management and attendance permissions apply.
3. In Shift Templates, HR chooses the department, supervisor **employee code**, latest checkout and cutoff day. Configure separate department shift records where supervisors differ. Actual employee identities must be confirmed by HR; examples are not seeded as reporting lines.
4. Select the template in each employee's roster, or use dated shift assignments. Publish revised attendance setup for roster/template cutoff changes: existing published snapshots remain unchanged until a new publication. Dated assignments are operational overrides; changes for elapsed/current dates enqueue evaluation, subject to payroll-period locks.
5. Verify the employee's Reports To and audit trail after the move. Check an overnight cutoff, an exact-boundary punch, a punch one second past the grace boundary, a worked holiday and the anomaly counts in the same company and period.

## Verification

- Full backend Jest regression, including tenant boundaries and existing payroll/approval tests.
- PostgreSQL integration tests in `tests/attendance/enhancements.test.mjs`: actual shift/roster writes, reporting audit, rollback, tenant isolation, capture evaluation, holiday/absence rows and shared counts. The tests use isolated fictional employees and are included in the database CI workflow.
- Companion frontend tests cover shift edit round-trips, template selection, calendar hours, employee codes and a real SSE capture frame refreshing React Query and the review summary.
- Prisma schema validation, an additive migration rehearsal, lint, dependency boundaries and the frontend production build.

This change does not populate company-specific cutoff or supervisor decisions and does not rewrite historical published attendance setup automatically.
