# Onsite attendance acceptance

The HR Time & Attendance **Onsite Acceptance** workspace implements TA OAT 001 v1.0. It provides seven company-scoped physical-site slots, the 56-case catalogue and the complete PDF guide. A slot is mapped to a published ERP site; location names and employee counts are supplied by HR, never inferred from company names. A shared physical device is governed in its registered owner company. Its approved baseline includes every allowed company; changing those permissions disables capture and requires requalification.

## Execution and approval

1. An authorized preparer starts a site package and records the installed serials, exact models, configuration references, approved targets, employee/setup readiness, fallback and retention references. Select a named operating mode for each device. No results are pre-marked passed.
2. Record the tests generated for the enabled devices. Mandatory site tests and installed-device tests cannot be N/A. An excluded device family requires a documented N/A result. Each completed result needs an independent witness employee code, observations and evidence; passed tests also require execution times, attempt counts and measured results. The separate guide supplies the sample sizes and numerical targets.
3. Upload sanitized PDF, PNG, JPEG, DOCX or XLSX evidence (2 MiB per file; 300 per site), or link controlled external evidence references. Files are encrypted, content-hashed and immutable. Downloads require the same verified company context. No biometric images/templates, secrets or employee names belong in the ordinary evidence pack. The exported JSON register includes metadata and results, not file contents or internal actor IDs.
4. Track findings with severity, owner employee code, due date, containment, resolution and a fresh passed retest. Failed/blocked tests require a linked defect. Independent HR closes defects; owners and the person who raised a defect cannot verify its closure. Critical/High findings cannot be downgraded into minor findings or waived at activation.
5. The named independent technical witness attests the frozen results and N/A decisions. The employee initiator submits to their recorded line manager (also the configured site lead). The manager recommends approval/rejection or returns to the initiator. HR independently verifies or returns to the initiator. Management independently approves/rejects or reverts to HR. HR can verify the unchanged returned package or return it for preparation; edits require renewed technical attestation and the complete approval chain.
6. An activation operator activates the approved inventory. Approval is bound to the exact evidence hash and recorded device settings. Activation rechecks test completeness, open defects, five distinct past operating-observation dates, readiness and live device configuration. Unknown face PAD cannot enable automated camera attendance. SecuGen automated mode additionally requires the registered signed kiosk and validated nonzero PAD configuration. CL1 requires manufacturer/protocol evidence.

The manager's recommendation is visible in the immutable audit trail. A recommendation to reject is not a final rejection; HR verifies the evidence and Management makes the final decision. No generic administrator bypass is provided.

## Roles

Use existing independently verified company grants; do not grant all stages to one account:

| Responsibility                     | Required grants                                                         |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Read, download, export             | `hr.setup.read`                                                         |
| Prepare results/evidence/defects   | `hr.setup.read`, `hr.setup.prepare`                                     |
| Named technical witness            | `hr.setup.read`, `hr.setup.prepare`; must not have authored the package |
| Recorded line manager              | `hr.setup.read`, `hr.approvals.manager`                                 |
| HR verification and defect closure | `hr.setup.read`, `hr.approvals.verify`                                  |
| Management decision                | `hr.setup.read`, `hr.setup.approve`                                     |
| Activate or suspend                | `hr.setup.read`, `hr.setup.activate`                                    |

Every actor requires one active linked employee code in the selected company. Missing reporting lines are surfaced as submission blockers. The UI uses employee codes, not employee names, for witnesses, owners and approvers. Role assignments are not invented or granted automatically by the migration.

## Capture enforcement and safe rollout

- Apply migration `20261020120000_attendance_onsite_acceptance`, regenerate Prisma and deploy matching contracts, gateway, HR and frontend revisions. The migration adds tenant-isolated acceptance tables, append-only evidence/audit guards and device activation guards.
- New registrations are inactive. Ordinary capture controls cannot enable a device. The acceptance service is the activation path; the database also rejects activation without its approved review context.
- Existing live devices remain live with no acceptance reference and are explicitly shown as acceptance pending. The migration does not certify them or abruptly stop seven sites. Complete their onsite qualification and perform the approved cutover individually. Existing devices that are disabled must obtain acceptance before reactivation.
- Changes to serial, company, site, timezone, allowed companies, signing key or PAD settings automatically disable the affected device and clear its acceptance binding. Health updates do not. Reopen/rebaseline the package, repeat affected qualification and obtain approval again. A baseline/scope change resets results; older results remain in encrypted audit snapshots.
- Approved supervised devices retain capture evidence in review. Retry, Resolve and direct biometric exception approval cannot release this evidence. Use an evidenced employee attendance correction through the existing manager → HR → Management workflow and reference its original capture. The projection worker also refuses a supervised capture if its state is improperly changed to Pending.
- Suspend deactivates all devices bound to the site package in the same transaction. Preserve queued/raw evidence and use the controlled fallback from the guide. Production attendance/payroll history is not rewritten by acceptance tests.
- Physical firmware/model changes outside ERP require an operator to suspend/requalify. Stored ERP configuration hashes cannot observe a physical change by themselves. Review dates identify the next review; they are not an automatic timer that disables capture.

## Validation

`tests/acceptance/*.test.mjs` exercise the real PostgreSQL service with FORCE RLS using the disposable local assessment database. The frontend `test:acceptance:browser` harness runs the actual workspace against that service. It is loopback-only and never registered in production. Tests cover the seven-slot overview, empty/incomplete gates, attachments, independent stages, reverts, idempotency, stale revisions, cross-company evidence denial, guarded activation/suspension, defect closure and changed-device requalification.

The SQL migration is required; deploying only the screen is insufficient. This workflow records witnessed outcomes and approvals. It does not itself certify PAD hardware or execute physical onsite attacks, power cuts or network outages.
