# Recruitment Rollout Runbook (Phase 15)

Operational guide for rolling out the Recruitment workflow-hardening branch
(`feature/recruitment-workflow-hardening`). Companion to
`hr-data/recruitment/implementation-plan.md` (Phases 2.2–15) and
`hr-data/recruitment/decision-record.md`.

---

## 1. Feature flags

Flags are environment variables on **erp-hr-backend**, read at call time (a
restart applies them). Definition table: `src/lib/recruitmentFlags.js`.
Unknown values fall back to the documented default — a typo cannot take a
feature down. Inspect the live state:

```bash
curl -s http://<hr-host>/metrics | grep hr_recruitment   # counters
node -e "import('./src/lib/recruitmentFlags.js').then(m=>console.table(m.recruitmentFlagSnapshot()))"
```

| Flag | Default | Controls | Off means |
|---|---|---|---|
| `HR_RECRUITMENT_WORKFLOW_ENFORCEMENT` | **on** | Requisition submission gates (mandatory fields, approval chain, §2) | Legacy permissive submission. **Do not turn off in prod** — it gates data quality. |
| `HR_RECRUITMENT_OFFER_HANDOFF` | **on** | Offer approval/acceptance + hiring handoff pipeline | Offers API returns errors; payroll provisioning of hires stops. |
| `HR_RECRUITMENT_PUBLIC_PORTAL` | **on** | Public portal intake + listings (§3) | Portal answers the same 404 as an unknown job (§3.4 no-oracle rule). |
| `HR_RECRUITMENT_RETENTION_AUTOMATION` | **off** | Retention **apply** mode (destructive path) | `applyRetention(dryRun:false)` returns a refused dry-run with `reason:"flag-disabled"`. Dry-run always available. |
| `HR_RECRUITMENT_CANONICAL_ANALYTICS` | **on** | `canonicalMetrics` block in analytics payloads | Block reports `unavailable, reason:"flag-disabled"`; legacy fields unaffected. |
| `HR_RECRUITMENT_AI` | **off** | AI advisory features (resume parse via plane, match summary, §7) | Parse → typed 503 `HR-RECRUITMENT-AI-DISABLED`; match → `ai.unavailable`. Recruitment works fully without it (§7.1b). |

Rollout order (per plan §15): security → `workflow` → `offerHandoff` →
`portal` → `analytics` → `ai` → `retention` (last, per-tenant, after the
data-policy owner signs off — §8).

## 2. Rollout metrics

All on `/metrics` (attached in `app.js`, defined in `src/lib/recruitmentOpsMetrics.js`).
Labels are allowlisted; no PII in any label.

| Metric | Labels | Watch for |
|---|---|---|
| `hr_recruitment_transition_failures_total` | `code` (TRANSITION-INVALID, SCREENING-ADVANCE-REQUIRED, INTERVIEW-REQUIRED, INTERVIEW-OUTCOME-REQUIRED, ACCEPTED-OFFER-REQUIRED, REQUISITION-NOT-ACCEPTING, STAGE-INVALID, REASON-REQUIRED) | Spikes after a workflow-enforcement change; a rise in SCREENING-ADVANCE-REQUIRED means recruiters are skipping screening. |
| `hr_recruitment_handoffs_total` | `outcome` (completed/failed) | Any `failed` is a payroll-provisioning incident — check the handoff row's `lastError` and retry (idempotent by offerId). |
| `hr_recruitment_resume_parses_total` | `kind`, `outcome` (ok, cache-hit, failed, exhausted, throttled, flag-disabled) | `exhausted` growth = a permanently failing resume format; `throttled` = transient plane/provider trouble. |
| `hr_recruitment_notifications_total` | `event`, `outcome` (enqueued, dropped-error) | `dropped-error` growth = outbox/tenant-context faults; missing tenant events fail closed. |
| `hr_recruitment_denials_total` | `code` (HR-0201…HR-0205) | A rise in HR-0204 after a permissions change is expected; HR-0201/0202 indicate routing/actor bugs. |
| `hr_recruitment_exports_total` | `format`, `outcome` (ok, denied, failed) | `failed` = export pipeline trouble; `denied` is recorded only if future middleware changes add it. |
| `hr_recruitment_retention_runs_total` | `outcome` (dry-run, applied, refused-flag, failed) | `applied` should only move while `HR_RECRUITMENT_RETENTION_AUTOMATION=on` — if it moves while off, escalate. |

Suggested alerts: any `handoffs_total{outcome="failed"}` increase (page);
`transition_failures_total` rate > baseline ×3 for 15 min (ticket);
`notifications_total{outcome="dropped-error"}` rate > 0 for 30 min (ticket).

## 3. Migrations

All Recruitment migrations are **additive** (new tables/columns; no destructive
edits). Conventions: nullable tenant + staged `NOT VALID` checks + own RLS
policy (F-DB-05). Chain verified from zero by `F-DB-01`.

