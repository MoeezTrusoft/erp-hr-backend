# Attendance anomaly management

Management may mark each anomaly for 0.5 or 1 day, or clear its marking, with a required reason. The configured Management approver (or an administrator) can mark another employee's anomaly. Marks are audited and cannot be changed once an active payroll run covers the date; cancel/recall the run first.

Payroll uses the highest manual marking once per employee/work-date shift: two half-day marks still mean half a day; any full-day mark means one day. This replaces automatic attendance deductions for the shift. Marked shifts are excluded from automatic credit-loss and occurrence counters, including pooled thresholds, so the same anomaly cannot trigger a second automatic charge later in the period. Clearing all manual marks restores normal automatic rules. Overnight attendance uses the shift start work date. Approved regularizations excuse their own anomaly type, not unrelated anomalies in the shift. Payslips identify the work date and the manual override amount.

Requests are unique by employee, work date, and anomaly type. The UI groups a shift's anomalies but exposes each request and decision separately. Evaluator evidence can receive a management marking but cannot be approved or returned as a submitted request.

Applicants and HR may upload up to five PDF/PNG/JPEG attachments, at most 2 MiB each and 5 MiB total. File signatures are checked; DAM stores the bytes and the request stores references. Only the applicant, approval-matrix participants, and administrators can resolve the download link. Existing evidence remains attached when a request is returned or resubmitted.

Any configured approval-matrix participant may return a pending request to the applicant or an earlier resolved participant, with a required comment. The target must precede both the acting participant and the current approval step. Reset decisions are copied into immutable workflow history before being cleared. A return to the applicant stays PENDING at level 0 and blocks timesheet submission until resubmitted and resolved. The applicant resubmits an updated explanation through the configured matrix. Version checks reject stale/concurrent changes.

## Release order

1. Apply the additive migration `20261008100000_hr_anomaly_management` with the normal HR migration workflow.
2. Regenerate the Prisma client and deploy the HR backend.
3. Publish the corresponding frontend main revision, including the shared tool allow-list.

The migration adds four columns and an index to attendance_anomalies, preserving existing data and RLS. This change does not itself execute a production migration or assign deductions to employees. DAM must be reachable via the existing tenant-scoped HR service authentication. API request limits must allow the maximum base64 payload (approximately 7 MiB).

## Validation notes

The full migration chain was applied to a disposable PostgreSQL 16 database. Its schema comparison reports pre-existing differences for raisedById/raisedByName, the attendance_call_ins employee foreign key, employee_device_enrolments primary index, and loan_repayments uniqueness index. These unrelated baseline differences require a separate migration reconciliation before claiming a drift-free fresh installation. The new anomaly columns and index match the schema.
