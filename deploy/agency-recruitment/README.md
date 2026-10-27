# Agency recruitment rollout

Source implementation for recommendation v1.1 §6.2. Qualification and production activation are pending. The current full HR suite contains 344 Jest files; the exact required files and native/frontend gates are recorded in `../ci/agency-recruitment-suite-plan.json`.

## Behavior

An existing, authenticated company member with the `AGENCY` role registers a business name. The service takes the user identity and mailbox from verified claims; it does not create an Employee. The role receives only `hr.recruitment.read` and `hr.recruitment.create`. Agency membership is restrictive even if a token also carries an internal recruitment role.

Recruiters assign approved vacancies through **Job requisitions → Publications → Manage agency access**, and publish the `AGENCY` channel. Agencies see only currently assigned, open, published vacancies. Revocation serializes against candidate intake and invalidates unsubmitted links while access remains revoked. Reassignment restores access to still-valid links.

An agency records permission to contact a person. The service returns the same neutral receipt when a contact is suppressed, already belongs to another source, or has already applied. Mailbox links and processing consent remain candidate-owned. The first agency owner cannot be replaced. Duplicate command keys cannot resend mail; new requests within five minutes cannot issue another link. Contact requests are bounded to 30 per agency per hour using the existing Redis limiter.

**Agency submission review** lets an organization-scope recruiter accept or reject a candidate-submitted application. A reason and the observed version are mandatory. Acceptance permits screening; rejection records the canonical rejection transition in the same transaction. Agency views exclude candidate email, assessment scores, internal notes and application identifiers. General candidate, requisition and export APIs remain inaccessible to agency roles.

Candidate access exports include safe ownership records. Anonymization clears agency identifiers on retained application aggregates and removes owned drafts, submissions and command receipts. Agency-owned candidates cannot be merged through the general merge operation.

## Deployment order

1. Use the immutable agency source snapshot, fresh locked dependencies and regenerated Prisma client. Do not combine the mutable agency schema with the separately frozen native verification lane.
2. Complete migration replay, drift, all test/lint/boundary/build and browser gates in the shared Kubernetes qualification environment. Native tests require isolated loopback PostgreSQL and Redis and must not deliver external mail.
3. Deploy the contracts package and gateway catalogue containing all 271 recruitment/onboarding tools, then the HR migration `20261026093000_agency_recruitment` and compatible HR/frontend builds. Deploy the reviewed RBAC recruitment seed with the explicit `AGENCY` read/create grants.
4. Verify real company membership and mailbox claims. Recruitment staff assign only existing, approved agency accounts. No user accounts, Employee records or vacancy assignments are pre-created by this feature.
5. Enable `HR_RECRUITMENT_AGENCY=true` after qualification. `HR_RECRUITMENT_PUBLIC_PORTAL` and the company's established candidate-message transport must also be available. Confirm agency denial on internal reads/export, company isolation, the private candidate consent flow and recruiter acceptance before opening production use.

Rollback disables `HR_RECRUITMENT_AGENCY` and restores the prior compatible application build while retaining schema and ownership history. Do not drop populated agency tables or revert the source guards: applications already linked to an agency must retain their provenance and acceptance gate.

The LibreSign company installations and DAM backups are independent of this feature. Do not resend the three previously authorized production signing invitations during agency qualification.