```bash
# dev/staging first (GO per decision-record §8; production needs its own approval)
npx prisma migrate deploy      # apply
npx prisma generate            # refresh client
npm test -- tests/integration/F-DB-01.migration-chain.db.test.js   # replay-from-zero gate
npm test -- tests/unit/F-DB-03-05.schema-integrity.test.js         # drift + RLS conventions
```

**Never** edit an applied migration; if the live DB drifted from the chain,
fix forward with a new migration (the F-DB-01 gate will hold you honest).

## 4. Deploy

1. Apply migrations (above) **before** the new HR build.
2. Deploy HR with explicit, reviewed flag values. Legacy workflow, handoff, portal and canonical analytics defaults are on. New calendar, communications, LibreSign, scoring, on-site tests, evaluation forms, automatic release and onboarding automation defaults are off; keep them off until their staged checks pass. AI and retention automation also default off.
3. Smoke: `/healthz`, one requisition submit (workflow gates), one portal
   listing fetch, `/metrics` shows all seven `hr_recruitment_*` counters at 0.
4. Stage-by-stage enablement: flip one flag → smoke its surface → watch its
   counter for a day → next flag. AI last, because it needs
   `REDIS_URL` + the AI plane deployed and reachable.

## 5. Rollback

- **Feature-level (preferred, no redeploy):** flip the offending flag off,
  restart HR. Flags are read at call time; capabilities degrade without
  touching data. AI off → parses 503 cleanly; portal off → 404s; retention
  off → apply refused, dry-run intact.
- **Build-level:** redeploy the previous image. Additive migrations are
  backward-compatible with the previous build (new columns are nullable,
  new tables unused by old code) — **do not** roll migrations back.
- **Data:** no migration on this branch destroys data. The only destructive
  operation is retention apply (which is flag-gated and dry-run-first); its
  anonymization is verified one-way by design (§10) — restore from backup
  only under the data-policy owner's instruction.

## 6. Go-live checklist (production)

- [ ] Staging deployed; F-DB-01 + F-DB-03-05 green on the staging DB
- [ ] Recruitment smoke pack run on staging (submit → approve → post → apply → screen → interview → offer → accept → handoff)
- [ ] `/metrics` counters visible in Prometheus; alerts wired (§2)
- [ ] `HR_CANDIDATE_RETENTION_MODE=dry-run` confirmed (§8)
- [ ] Retention dry-run output reviewed by the data-policy owner
- [ ] DMS erasure behaviour tested on staging (resume asset deleted on anonymize)
- [ ] AI plane reachable from HR (`REDIS_URL` set; a parse smoke returns 200) **before** `HR_RECRUITMENT_AI=on`
- [ ] `HR_RECRUITMENT_RETENTION_AUTOMATION` stays **off** until per-tenant activation is approved (§8: tenant-by-tenant, never globally by surprise)
- [ ] Dedicated E2E/service account for the smoke pack — never developer production credentials (§8)

## 7. Remaining acceptance work

The implementation is not yet fully deployed or accepted against the recommendation. Keep new automation flags off until its staged verification and production rollout are approved. English and Urdu PDF samples have passed local rendering and text checks. Remaining areas include onboarding automation and document handling, internal/referral/agency flows, analytics, staged integration and the physical kiosk pilot. Do not interpret a passing test gate or LibreSign installation as approval to enable the complete recruitment rollout.

## 8. Candidate interview scheduling and reminders

Apply migrations `20261026083000_interview_slot_offers` and `20261026084000_interview_staff_notices` before deploying this version. The new table has forced company RLS, a composite application/interview foreign key, one open offer per application, and immutable approved times and panel configuration. The active MCP catalogue contains 238 operations.

With `HR_RECRUITMENT_CALENDAR_SYNC` enabled, a recruiter or the responsible hiring manager can propose three to five non-overlapping times using the existing HR calendar. The panel must have published work schedules and be free of approved leave and interview conflicts. Offering another set withdraws the previous open set. The expiry must be before the first proposed time; proposed times are limited to the next fourteen days.

The candidate chooses through their private status link. Booking rechecks identity, consent, application state and HR availability within the transaction that creates the interview, pins its assessment/form and writes the normal calendar synchronization work. Replaying the same confirmed choice returns the existing interview. Candidate calendar downloads contain a private iCalendar snapshot with a stable identifier, escaped UTF-8 text and no panel addresses or access tokens. The same snapshot is attached to candidate scheduling, rescheduling, cancellation and reminder emails when calendar synchronization is enabled. The notification hub accepts only the closed HR calendar format, encrypts it in its delivery queue, and removes it after delivery or suppression. SMTP uses an in-memory attachment; arbitrary paths, remote files, calendar alarms and recipient properties are rejected.

The `interview-reminders` BullMQ repeat job runs every minute under the existing `HR_REMINDER_JOBS_ENABLED` scheduler switch and `HR_RECRUITMENT_COMMUNICATIONS` flag. It queues one candidate reminder in the 24-hour window and one in the final hour. Retries preserve the dedupe key. A pending reschedule request pauses new reminders and cancels queued ones at delivery validation. Recruiter confirmation creates a new schedule revision, including when the original time is reconfirmed. Reminders expire before their window ends and cannot deliver for cancelled, expired, superseded or closed-application schedules. A scheduler outage skips obsolete windows rather than delivering a burst of old reminders.

