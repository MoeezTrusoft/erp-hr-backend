# Employee codes and separation implementation

Local implementation and validation record, 15 October 2026. Changes are uncommitted and have not been deployed. Existing task-assessment work in these checkouts has been preserved.

## Confirmed approval policy

| Stage | Permitted review outcome | Next owner |
| --- | --- | --- |
| Employee initiator | Submit or resubmit | Current direct line manager |
| Line manager | Recommend approval or rejection | HR |
| Line manager | Revert with reason | Employee initiator |
| HR | Verify, including resolution of a Management return | Management |
| HR | Revert with reason | Employee initiator |
| Management | Approve or reject | Final decision / approved workstreams |
| Management | Revert with reason | HR |

This routing is enforced in the separation services, REST endpoints, MCP commands and forms. Management's return clears the current HR verification, retains the manager recommendation, and permits HR to verify again or return the request to the initiator. A return to the initiator restores DRAFT and invalidates subsequent reviews. Only the original initiator can edit or resubmit. Reasons, actors, versions and prior review findings are retained in immutable transition history; HR findings are visible only to HR and the configured Management authority.

The shared `@trusoft/contracts/hr-approval-rules` module records the same policy for other HR domains. The subsequent alignment change implements the common approval chain for 22 request types, including the older leave, overtime, claims, loans, timesheet, shift-swap, recruitment, goals and payroll paths. See [HR-APPROVAL-IMPLEMENTATION.txt](HR-APPROVAL-IMPLEMENTATION.txt) for the current coverage, specialist execution gates, tests and rollout requirements. Practical assessment review and acknowledgment remain prerequisites to business approval of release.

Separation retains the attachment's additional, explicit Management deferral: a dated deferral automatically returns to manager review on that date. Recommendation of rejection is advisory; only Management makes the separation rejection decision. Policy-controlled post-approval withdrawal and notice changes also retain the attachment's specific authority rules.

## Implemented behavior

### Employee identity

- Server allocation uses explicit MANAGEMENT / EMPLOYEE / INTERNEE categories, separate from employment type and assessment category. Prefixes are MGMT / EMP / INTR. Default separator is `-`, default padding is four digits; both format settings are company-scoped.
- Allocation holds a PostgreSQL transaction advisory lock per company and prefix, advances a persistent sequence, and respects all retained codes and permanent reservations. Deleted or retired codes cannot be recycled.
- Creation, import, offer acceptance and seed paths allocate before insert. Database triggers and final constraints enforce company, code, canonical uppercase text and uniqueness, including punctuation-collision protection. Leading zeros remain significant.
- Direct edits cannot change category or code. Approved category conversion issues a **new code with a permanent alias**, effective date, reason and independent approval. Current projections and open work are re-keyed; frozen assessment evidence, appraisal inputs, documents and transition history retain their original codes.
- The report-first backfill sorts by hire date, then joining date and row reference. It never derives identities or categories from names. Unknown categories and duplicate/noncanonical codes require explicit resolution. Apply runs are idempotent and serialized per company.
- Code conversion also updates current development adapter deduplication keys and active-profile references, so the next assessment does not create duplicate development actions under a new code.

### Separation lifecycle

All eight requested separation types are represented. Company policy defines their permitted initiators, evidence requirements and notice treatment. Category/grade authority is snapshotted at initiation; direct-manager authorization uses the current reporting line. Self-approval and approval of a superior in the approver's reporting chain are prohibited.

Approval locks the last working time, generates tracked workstreams and approved-template documents, starts notice tracking, and queues source/integration deliveries. Workstreams include replacement plans and sessions, receiver acknowledgments and manager readiness; knowledge transfer with leaver and receiver acknowledgments; asset return/write-off/recovery; system/VPN/building access confirmation; departmental clearance; HR-only exit interview; and payroll settlement preparation and receipt.

Every command has strict shared schemas, company/employee-code scope, role checks, optimistic versions and a request idempotency key. Stale writes return 409; unauthorized operations return 403 or conceal existence with 404. Changes and events are transactional. Replays cannot repeat business effects.

Notice uses company calendar dates. Buyout, early release and garden leave require independent decisions. Settlement uses safe integer minor-unit arithmetic and verified payroll/incentive snapshots. A digest of source, notice, asset and clearance versions prevents handing off an obsolete calculation. Notice, financial inputs and clearances are locked after payroll handoff. Exit completion requires the last working time to have arrived, handover and all clearances complete, an interview, access confirmations and a payroll receipt.

The browser provides My Separation, manager and Management queues, HR dashboard, workstream actions, employee-profile access, policy configuration and employee-code administration. Returned drafts retain existing fields and support multiple document references. Historical self-service and HR queries resolve approved code aliases, and a converted initiator retains edit authority on open drafts. Employee identifiers in the new business contracts are codes, not HR row IDs or RBAC account IDs.

### Automation and consumers

