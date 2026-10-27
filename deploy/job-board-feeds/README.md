## Company settings page

HR administrators and HR heads can use Recruitment > Job-board Settings at /hr/job-board-settings for the currently selected company. Configure the public careers origin, employer/source/publisher identities, Indeed account email, LinkedIn numeric company ID and posting-account email, and exact vacancy location mappings. Provider passwords and SMTP credentials are not requested or stored here.

The page uses the existing hr_tenant_recruitment_settings_get/set tools, RecruitmentSettings and immutable RecruitmentPolicyVersion records. Saving requires the displayed expectedVersion, an actual linked company employee, recruitment.update, an HR administrator/head role and a change reason. Adding existing public roles to Indeed also requires recruitment.create. The company comes from the verified session, never a form input. No new permission, tool name, event name or database migration is introduced.

The optional policy.jobBoards object overrides the legacy deployment JSON for that company. Explicit null or disabled providers do not fall back to deployment settings. Older policy clients that omit jobBoards preserve an existing setting. Drafts can be saved with providers disabled. Activation validates the approved HR_PORTAL_HOSTS mapping and signing-key readiness. The global deployment flag and public-portal flag still gate exposure; saving a configuration does not override them.

The settings mutation and publication share the company policy advisory lock, followed by ordered requisition locks. Enabling Indeed validates all eligible public vacancies and creates missing managed Indeed placements in the same transaction as policy history and its existing event. Invalid content, missing location mappings, legacy identities, permission or later policy validation failures roll back the whole change. New provider exposure also uses the existing hiring-freeze guard with the same transaction, including reactivation of an already managed placement. LinkedIn remains per-vacancy opt-in. Saving from this page explicitly reconciles the inventory, including after a deployment flag is re-enabled.

Disabled company providers return empty XML inventories while the public portal and job-board deployment are enabled. Source attribution and apply redirects cease using that provider. Removal from a provider's index depends on its next successful refresh. The page displays/copies the approved public feed URLs and readiness, without signing keys or other-company hosts. Administrators must submit those URLs through each provider's onboarding process; this page does not claim provider ingestion acceptance.

Qualification: deploy/ci/job-board-settings-suite-plan.json. This page and service change are source-prepared, not yet Kubernetes-qualified or deployed. Frozen native-only qualification inputs remain separate.

Provider references: https://docs.indeed.com/job-sync-xml/xml-feed and https://learn.microsoft.com/en-us/linkedin/talent/job-postings/xml-feeds-development-guide?view=li-lts-2026-04 .

# Company job-board feeds

State: source implementation prepared; Kubernetes qualification, company identity confirmation, provider onboarding and production activation are pending.

The attachment's section 6.2 is implemented through tenant-bound XML feeds, stable JobPosting.channelRef values, direct careers landing URLs, an optional apply redirect, and immutable first-touch application attribution. These additions are separate from the frozen native-verification source lane.

## Configuration and activation

Keep HR_RECRUITMENT_JOB_BOARDS_ENABLED=false until the complete current-source gate passes. The existing HR_RECRUITMENT_PUBLIC_PORTAL flag must also be enabled. Supply HR_RECRUITMENT_JOB_BOARDS as a company-UUID-keyed JSON object. Each opted-in company needs:

- companyName, sourceName, publisher and publisherUrl: approved public employer/group/ATS identities.
- careersOrigin: approved HTTPS origin, without credentials, port, path, query or fragment; it must have exactly one matching HR_PORTAL_HOSTS binding to this company.
- locations: exact published JobRequisition.location labels mapped to approved city, state/province and two-letter country codes. Never infer locations from ambiguous free text.
- INDEED: enabled=true and the email belonging to the company's Indeed account.
- LINKEDIN: enabled=true, the posting owner's accountEmail and verified numeric companyId. Current provider documentation specifies an HTTPS www apply URL; this adapter enforces that host format when LinkedIn is configured.
- HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY: a dedicated 32-byte random key encoded as canonical base64, supplied through a protected deployment secret. Do not reuse mailbox passwords or place real keys in this repository.