Slot offers and offer-signing history are included in the supervised candidate access export. Access URLs, encrypted identities and worker credentials are excluded. Candidate erasure deletes slot offers, including their free-text location, and staff notification ledger records. The supervised export includes staff-notice kinds and timestamps without recipient user IDs; signing erasure continues through the existing provider cleanup workflow.

Staging checks: approved slot selection → candidate confirmation → one HR calendar event; stale-slot rejection; duplicate confirmation; candidate reschedule request → paused reminder → recruiter confirmation; company isolation; current consent; expired-link refusal; private calendar download; data export and erasure. Native coverage is in `interview-slots.postgres.test.mjs`, `interview-reminders.postgres.test.mjs`, `interview-calendar-file.test.mjs` and `data-export.postgres.test.mjs`. Browser journeys cover recruiter approval and candidate confirmation, download, conflict recovery and reschedule request.

The companion `interview-staff-notices` job sends in-app panel reminders in the 24-hour and one-hour windows, nudges outstanding reviewers two hours after the scheduled end, and escalates missing feedback to the requisition's assigned recruiter after 24 hours. Complete panel submissions prompt the owning hiring manager to review consolidation and decide. A recorded no-show prompts recruiter review. No human decision is made by this worker. The company-specific user UUID comes from the employee's RBAC user ID, never an employee ID cast to a user ID. Missing or inactive recipients are counted as `unroutable` and retried after staffing is corrected; no alternate recipient is guessed.

The forced-RLS `InterviewStaffNotice` ledger and HR outbox event commit together. A unique schedule revision/kind/recipient key prevents repeat sweep notifications. Reschedule requests pause these notices; terminal applications and erased candidates are excluded. Verify the notification hub has the `hr.recruitment.interview_action_due.v1` mapper and templates before activation. Tests: `interview-staff-notices.postgres.test.mjs` in HR and `interview-staff-notices.test.js` in the hub. Notifications deliberately contain only interview references and action prompts; protected scorecard content remains behind HR authorization.

Deploy the updated shared contracts and notification hub before enabling these HR workers. Staff notices include an Open interview action in the ERP notification modal; it resolves only a numeric HR interview reference and fetches the detail through the authorized `hr_interview_manage_get` query. Missing or inaccessible interviews render a retryable error.

## 9. Staff interview actions and management queries

Interview Management now reads the typed, company-scoped paginated list through the recruitment query layer. Search and status/type filters run on the server; page totals come from the response. Notification links and table actions fetch current authorized detail. Viewer timezone and location are displayed without the old New York override.

Rescheduling records a coded reason, checks the HR calendar and calls the audited confirmation endpoint. Availability excludes only an existing interview the caller can access. Approved leave and overlapping interviews remain hard blocks; non-working or unknown calendars require an explicit reason. The server rechecks under the panel lock. Confirmation of a pending request can retain the original time, clears the pending state and restores reminders; duplicate unchanged confirmations are refused. A no-show with a confirmed replacement returns to SCHEDULED.

Cancellation requires a code and notes for OTHER. Bulk cancellation retains failed entries and retries only those, without repeating successful writes. Outcome submission uses NEXT_ROUND, HOLD or REJECTED with a human rationale. Missing submitted feedback requires an explicit HR override; the server remains authoritative for scope and assessment gates. Structured evaluations open their pinned report and decision flow. Legacy feedback uses typed scores and canonical recommendation codes. The shared checkbox composes its click handler with toggling, restoring table selection while preserving row-navigation suppression.

Focused verification: reschedule-checks-final.log (46 unit tests and 14 native calendar/reminder cases), interview-browser-final.log (notification detail, reschedule conflicts/override, server paging/search, cancellation partial failures, decision codes and calendar states). Shared checkbox and notification unit tests and the final ERP production build are recorded separately in implementation-progress.json.

## 10. English and Urdu evaluation exports

The frozen evaluation PDF embeds Noto Sans and Noto Sans Arabic (SIL OFL 1.1; licenses and source digests in src/assets/fonts). bidi-js is pinned in the runtime dependency lock. Rendering uses Unicode paragraph/line ordering and Arabic shaping without reversing Arabic words before shaping; Latin references, brackets and Urdu numbers retain their reading order. Long evidence and unbroken identifiers wrap within page margins. Tagged logical text preserves searchable Unicode independently of visual glyph order. Page footers identify the application/interview and page count. This is tagged output; it has not been certified as PDF/UA.

HR_REPORT_FONT_PATH, if configured, replaces the Latin font only; the bundled Arabic font remains available. Deploy the font assets with the HR source. Existing frozen PDFs remain immutable; the new renderer applies to exports that have not already been stored.