- The HR worker handles due category conversions, deferred reviews, access-due events, capability expiry, reminders and retried deliveries. Delivery claims are versioned; a late worker cannot overwrite a newer delivery result. Manual payroll receipt acknowledgment also completes the corresponding delivery without sending the settlement again.
- Communication receives its existing shared notification contract, stable deduplication keys and minimal event references. Management authorities are included when their decision is due. Recipient work email is resolved internally.
- PM clips availability and allocations at the last working time, invalidates affected reservations and unassigns unfinished work when departure is due. Completed work remains attributed. Proposed replacement references enter the planning audit; reassignment requires the existing K/S/V eligibility and capacity checks, rather than silently assigning an unqualified replacement.
- RBAC resolves a verified company/code/account mapping, removes only the departing company's memberships and roles, closes sessions and refresh tokens, and invalidates caches. Global account locking occurs only when no other-company membership remains. The inbox is acknowledged after cache cleanup, so retries remain safe. A later separation after rehire can revoke access again.

## Interfaces

All entries below use POST `/api/hr/separations/<route>` with identical REST/MCP input and output schemas. GET `/api/hr/separations/list` provides the list read model. Company context comes from the verified session, never the request body.

| MCP tool | Route |
| --- | --- |
| `hr_employee_code_status` | `code-status` |
| `hr_employee_code_configure` | `code-format` |
| `hr_employee_category_convert` | `category-conversions` |
| `hr_separation_configure` | `configure` |
| `hr_separation_list` | `list` |
| `hr_separation_create` | `create` |
| `hr_separation_edit` | `edit` |
| `hr_separation_revert` | `revert` |
| `hr_separation_action` | `action` |
| `hr_separation_manager_recommend` | `manager-recommendation` |
| `hr_separation_hr_verify` | `hr-verification` |
| `hr_separation_decide` | `decision` |
| `hr_separation_notice` | `notice` |
| `hr_separation_replacement` | `replacement` |
| `hr_separation_kt` | `knowledge-transfer` |
| `hr_separation_asset` | `asset` |
| `hr_separation_access` | `access` |
| `hr_separation_clearance` | `clearance` |
| `hr_separation_interview` | `interview` |
| `hr_separation_settlement` | `settlement` |
| `hr_separation_source_sync` | `source-snapshot` |

Outbox events: `hr.employee.code_changed.v1`, `hr.employee.separated.v1`, and `hr.separation.{submitted,approved,deferred,rejected,withdrawn,notice_started,clearance_completed,exit_completed,cancelled,updated,access_due,settlement_ready,clawback_requested,notification_requested,reverted}.v1`. Payloads carry codes, references, state, version and effective time; they do not carry document or interview contents. `notification_requested` is reserved in the event registry; actual notification delivery uses the transactional EmploymentDelivery queue.

Permissions: `hr.employee_code.manage`; `hr.separation.access`, `.self`, `.manager`, `.read`, `.manage`, `.verify`, `.approve`, `.task`, `.clear`, `.settle`, `.integrate`. Service checks further constrain direct reports, matrix authorities, assigned owners and departmental signers; having a route permission alone does not grant those actions.

## Files and migrations

The exact file plan is in `C:/Multistation Pro/hr-separation-implementation-plan.txt`. Main implementation groups:

| Checkout | Added or revised files |
| --- | --- |
| HR | `prisma/schema.prisma`; the two migrations below; `src/services/employee-code.service.js`; `src/services/separation/{base,rules,service,read,workstreams,integrations,automation}.js`; separation controller, routes and MCP tools; app/server registration, RLS and route authorization; existing employee, offer, import, assessment identity/planning adapters; backfill/seed scripts; `tests/separation/*`; relevant employee compatibility fixtures; Jest and database CI configuration |
| Contracts | `src/employment.js`, `employment-rules.js`, `hr-approval-rules.js`, `events/employment.js`; root and event exports; package exports/test command; employment tests and expanded-registry smoke test; Vitest/native runner routing |
| Frontend | HR separation client/hooks/manifest; Separation screen, forms and styles; employee profile/create form/schema; routes/sidebar; global MCP registry and permission canonicalization; package/lockfile; separation browser harness; shared-contract checkout and browser CI steps |
| PM | Separation fields and migration; `src/services/separationEvents.js`; existing assessment inbox/planning integration; real PostgreSQL separation tests |
| RBAC | Employee-code mapping and access projection schema/migration; permission catalog/installer; mapping backfill; lifecycle consumer and `src/services/separation-events.js`; RLS registration; consumer tests |
| Gateway | MCP permission precheck and canonicalization; separation permission tests |

New migrations:

1. HR `20261015100000_employee_codes_and_separation`: additive categories, identity ledgers, separation/workstream/delivery tables, tenant RLS and identity/history guards.
2. HR `20261015110000_employee_code_constraints`: refuses unresolved company/code problems, then applies non-null, unique and punctuation-collision constraints and reserves legacy codes.
3. PM `20261015100000_employee_separation`: departure projection fields, including event ordering and one-time processing markers.
4. RBAC `20261015100000_employee_separation`: code mapping, access projection and forced service-only RLS using `app.company_bypass`.