Omit companies and providers that have not opted in. No production company or account is inferred from the recruitment SMTP configuration. Malformed configuration is a 503; an unconfigured company/provider is a 404. Default configuration advertises nothing.

While the endpoint is still inaccessible to provider crawlers, reconcile every existing public role with the normal authorized publication action. A legacy active board row with an arbitrary channelRef must first be closed, with a reason, before managed publication. Record the operator and retain history. Do not silently rewrite a provider ID already ingested; reconcile with the provider before migration. Once valid managed rows exist for the complete public inventory, enable crawling. The feed refuses an incomplete Indeed inventory with 503 rather than returning a partial 200 response.

Publishing CAREER_SITE for an Indeed-opted-in employer automatically publishes INDEED in the same transaction. LinkedIn is selected per role through the existing channel publication action. Only jobs also public on CAREER_SITE are eligible. An active Indeed channel cannot be individually closed while its public posting is active; close the public posting first or disable employer opt-in. Requisition closure, expiry and public-posting removal exclude the role on the next request without a nightly feed cache.

## Endpoints and provenance

- GET /public/job-boards/indeed.xml
- GET /public/job-boards/linkedin.xml
- GET /public/job-boards/:channel/jobs/:id/apply

The existing trusted host-to-company resolver, Redis rate limiter and no-store response policy protect these routes. Feed generation uses a repeatable database snapshot, a 10,000-row ceiling and a 16 MiB output budget; overflow refuses the entire response. There is no pagination or silent truncation.

Provider feeds contain direct HTTPS careers detail URLs, with source and signed sourceReceipt parameters. The optional apply endpoint redirects only to the approved company origin and an eligible published job. The feed itself uses no redirect because current LinkedIn guidance forbids redirecting job URLs.

The reference binds the company, requisition, channel, active posting row and stable external ID. It contains no candidate identity and grants no candidate access. A shared public source link proves which link was used; it is not proof that the provider authenticated the applicant or that the browser visited the provider. Invalid, cross-company, altered or closed-posting references fall back to PORTAL attribution. Candidates can still apply through the public site.

The careers start form sends the reference to the backend. Creation validates it and freezes ApplicationDraft.source. Recovery and draft edits preserve the first source. Final Application.source is taken from that owned draft; direct intake validates its own reference. Existing duplicate applications retain their original source. No raw source label from a request is trusted.

## Content and provider review

Descriptions use exactly the public careers summary and the responsibilities, requirements, benefits and hiring-process sections in their displayed order. Private budget, scoring, approval and candidate information are excluded. XML CDATA boundaries and disallowed XML characters are handled explicitly. Authored HTML is treated as text; generated description markup uses supported paragraphs, strong text and lists.

The current careers UI does not display the grade salary range. The feed consequently does not invent pay periods from grade data. Any later public salary/address/education display must be added to the feed in the same release.

Provider rules checked on 2026-10-23:
- https://docs.indeed.com/job-sync-xml/xml-feed — complete employer public inventory, account identity and job-description URL.
- https://learn.microsoft.com/en-us/linkedin/talent/job-postings/xml-feeds-development-guide?view=li-lts-2026-04 — company/account identities, <=40-character job IDs, >=100-character descriptions and direct application URLs.

Provider enrollment, accepted ingestion and actual listing visibility remain external acceptance requirements. Returning valid XML does not establish any of those outcomes.

## Required qualification

Use deploy/ci/job-board-feeds-suite-plan.json after assembling agency v4, shared UI v1/v2, and this source overlay. The native-verification-only adapter must not consume this changed tree.

Fresh dependencies and Prisma generation, full HR Jest discovery/regression, native database/HTTP checks, frontend lint/build/browser journeys and deployment smoke checks must all run in Kubernetes after the shared runtime hold is released. The prepared tests have not been run. No additional live email is authorized or needed for these fixture tests.

Rollback: disable job-board feeds and withdraw the feed with each provider. Restore application code only after checking persisted INDEED/LINKEDIN draft compatibility. This source change introduces no migration; frozen source attribution survives through the existing Application/ApplicationDraft source fields and database immutability guard.