Acceptance: evaluation-pdf.test.mjs covers run order, Urdu numeric order after shaping, missing glyphs, decoded logical ActualText and bounded multi-page layout. English (two pages) and mixed Urdu/English (three pages) synthetic samples are rendered under recruitment-implementation/visual-after. The latest PDF/native assessment gate is evaluation-pdf-final.log.

## 11. Employee-owned onboarding portal

The employee portal route and My Onboarding navigation accept hr.self.read; the HR dashboard still requires hr.onboarding.read. Deploy updated shared contracts and gateway permissions with HR and frontend. Four existing portal operations accept the self entitlement: portal_get, portal_task_complete, portal_feedback_questions and portal_feedback_submit. Task creation, editing, deletion and reminders remain HR-only. No new Employee management grants are required.

Backend ownership comes from the active employee linked to the verified user ID in the selected company, not an employeeId supplied by the client. Explicit foreign employee/checklist/task IDs are denied. Employees can complete NEW_HIRE tasks without an explicit assignee or tasks explicitly assigned to them. HR management requires both the HR role and the relevant onboarding grant. HR cannot submit experience feedback for another employee. All canonical questions are required; updates are serialized by checklist and bound to the actual new hire. Numeric MCP error statuses now use the shared normalizer, including typed AppError instances.

The portal uses typed recruitment queries and mutations, caches by company and actor, mounts HR realtime, displays actual orientation sessions and groups tasks by their stored category. Failed writes retain the previous server state and entered feedback. Task changes and feedback commit minimal ID-only events in the same transaction; feedback text is excluded from events. These portal changes do not implement the separate 30/60/90-day survey scheduler or provisioning/readiness automation.

Local acceptance: onboarding-portal-native-final.log (11 database cases), onboarding-final-gates.log (85 unit checks and four gateway cases), onboarding-ui-gates.log (eight route/contract checks), onboarding-portal-browser-final.log (three browser journeys), and visual-after/onboarding-owned-portal.png. The updated ERP build is recorded in onboarding-erp-build.log. Document upload/signing, automation and production rollout remain separate acceptance items.

## 12. Canonical recruitment reporting

Recruitment Analytics now uses the typed recruitment query layer, canonical versioned KPIs, actual monthly accepted-offer trends, filter-preserving evidence and CSV/PDF exports. No illustrative spend or invented trend/status is displayed. Desktop and mobile views use shared controls; chart containers resize through ResizeObserver and evidence tables scroll horizontally rather than compressing dates. Cache keys include the selected company and current actor.

Every report, drill-down and export resolves the active employee from the verified account, then permits an organisation recruiter or a manager's owned requisitions. Interviewers, finance-only roles and unknown roles cannot read reporting cohorts. Requisition, department, application-date, stage and source filters run in PostgreSQL. Each request reads its inputs under RepeatableRead; a later request can reflect intervening changes and returns its generation timestamp. A 50,000-row cohort limit refuses oversized reports rather than silently truncating metrics. Drill-downs disclose their separate 500-row output limit.

The canonical source-effectiveness function no longer conflicts with the legacy local array name. Errors now propagate instead of silently turning a broken canonical block into unavailable data. Fill evidence includes approval, accepted-offer fill dates, required openings and contributing application IDs. Filtered time-to-fill uses offers in the selected application cohort, so excluded offers cannot silently complete an opening. SLA aging excludes terminal applications. Planned-start lead time measures accepted offer to planned start, explicitly distinct from attendance-confirmed joining. Recruiter workload includes open requisitions and active applications in the same scope.

Company cost configuration accepts actual non-negative amounts to four decimal places, serializes concurrent updates, and requires an authorised human recruiter for changes. All-time company spend is shown only on an unfiltered organisation report; manager and filtered cohorts return unavailable because no allocation model exists. Export requires hr.recruitment.export at the gateway and HR service. Deploy the changed shared catalogue with HR and frontend; the number of tools remains 238.

Acceptance: analytics-native-final.log covers nine reporting cases plus the eleven owned-portal cases, analytics-unit.log covers reporting and MCP/catalogue gates, analytics-ui-unit-final.log covers five contract/filter/cache checks, and analytics-browser-final.log covers canonical display, evidence failure recovery, same-filter export, cost retries and mobile chart resize. The final full HR regression and ERP build are recorded in implementation-progress.json. Tenant threshold alerts and attendance-confirmed time-to-start remain outstanding; these changes do not activate reporting or automation in production.

## 13. Onboarding milestones and cohort dashboard (local verification)

The hourly onboarding-milestones job uses HR_ONBOARDING_AUTOMATION. It creates due DAY_30, DAY_60 and DAY_90 survey rows, routes an in-app reminder to the active linked new hire, and alerts the recruiter and reporting/requesting manager about incomplete pre-joining or provisioning tasks from two days before start. Migration 20261026085000 adds a forced-RLS notice ledger; the checklist/start/kind/recipient uniqueness key and transactional outbox prevent duplicate notifications under concurrent sweeps. Missing or inactive recipient bindings are counted as unroutable. No live employee notifications have been sent by this local verification.

