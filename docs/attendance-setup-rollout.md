# Attendance setup releases

Attendance setup is edited as a draft and published for an inclusive operating period. Runtime attendance, leave day counts, approval routing and payroll read the effective release. An employee without published coverage is a setup exception; missing configuration must not manufacture absence deductions.

## Operator workflow

1. Save the tenant attendance policy, deduction rules and approval levels in Payroll Setup → Attendance setup. Every mandatory approval step must resolve to an employed approver. HR self-verification requires a separate management approver.
2. In Configure and validate attendance, select the operating dates and default calendar. Create named office profiles or dated employee assignments as needed. Employee assignments override office profiles, then tenant defaults. Manual monthly attendance is an explicit mode, available to any office.
3. Assign rosters with the visual editor. It supports weekday hours, overnight shifts, anchored rotation sequences, paid/unpaid breaks and limits for rest, consecutive days and weekly hours. Bulk assignment previews show each employee's success or conflict. Apply revalidates each employee inside an independent transaction.
4. Create or select holiday calendars; import CSV with `date,name,fullDay,startTime,endTime,description`. Partial holiday times belong to the named calendar date. Annual rollover previews copy month/day, requiring an explicit correction for invalid dates such as February 29 in a non-leap year. Assign calendars for each employee's applicable dates. Staffing targets count rostered people, not real-time availability.
5. Check device identities and simulate attendance. The simulator explains the effective profile, credit, overtime and occurrence rules; occurrence deductions require a period's actual history and are not implied by a single day's example.
6. Run readiness and impact preview. Correct employee-specific gaps, conflicting assignments, missing enrolments and approval routes. A content token ties publication to the exact previewed draft and period. Save a publication reason and publish. Future effective dates activate by date without rewriting earlier releases.
7. Historical corrections require a reason and a new publication. A payroll run covering the affected dates must first be recalled or cancelled. Changed occurrence deduction rules require an operating-period boundary; a payroll period cannot span inconsistent rule sets. Published configurations and recorded attendance snapshots preserve provenance.

The history action copies profile settings into a draft. It does not overwrite employee records, rosters or calendars. Those source records have their own editing controls and must be reviewed before publication.

## Deployment sequence

This is a coordinated backend/frontend change. First apply `20261010100000_attendance_setup_releases` with the normal Prisma migration deployment and regenerate the client. The migration adds setup draft/release tables with tenant RLS, attendance provenance, a setup-required status, holiday time windows, and pinned approval routing.

Use a staging database first. Pause attendance derivation, absence marking and payroll processing during the production cutover. Before resuming, publish validated coverage for each tenant for every period that will be calculated or replayed. Existing attendance and payroll are not rewritten by the migration. Existing configurations are deliberately not auto-published: an implicit calendar, conflicting roster or unresolved approval must be reviewed rather than silently approved. A tenant without a release will hold new calculations until setup is complete. Do not bulk-replay historical periods as part of the migration.

Existing pending requests without a pinned route resolve from a release when handled. Validate historical coverage for these requests before cutover; an empty or unresolved mandatory route remains pending. Escalation uses the request's pinned timeout/route, compare-and-swap workflow version and entered-at timestamp. It advances responsibility without recording approval. A transactional `hr.attendance.approval_escalated.v1` outbox event exposes recipient and request IDs for notification-hub; downstream notification delivery requires a consumer for that event.

The installation's device timestamps use civil wall-clock values encoded as UTC. This change preserves that contract and uses UTC date arithmetic so server timezone changes cannot shift attendance dates. The configured IANA timezone identifies the device calendar; this migration does not reinterpret existing punches or introduce multi-timezone/DST conversion.

## Validation

Targeted suites cover publication staleness, immutable releases, coverage expiry, payroll locks, failed roster replacement rollback, calendar transfers, employment gaps/rehire, rotation boundaries, partial holidays and breaks, profile precedence, device conflicts, approval escalation and tenant/permission boundaries. Frontend tests exercise readiness publication guards, preview invalidation, roster hours and CSV parsing. Prisma validation/generation and the frontend production build are required before rollout.

No migration or end-to-end staging deployment was executed against a live database during development. Complete the staging smoke test with real tenant permissions, calendar/roster writes, publication, device ingestion, leave creation and payroll before merging/deploying the coordinated change.
