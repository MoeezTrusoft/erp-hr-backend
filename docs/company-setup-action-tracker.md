# Company setup completion and Management approval

Open **HR → Employee Management → Company setup & policy review → Company action list** in one selected company.

The tracker implements the company action-list review of 16 October 2026 using current ERP data. It does not hard-code employee identities or import stale spreadsheet values. It contains 13 company preparation actions, one task per employee code, and each detected identity clarification. Resolved cases remain available with their evidence. The spreadsheet's final approval and activation actions are represented by the actual review workflow, not by manually ticked completion boxes.

## HR completion

1. Filter by policies, employee setup or identity clarifications; search employee codes, account logins or owner codes. Remaining, overdue and status filters are available.
2. Open an action and assign an active company employee-code owner and due date. Record progress, findings and controlled evidence references. Upload PDF, PNG, JPEG, DOCX or XLSX evidence (maximum 2 MiB per file; 20 files per action). Larger documents can use access-controlled document references. Files are encrypted at rest, scoped to company setup readers and served as downloads only. A file signature check is not a malware-scanning certification.
3. Link relevant employee/identity correction review references. Complete those corrections through their existing Management approval and HR activation workflow. Linking a review does not approve or activate it.
4. Mark an action complete only with owner, due date, findings and evidence. Linked correction reviews must be active. N/A is limited to historical inactive employee setup without enabled company access, with a recorded rationale and evidence. It cannot waive live readiness blockers.
5. Prepare the company policy and its four required controlled references. When tracking or evidence changes after saving the policy, choose **Refresh action snapshot** on the editable policy review. Inspect the frozen completion evidence and submit to Management.

The policy covers all separation types, initiation and notice rules, category/grade authority, HR/IT/payroll/clearance owners, controlled letters, settlement settings, jurisdiction, retention and integration verification. HR can prepare evidence and policy drafts while manager sheets are pending; completed setup cannot be submitted until the required live configuration is ready.

## Management and activation

Submission requires complete current action evidence and passing live readiness. Management can inspect each action's owner, due date, findings, references and downloadable files in **Company completion evidence**. The action list freezes while the policy is with Management or approved.

Management approves, rejects or returns the review to HR. Approval is unavailable to anyone who edited the policy or any included action evidence. HR may edit a returned/rejected package and must refresh its action snapshot before resubmission. HR then activates the approved policy separately. Readiness and the exact action snapshot are checked again at approval and activation. New employees, new identity issues, changed setup, withdrawn authority or an unavailable account service cannot be bypassed by a previously checked completion status.

This company-configuration workflow is HR initiated. Employee-initiated requests retain employee submission → line-manager recommendation → HR verification → Management decision, with Management returning to HR.

## Records and safeguards

- Only company plus employee code identifies employee owners and subjects. Login addresses identify accounts requiring clarification. Internal numeric employee/account identifiers are not exposed in tracker results.
- Company scoping is enforced by verified request context, existing `hr.setup.*` permissions and PostgreSQL FORCE RLS. Admin flags do not bypass permissions.
- Action changes use optimistic versions, company locks, idempotent command receipts and append-only audit entries. Evidence files are immutable; attaching evidence to a completed action reopens it for verification.
- Completion requires valid account/status configuration as well as existing policy readiness checks. Blank contract notice may use a valid category/grade fallback. Missing manager exceptions require verified Management classification and explicit policy authority.
- No employee, manager, account ownership or policy decision is inferred or automatically approved. Existing active policies remain unchanged by migration. Older unactivated policy drafts require a refreshed completion snapshot and the new checks.

## Coordinated release

1. Release shared contracts containing the four tracker/evidence tools before their consumers.
2. Back up HR data; apply `20261017090000_hr_setup_action_tracker` and generate the HR Prisma client. Deploy HR and rebuild the gateway with the updated contracts so its existing contract-driven permission map and tool discovery include the new tools.
3. Release the frontend. Existing HR `hr.setup.read/prepare/activate` and Management `hr.setup.read/approve` grants are reused; no broad new role assignments or employee mapping changes are needed.
4. Verify company-specific tasks, HR updates/uploads, Management read-only action access, complete-package submission, return/revision, independent approval and HR activation. Never use real employee corrections merely to create test evidence.

For isolated regression, prepare the disposable loopback HR assessment database with `tests/separation/prepare.mjs --reset`, then run `node --test tests/company-setup/workflow.test.mjs`. Browser tests use `tests/company-setup/playwright.config.js` and the real HR service against that disposable database, with a controlled RBAC fixture.