The portal exposes exact UTC due instants, rejects future/foreign/impersonated submissions, requires the canonical questionnaire, and preserves identical submitted timestamps on retries. The legacy survey adapter uses the same service. The legacy general-feedback adapter writes canonical owned portal feedback separately and cannot overwrite DAY_30 responses. Survey answers are excluded from domain events.

The dashboard and exports resolve the active actor from the verified account. HR/recruiters see their company and managers only their direct reports. Pagination, sorting and filters execute in PostgreSQL; summaries and start-month cohort rates use the same repeatable-read snapshot. Checklist completion means stored COMPLETED status. Survey denominators include only milestones already due; not-yet-due rates are null. Exports require hr.onboarding.export and refuse more than 10,000 rows. New-hire creation validates the company employee, active template and buddy, serializes duplicate employee/start-date attempts and writes tasks, buddy and minimal event atomically. The form retains one request key during retry.

Verification: full HR 341 suites / 4,258 tests, lint and dependency boundaries PASS; 13 milestone/dashboard native cases plus 11 existing owned-portal cases PASS; four dashboard browser checks and six portal/milestone browser checks PASS; 20 frontend contract/navigation checks and 18 shared-table checks PASS; notification hub 135 tests plus lint/boundaries PASS; gateway 4 checks PASS. Production ERP build PASS (4,979 modules); the combined native onboarding run passed 24 checks. Evidence is recorded in implementation-progress.json.

Still required for full attachment compliance: onboarding detail/schedule/document surfaces, IT/equipment request consumers, orientation calendar writes and verified document signing, plus staged deployment and acceptance. Keep recruitment rollout flags disabled until the remaining gates are complete.

## 14. New-hire detail and management record access

The detail screen resolves the explicit checklist ID, uses typed query hooks and HR realtime invalidation, and loads stored tasks, sessions, documents, activity and general/milestone feedback. Manager reads are restricted to checklists for their actual linked reports. HR writes require a verified active employee, the matching company and method grant. Task creation validates stage/category, dates and company assignees. Readiness patches merge under a parent lock; notes retain the verified actor and stable request key.

The checklist reminder now queues one standard in-app notification for the new hire's linked active ERP account. The response reports queued, not delivered. Parent locking plus a persisted request key prevents duplicates on retries. No arbitrary mailbox or private message content crosses the event boundary. Notification Hub renders hr.onboarding.reminder_requested.v1 and the inbox links to the owned portal; readiness alerts link to the scoped management detail. This adds no live email tests beyond the three already authorized and delivered.

Native database checks: 30 passed (onboarding-detail-native-final.log). Browser detail journey: 5 checks passed (onboarding-detail-browser.log); desktop and mobile screenshots are in visual-after/onboarding-detail*.png. Full HR and frontend regression results are recorded in implementation-progress.json once complete.

Remaining: session template/calendar automation, IT/equipment provisioning consumer, employee DAM uploads and provider-verified onboarding-document signatures. Existing signedAt values alone are labelled signature verification required. These are release blockers; the new source remains undeployed and automation flags remain off in production.

## 15. Legacy onboarding transport consolidation

Core HTTP/MCP controllers now propagate the verified request tenant last and use normalized error envelopes. The old checklist create materializes the company template through addNewHire; list, detail, employee, survey and management resources share actual manager scope. Closed update fields prevent company changes, reparenting and arbitrary completion timestamps. Tasks delegate to the canonical portal service, and buddy assignments require an active employee in the same company. Completion refuses unfinished tasks and unverified required signatures. The old document-sign endpoint cannot write signedAt manually. Company DAM attachments require a CLEAN scan, matching company and allowed PDF/DOCX type.

Legacy inconsistent buddy/manager/assignee links are filtered by company; feedback with a mismatched owner is concealed and cannot be overwritten by the new hire. Native regression: 36 cases pass (onboarding-core-final.log). Focused compatibility/inventory: 196 tests in four suites pass (onboarding-core-unit.log). The complete HR checkpoint before the final core consolidation passed 341 suites / 4,259 tests; final aggregate rerun remains a release gate. Production ERP build passed at 4,998 modules.

## 16. Onboarding provisioning queue checkpoint

The working destination is the HR provisioning queue, assigned to IT staff. Migration 20261026085100 adds a forced-RLS request ledger linked by company and task. The handoff, manual new-hire and task mutations project account/equipment work inside the source transaction; a five-minute scheduler repairs missed requests when HR_ONBOARDING_AUTOMATION is enabled. Employee-owned access-confirmation tasks stay in self service.

The two new tools are hr_onboarding_provisioning_requests_list and hr_onboarding_provisioning_fulfill (241 operations total). IT, IT_ADMIN and IT_MANAGER roles receive only hr.onboarding_provisioning read/update grants, serialized using the canonical resource hr:onboarding_provisioning. Assigned IT staff see their requests; HR sees company work; managers see their actual reports. Gateway tests confirm these grants cannot read general onboarding detail or reassign tasks.