These depend on the preceding task-assessment migrations already present in the branch. No existing columns are dropped or renamed.

## Configuration and rollout

Publish company code format, explicit employee categories and reporting lines, grade notice days or employee `contractNoticeDays`, all eight type policies, category/grade authority, HR/IT/payroll owners, clearing departments/signers, four approved document templates, currency/minor units, settlement options, timezone and reminder lead days. Do not invent statutory notice lengths or financial rules.

Apply the additive HR migration first in a controlled migration release. Run `node scripts/employee-code-backfill.mjs --company <UUID>` in report mode. Optional `--category-map <file>` contains explicitly verified `{companyUuid, legacyRowId, category}` entries for legacy records. Review the report before `--apply`. Resolve duplicates, missing companies and noncanonical identities without silent coercion. Apply the final constraint migration only when every company's report is clear of code blockers. A normal deploy that attempts both migrations without that intervening data work will intentionally stop on unresolved records.

Install the permission catalog and backfill RBAC company/code mappings using `scripts/backfill-employee-code-mappings.mjs` in report mode before its apply mode. It matches company, linked user and HR technical row reference; names are never used to guess identity.

Publish coordinated contracts before consumer builds. The CI workflows accept `ASSESSMENT_CONTRACTS_REF` and require `CONTRACTS_DEPLOY_KEY` for the private checkout. They have been revised locally; no hosted CI run is claimed here.

Enable `HR_SEPARATION_WORKER_ENABLED=true` only after policies, permissions, mappings and integration endpoints are ready. Registered integrations require both `HR_SEPARATION_<KIND>_URL` and `HR_SEPARATION_<KIND>_TOKEN` for `ASSETS`, `PAYROLL`, `INCENTIVES`, `PAYROLL_HANDOFF`, and `NOTIFICATION`. Endpoints must be HTTPS; redirects and mismatched company/code responses are rejected. `HR_SEPARATION_NOTIFICATION_TEMPLATE` selects the Communication template. Endpoints must honor delivery idempotency keys and return verified versioned snapshots or receipt references.

## Validation and remaining operational limits

- HR Jest: 268 suites and 3,214 tests passed; two suites / 11 tests remain existing skips. ESLint and dependency boundary checks passed.
- Native HR PostgreSQL assessment/separation tests: 53 passed, including actual additive/constraint migration and backfill reruns, tenant isolation, concurrent allocation, conversion, historical reads through code aliases, resignation, termination, reverts, payroll retry and replay.
- Shared contracts: 494 Vitest tests and 31 native Node tests passed.
- PM: 12 real database tests passed, including capacity retained before the last working time and due-event idempotency.
- RBAC: nine focused consumer/lifecycle tests passed. The actual new migration and forced-RLS service GUC were also exercised in an isolated transaction.
- Browser separation harness: seven tests passed, including all three revert destinations, draft editing, code-only inputs, conflicts and mobile layout. This is local fixture-backed testing, not a live ERP browser certification.
- Frontend production build passed. Focused auth/manifest/employee-form validation passed 82 tests. An earlier full unit run passed 3,023 test cases but also collected the Playwright file incorrectly; that file is now explicitly routed to its browser runner. A subsequent broad rerun was stopped in favor of the affected suites. A final all-suite frontend CI pass is not claimed.
- Frontend lint: the full scan had no errors; all 15 newly introduced warning fingerprints were corrected, and all 38 changed JavaScript files were rechecked against the complete 1,658-file snapshot with zero errors and zero new warnings. Dependency boundaries have zero errors and 34 existing warnings. Affected-file formatting and all three workflow YAML files were checked. The frozen lockfile was validated with the repository's pinned pnpm 10.28.2.
- Gateway: two focused permission tests passed.

The shell `gate:p1` wrappers require Bash/npm and shared workspace scripts absent from this Windows environment. Equivalent available checks were invoked directly; unavailable wrapper/visual-baseline checks must not be reported as completed.

Before production acceptance, configure and exercise the real asset, incentive, payroll and Communication adapters. Current tests validate the protocol and retry behavior with fictional responses; they do not establish that every remote service already exposes the registered endpoints. Document output currently stores approved-template text against the employee separation file, not a DAM-hosted signed PDF.

Product-policy items still requiring explicit treatment are a deceased/unavailable employee's KT acknowledgment (the implementation does not fabricate that acknowledgment) and recovery after a new asset is discovered once clearance is frozen. These are limits on claiming universal end-to-end coverage. Broader legacy HR approval alignment is now recorded in HR-APPROVAL-IMPLEMENTATION.txt. Category conversion follows the attachment's explicit **new code plus alias** decision; retaining the original code was not implemented as an alternative.

Handoff: confirmed return policy is implemented and tested in Separation.
Handoff: employee-code allocation and separation changes span HR, contracts, frontend, PM, RBAC and gateway.
Handoff: use staged data remediation before the final HR constraints and enable automation only after integration setup.
Handoff: preserve existing uncommitted assessment work when preparing coordinated commits.
Handoff: no merge, deployment, production data mutation or hosted-CI success is asserted by this record.
