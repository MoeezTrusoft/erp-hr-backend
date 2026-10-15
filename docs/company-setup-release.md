# HR company setup and policy review

Open **HR → Employee Management → Company setup & policy review** (`/hr/company-setup`) in one selected company. Employees, proposed managers, reviewers, and policy owners are identified by employee code. Login addresses appear only where needed to clarify account identity.

HR can prepare three independently reviewed items:

- **Company policy:** all separation types, initiation controls, notice rules, grade/category authority, clearance owners and signers, approved letter templates, settlement rules, jurisdiction review, retention controls, and integration evidence.
- **Employee setup:** missing category, grade, contractual notice, reporting line, or an evidenced resolution of conflicting status fields. Existing category conversions still use the dedicated conversion process. A blank notice field preserves its current value; zero is an explicit contractual decision.
- **Identity clarification:** link or correct a company account's primary employee, or remove that account's access to the selected company. Worklists detect missing codes, conflicting primary accounts, and mappings outside the company. HR may also open a review proactively.

The **Company action list** tracks owners, due dates, progress, evidence attachments and correction reviews across these items. Policy submission now includes a frozen company-completion snapshot and requires complete evidence plus current readiness. See [Company setup action tracker](company-setup-action-tracker.md) for the updated workflow and migration.

## Review and activation

HR saves drafts, adds controlled evidence references, and submits to Management. Management approves, rejects, or returns the item to HR. HR can revise and resubmit returned or rejected drafts. Approval requires a reviewer who neither edited the proposal nor owns the affected identity. Merely holding an administrator flag does not bypass these checks.

Approval freezes the exact proposal and source snapshot. HR separately activates it. Changed source records require a return to HR and a new decision. Activation uses optimistic versions, command receipts, company locks, and append-only history. Evidence, snapshots, and replay results are encrypted using the existing HR C4 key.

Policy submission, approval and activation check current active employees, grades, category/grade authority, notice coverage, required role holders, action evidence and unresolved identity/status conflicts. An explicitly listed Management authority may be the root of a reporting hierarchy; other active employees require a valid line manager. Missing reporting-line sheets do not prevent drafting, but block completed-policy submission where required manager assignments remain missing. Never invent a reporting line to clear a blocker.

Identity activation reserves affected HR links, sends a short-lived signed approval plan to RBAC, and applies both services' changes. A conflicting primary login is never overwritten. A corrected account can move from one reviewed company employee record to another unoccupied target; the old HR link is cleared in the same HR transaction. Removing access preserves other companies' memberships and mappings. Sessions and refresh tokens are revoked and permission caches invalidated. An uncertain result stays **Activating** with an audit entry; HR uses **Retry approved correction**. Do not edit the reserved identity or delete receipts to force completion.

## Coordinated release

1. Release the shared `@trusoft/contracts/hr-company-setup` contract first. Each service's file dependency must include that source.
2. Back up HR and RBAC databases. Deploy RBAC migration `20261016120000_hr_company_setup`, generate its Prisma client, and release its snapshot/correction tools.
3. Run `node scripts/grant-hr-company-setup.mjs` inside RBAC with its normal service environment. It adds capabilities only to existing `SEPARATION_HR`, `HR_APPROVAL_HR`, `SEPARATION_APPROVER`, and `HR_APPROVAL_MANAGEMENT` roles. It does not assign people to roles or run the full seed. HR gets read/prepare/activate; Management gets read/approve. Refresh affected sessions after the grant change.
4. Deploy the HR migration with the same name, generate its Prisma client, and release HR. Existing active policy rows are retained. All subsequent policy writes require an approved review; the old `hr_separation_configure` command explains the replacement workflow.
5. Release gateway permission mapping and frontend navigation/forms. Refresh the gateway tool manifest/cache as required by the deployment.
6. Verify the HR signing identity is configured for the existing Ed25519 service trust plane (normally `erp-hr-backend`, with its key present in RBAC's trusted registry). Standard C4 encryption, RBAC service URL, and Redis configuration must be present. No new password or private key belongs in a review record.
7. Check each company using its assigned HR and Management roles. Confirm the live worklist counts and known identity cases, then let HR supply evidence and Management decide. This release never auto-approves policies, infers identity ownership, or fabricates missing managers.

A rollback must preserve review/audit/receipt tables and identity reservations. Do not restore the direct policy-write endpoint or bypass activation guards. Reconcile any **Activating** identity item before performing a conflicting manual account change.

## Validation

- Shared contracts validate draft/submission distinctions, permitted fields, versions and canonical digests.
- HR native database tests cover real non-owner PostgreSQL RLS, independent approval, return/revision, stale sources, activation receipts, immutable history, category/cycle conflicts, policy readiness, account conflicts and recovery.
- RBAC database tests use real company RLS, signed Ed25519 plans, independent grants, conflicting targets, durable receipts, cache-failure recovery, and preservation of other companies' data.
- Browser tests use the real HR services and disposable PostgreSQL, with a controlled account-service fixture: employee setup, Management return/approval, identity correction, policy draft/approval/activation, and forbidden company/account contexts.

No production records are changed by these tests. Browser evidence is written under the frontend's ignored `tests/company-setup/output/` directory.