Fulfillment requires a reference, current revision and verified employee. Pending requests cannot be marked complete through ordinary checklist controls; fulfillment cannot be reopened, reassigned or deleted. Create a new task for additional work. Concurrent retries preserve one completion and event. Changes to pending requests invalidate stale fulfillment forms; UI assignments submit the displayed request revision. Notifications contain routing IDs, never task descriptions or fulfillment references. No passwords belong in a reference.

The typed queue UI provides server paging and filters, retained save errors, assignment, fulfillment and complete reference inspection. HR dashboard/detail links and in-app notifications open the queue. Mobile columns remain readable through horizontal scrolling. Six browser journeys passed; screenshots are visual-after/onboarding-provisioning.png and onboarding-provisioning-mobile.png. Native onboarding coverage: 43 passed; focused HR tests: 124 passed; FE contracts/routes: 25 passed; Hub routing/render/dedupe: 4 passed; Gateway: 5 passed. Schema validation/deploy/diff passed with 187 migrations present; full regression and final build are running separately. Source is not deployed and production flags remain off.

Provisioning full HR checkpoint: all 341 suites / 4,259 tests passed, lint passed, and dependency boundaries reported no violations (hr-full-onboarding-provisioning.log). Native tests remain separate: 43 passed. Frontend build is pending.

The provisioning frontend production build passed (onboarding-provisioning-ui-final.log). Final notification navigation and queue contract tests: 14 passed. Desktop/mobile visuals were inspected after correcting the shared table width and action sizes.

Administration routing clarification: The user confirmed that asset management belongs in the future Administration module, which has not been developed. The current HR provisioning queue is the interim work queue. Its task identity, responsible employee and fulfillment reference must be carried into the Administration integration when available; no asset-register synchronization or live Administration service is claimed.

## 17. Private onboarding documents and verified signatures

Migration 20261026085200 adds forced-RLS durable upload, evidence and signature ledgers with compound company/checklist/document links. PDF/DOCX originals are limited to 5 MB, privately stored under the checklist with a short-lived HR capability, checked by hash and admitted only after a CLEAN DAM scan. Scan workers recover pending content; retries preserve the original request identity. HR reviews the current immutable evidence revision; employee uploads cannot impose a signing requirement.

A signing request requires verified HR authority, a reviewed PDF and explicit confirmation of the employee’s current mailbox. The existing company LibreSign binding is reused with a separate onboarding folder. Uncertain invitation creation is reconciled by reading the provider before any retry. Signing URLs are available only to the linked employee. Completion requires the actual signed PDF in private DAM, a matching digest and CLEAN scan; legacy timestamps cannot satisfy it. Cancellation cleanup continues with flags off. A cancelled requirement can be withdrawn only by a reasoned HR rejection. No live invitations were sent for these tests.

Seven new tools bring the pinned inventory to 248. Typed HR/employee screens cover upload recovery after reload, reviews, signing confirmation, cancellation, own signing and authenticated downloads without retaining private links or document bytes in the query cache. Native document/DAM/provider tests: 34 passed; adjacent native tests: 43; browser document journeys: 8; HR detail: 6; employee portal: 3. Full HR checkpoint: 341 suites / 4,259 tests passed, with lint and boundaries clean. The final template changes are a later checkpoint. Sources remain undeployed.

## 18. Company onboarding template administration

The service independently verifies human HR authority and resolves the actual employee account. Task definitions use closed category/stage/assignee vocabularies, whole-day offsets from −365 to 365 and bounded text. Edits and deactivation require the observed updated_at revision. Tenant serialization and migration 20261026085300 enforce one active default. The migration deterministically retains the most recently edited default when legacy duplicates exist. Template changes emit attributed, IDs-only events.

The dashboard template editor supports ordered tasks, owners, day offsets, explicit default promotion, deactivation and reactivation. Changes apply to future hires; existing task snapshots remain unchanged. Native authorization/concurrency/revision/RLS tests: 6 passed; focused HR tests: 16; frontend template contract tests: 3; browser journeys: 5. Migration replay validates 189 migrations with no schema difference. Final visual and build results are recorded in implementation-progress.json. Template session creation and calendar delivery remain separate work.

### Docker maintenance recovery — 22 October 2026

Formatting Module completed the Docker route repair and moved Trusoft's signing network to 172.30.240.0/24 with persistent containers and mounts retained. Recruitment restarted the existing BOC, HomeVision, HomeNet and JOC containers in dependency order. All five company applications and databases report healthy; all five public signing status endpoints return HTTPS 200 with installed=true, maintenance=false and needsDbUpgrade=false. Evidence: recruitment-implementation/.runtime/libresign-post-docker-health.json. The temporary Trusoft Live Website installation remains stopped. No additional invitations were sent. This recovery does not activate the pending ERP recruitment changes or feature flags.

## 19. Onboarding sessions and existing HR calendar (local implementation)

Migration 20261026085400 adds a company-scoped, forced-RLS calendar ledger for onboarding sessions. HR's published working schedules, holidays, approved leave and recruitment interviews share the same sorted employee locks and half-open conflict checks. Times use explicit IANA zones; invalid local times and ambiguous daylight-saving times are rejected. Leave and occupied slots cannot be overridden; unverified or non-working hours require an attributed explanation.

Template task definitions can select orientation, training, meeting or compliance. Handoff and manual onboarding materialize one draft session per selected task, preserving the start-date offset. Drafts do not send invitations: both participants need active linked ERP accounts, and HR confirms owner, time and calendar invitation. This explicit confirmation remains necessary where templates do not supply those details. The standard 12-task baseline seeds orientation, compliance and a 30-day check-in. Existing checklists retain their original tasks and sessions.

The three new tools are hr_onboarding_session_availability, hr_onboarding_session_schedule and hr_onboarding_session_finish. The shared catalogue now contains 251 recruitment/onboarding tools. HR mutations require company-wide onboarding authority, verified employee identity and the displayed revision. A stable draft request key deduplicates creation retries. Rescheduling preserves one calendar event; cancellation retains a tombstone. Attendance completion requires an ended session and a reference or outcome. Private scheduling reasons are encrypted; events contain only IDs, action and revision.

The onboarding-calendar-sync scheduler runs every minute. Creation/rescheduling require HR_ONBOARDING_AUTOMATION and HR_RECRUITMENT_CALENDAR_SYNC. Cancellation and cleanup of inactive or changed participant accounts continue with flags off. Jobs use leases, revision comparisons, bounded retry delays and exact receipts; malformed preparation cannot monopolize the queue. Communication uses a separate onboarding_calendar_links table and /internal/onboarding/calendar endpoint. Tokens must carry the onboarding-calendar purpose; interview tokens cannot call it. COMMUNICATION_SERVICE_URL and the existing HR EdDSA trust/key configuration are required. No external calendar provider is introduced.

The HR detail screen has availability checks, booking/rescheduling, reasoned cancellation, attendance confirmation and agenda/day/week filters. The employee portal shows draft, confirmed, cancelled/completed and calendar synchronization status. Template administration exposes the optional session type. Both use typed query responses and company-scoped invalidation.

Focused local evidence: 13 calendar/timezone cases, 9 adjacent interview-calendar cases, 60 onboarding/document/template/provisioning cases and 22 Communication transport cases passed. The 21 browser journeys cover calendar, templates, HR details and the employee portal. Desktop/mobile views and the booking form were visually inspected. Schema validation and HR migration replay reached 190 migrations with no schema difference. Full repository gates and the final production build are still being completed; these changes have not been deployed or enabled in production.

Deployment prerequisites: replay both service migrations, deploy compatible contracts/HR/Communication/gateway/frontend builds, validate company RBAC identity provisioning and linked account ownership, then run the approved staging hire-to-session flow. Cross-company reuse of a Communication user identity still fails closed pending the separate membership design. Physical kiosk acceptance, staged feature activation and the remaining talent/referral/analytics work remain required for overall compliance.


### Talent pool completeness and regression repair (22 October 2026)

Managed pool results now filter and sort the full company/actor scope before paging. Department is the latest permitted application, skills and filter facets cover the whole scoped collection, ties are stable, and malformed/unknown experience remains unknown. Native PostgreSQL coverage uses 125 records and verifies manager notes/facet isolation and MCP envelopes (7/7). Candidate/requisition pickers support search, paging and retry. Pool mutations have typed response boundaries; realtime, responsive shared dialogs, keyboard dismissal and failed-input preservation are verified.

The calendar aggregate HR run passed 339 suites and failed two legacy fixture suites (3 assertions); after materializing their baseline tasks and checking the three company-scoped draft sessions, both suites pass all 55 tests. Full HR lint/boundaries pass. Communication passed 269 suites / 2522 tests, with one setup timeout; its isolated rerun passes both tests. Two suites / 16 tests remain intentionally skipped by that repository. Communication lint/security/IVR-doc gates pass; dependency gate passes with 49 pre-existing warnings. Calendar foreign-key action drift is resolved; the separate pre-existing Communication schema drift is still present and must not be described as a clean global schema. Latest signed-document evidence check passes all 11 native cases.

No new recruitment flags have been enabled or ERP application code deployed. Candidate merge safety, internal jobs/referrals, shared-user calendar membership and the remaining release gates remain open.


### Duplicate merge service safety checkpoint

`hr_candidate_merge` now defaults to PREVIEW. APPLY requires the displayed preview hash and a true confirmation; string booleans and automation actors are rejected. The server resolves the actual linked employee and locks both company candidates/applications. The surviving contact identity is retained; consents, tokens, pool memberships, skills/AI and document/interview/offer evidence stay on their original profiles. Every live source mailbox token is consumed. Only applications without downstream identity/history dependencies can transfer. Active protected/conflicting applications block merging; terminal overlaps require explicit retention acknowledgement. The archive preserves existing notes. A company audit receipt and minimal domain event commit atomically, and an identical retry returns the receipt.

Eight native PostgreSQL and eight unit cases pass, including foreign/manager denial, concurrent retries, stale previews and intentional audit-insert rollback. The expanded rollback assertion and final registry/lint/event gates are running. Duplicate detection/suggestion queue and review UI remain open. This checkpoint is not production activation.

### Duplicate review and pipeline query checkpoint — 23 October 2026

The recruiter merge dialog now requires a current preview, identity confirmation and explicit historical-conflict acknowledgement. Browser checks cover paged selectors, error recovery, active-conflict refusal, role restrictions and mobile layout. The pipeline now applies search, source/department/stage filtering and ordering before paging; facets and stage totals are scoped across the complete result. Native pipeline tests (8), tool/registry scenarios (58), client boundary tests (3), targeted UI lint and full HR lint pass. Contract event suites pass 107 tests. Production deployment and the duplicate-suggestion job/queue remain pending.


### Kubernetes recovery, regression and DAM backup checkpoint — 23 October 2026

Five separate LibreSign installations are restored and all 22 deployments are ready; Docker remains stopped and masked. Exactly Trusoft, BOC and HomeVision are bound to their approved production senders. HomeNet and JOC remain isolated no-email installations. Provider acceptance, database/Redis isolation, live HR bindings and both sink-only signature flows pass. Previously delivered setup invitations were erased from the providers to prevent reminders. Image security acceptance remains open: the preserved image scan reports 4 CRITICAL and 245 HIGH findings.

The current full HR regression passed all 341 suites and 4,256 tests, followed by clean lint and dependency checks. The six baseline browser journeys pass after repairing a fixture interception; duplicate, merge and pipeline browser groups pass. The frontend production build passes with existing large-chunk warnings. Twelve undeployed migration folder timestamps were corrected without changing SQL content or production history. All 191 migrations replay in a fresh database and Prisma reports no schema difference.

The owner chose DAM for backups. The synthetic private multipart probe passed scanning, byte retrieval, cross-company/parent denial and anonymous access denial. Encrypted per-company captures and independent DAM retrieval/database restore are being verified; consult deploy/libresign/README.md and the protected server index before claiming completion. No periodic schedule or retention deletion has been activated.

Onboarding's legacy upload path and unsupported parent type were corrected to DAM's multipart API and OTHER/hr-onboarding:<checklist-id> inherited policy. All 20 focused storage/document cases pass, including uncertain provider reconciliation and signed-evidence scan gates. The client change remains undeployed; live synthetic upload, CLEAN scan, authoritative signed-URL download/hash match and cleanup pass. Exact upload/download host allowlists are required before activation.


### Company alert and campaign checkpoint — 23 October 2026

Sources remain undeployed. The company policy now contains stage SLA limits and opt-in analytics alert rules: reporting window, cooldown, minimum sample, time-to-fill, attendance-confirmed start, offer acceptance/decline, unresolved handoff count and SLA breach count. Recipients must be active company employees with linked users. The existing HR administrator, immutable policy version, expected-version and rationale checks apply. Blank optional thresholds disable that rule. Counts do not use the mean/rate sample floor.

The hourly system worker reads the same canonical, tenant-scoped metrics as the dashboard. Its cohort is applications received within the configured lookback window ending at the previous UTC day. Handoff failures mean the current unresolved FAILED state, not historical retry attempts. Failed handoff and decline drill-downs retain the same cohort and access scope; internal provider error text is excluded. Per-company locking and atomic event/audit receipts enforce cooldown. Notices use only the notification centre, carrying the exact cohort link. Candidate mail is unaffected. Monitor the worker's failed/unroutable results before activation.

Posted CAREER_SITE requisitions now generate a bounded, deduplicated suggestion for the assigned active recruiter when eligible talent matches exist. This sends an internal review prompt only. A current preview and explicit recruiter approval remain mandatory before invitations are queued. The trusted scheduler sees counts; its matching helper does not expose candidate details.

Validation at this checkpoint: 14 native/pure analytics cases, 54 segmentation unit cases, 19 event-contract cases against the exact 33-event registry, 8 analytics notification cases, 2 campaign notification cases and 15 notification navigation cases pass. Browser checks cover canonical evidence, actual attendance, versioned policy retry, administrator restrictions, mobile layout, matching date fields on alert links, campaign review links and explicit approval. Shared contract suites pass107 cases. Full HR run:339 suites passed and2 stale mock interfaces failed; both were repaired and their35 cases passed on rerun, completing4265 cases across341 suites. Full lint and dependency boundaries pass. The production frontend build is still running; receipts retain the full-run and focused-repair results separately.

Attendance-confirmed time-to-start is additive definitionVersion 1: accepted offer to the earliest finalized, positive-credit check-in on or after the planned start and acceptance, for a completed hire handoff. Pending, absent, leave, future and regularization-needed attendance are excluded. The previous planned-start metric remains separately labelled.
