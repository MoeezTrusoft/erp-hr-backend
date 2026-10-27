# Recruitment go-live runbook (Phase 6)

The go-live checklist (plan section 13.1) made checkable from this repository.
It adds to `docs/RECRUITMENT-ROLLOUT-RUNBOOK.md` (flags, migrations, deploy,
rollback) and does not replace it.

What this repository ships for the other owners, all machine-checked:

| Artefact | For | Checked by |
|---|---|---|
| `src/release/recruitment-tools.manifest.js`: every recruitment MCP tool with the permission it asserts | Gateway owner (edge permission map), RBAC owner | `tests/unit/release/recruitment-tools-manifest.test.js` (calls every handler and reads its gate) |
| Same file, `RECRUITMENT_ROLE_GRANTS` and `APPROVAL_CENTRE_KEYS`: the RBAC keys each role needs | RBAC owner (seeds and role grants) | same test (coverage, scope per role claim, forbidden grants) |
| `src/release/recruitment-events.manifest.js`: recipient, channel, template for every `hr.recruitment.*` and `hr.onboarding.*` event, plus the templates sent directly | Notification Hub owner | `tests/unit/release/recruitment-events-manifest.test.js` (re-scans `src/`) |
| `observability/alerts/*.rules.yml` | Prometheus and Alertmanager owner | `tests/unit/release/recruitment-alert-rules.test.js`, `tests/unit/lib/recruitment-onboarding-alert-rules.test.js` |
| `scripts/recruitment-smoke.mjs` | Release manager (staging) | run it (section 4) |

This runbook itself is checked by `tests/unit/release/recruitment-golive-runbook.test.js`:
every flag in `src/lib/recruitment-flags.util.js` is placed exactly once in section 1,
every alert is named in section 3, and every file the checklist cites exists.

## 1. Flag order

Plan section 12.1: security, then workflow, offer handoff, portal, analytics,
AI, and retention last and per tenant. Each flip is followed by a day of
watching its counter (and the tool's errors) before the next. Flags are read at
call time; a restart applies them. Defaults are in `src/lib/recruitment-flags.util.js`
(`on` below means the default is on; do not switch those off in production).

### Stage 0: security (no flag)

1. RBAC seeds and role grants from the manifest (section 2). Agency roles get
   `hr:recruitment_agency` only, before any agency login exists.
2. Gateway edge map from the manifest (section 2), and the unauthenticated
   forwards: `/public/*` (portal, interview slots, privacy requests, invitation
   links, job feeds), `/kiosk/v1/*` (with `trust proxy` set correctly) and
   `POST /webhooks/esign/*`.
3. Portal tenant pinning: `HR_PORTAL_HOSTS` (host to tenant), and
   `HR_PORTAL_TRUST_EDGE_HEADER=true` only behind the gateway that strips
   `X-Portal-Tenant` from public traffic. `HR_PORTAL_BASE_URL` for links.
4. Notification Hub mappings loaded from the events manifest (section 2).
5. Prometheus loads `observability/alerts/*.rules.yml` (section 3).

### Stage 1: workflow

| Order | Flag | Notes |
|---|---|---|
| 1.1 | `HR_RECRUITMENT_WORKFLOW_ENFORCEMENT` | on. Mandatory-field submission gate and the scheduled sweeps. |
| 1.2 | `HR_RECRUITMENT_APPROVAL_SLA` | Only after the hub maps `approval_reminder` and `approval_escalated`. |
| 1.3 | `HR_RECRUITMENT_POSTING_EXPIRY` | Review requisitions already past `closesAt` first: the first run closes them all. |
| 1.4 | `HR_RECRUITMENT_AUTO_PUBLISH` | Per tenant decision: publication is candidate-facing. |
| 1.5 | `HR_RECRUITMENT_DUPLICATES` | Suggestions only; merges stay manual. |
| 1.6 | `HR_RECRUITMENT_KNOCKOUT` | After the tenant reviewed its knockout questions and delay. |
| 1.7 | `HR_RECRUITMENT_COMMUNICATIONS` | Needs `HR_CANDIDATE_COMMS_WORKER_ENABLED=true` on the worker pod and the candidate templates in the hub. |
| 1.8 | `HR_RECRUITMENT_CALENDAR_SYNC` | Needs `COMMUNICATION_SERVICE_URL` and `HR_INTERVIEW_CALENDAR_WORKER_ENABLED=true`. |
| 1.9 | `HR_RECRUITMENT_INTERVIEW_REMINDERS` | Hub templates for interviewer reminders and nudges first. |
| 1.10 | `HR_RECRUITMENT_DECISION_PROMPTS` | Auto-advance on NEXT_ROUND after a FINAL round. |
| 1.11 | `HR_RECRUITMENT_EVALUATION_FORMS` | Forms and question bank configured per job family. |
| 1.12 | `HR_RECRUITMENT_ONSITE_TEST` | Pilot site: kiosks registered, item bank reviewed, blueprints published; set `HR_KIOSK_CODE_PEPPER` as a secret. |
| 1.13 | `HR_RECRUITMENT_KIOSK_RESUME` | After the on-site test runs at the pilot site; rehearse a kiosk crash and resume (checklist line 7). |

### Stage 2: offer handoff

| Order | Flag | Notes |
|---|---|---|
| 2.1 | `HR_RECRUITMENT_OFFER_HANDOFF` | on. Acceptance and the hire handoff; the handoff pages are live (section 3). |
| 2.2 | `HR_RECRUITMENT_OFFER_LETTERS` | Letter templates saved per tenant. |
| 2.3 | `HR_RECRUITMENT_ESIGN` | `ESIGN_PROVIDER`, `ESIGN_API_BASE`, `ESIGN_API_KEY`, `ESIGN_WEBHOOK_SECRET`, `ESIGN_CALLBACK_BASE_URL`; the webhook forward from stage 0. |
| 2.4 | `HR_RECRUITMENT_OFFER_EXPIRY` | Candidate expiry reminder template in the hub. |
| 2.5 | `HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL` | Extensions go back through the HR Approval Centre. |
| 2.6 | `HR_ONBOARDING_AUTOMATION` | IT staff RBAC (section 2); `HR_ONBOARDING_CALENDAR_WORKER_ENABLED=true` for invites. |
| 2.7 | `HR_ONBOARDING_SELF_PORTAL` | Every employee holds `hr:self` VIEW. |

### Stage 3: portal

| Order | Flag | Notes |
|---|---|---|
| 3.1 | `HR_RECRUITMENT_PUBLIC_PORTAL` | on. Portal intake and listings. |
| 3.2 | `HR_RECRUITMENT_JOB_FEED` | `HR_JOB_FEED_BASE_URL` set; tenant `feedEnabled`. |
| 3.3 | `HR_RECRUITMENT_SELF_SCHEDULING` | Needs calendar sync (1.8) and the slot offer template. |
| 3.4 | `HR_RECRUITMENT_INVITATION_LINKS` | Talent pool invitation template with its accept/decline link. |
| 3.5 | `HR_RECRUITMENT_TALENT_NURTURE` | Recruiters review proposals; nothing is sent automatically. |
| 3.6 | `HR_RECRUITMENT_INTERNAL_BOARD` | Every employee holds `hr:self` VIEW. |
| 3.7 | `HR_RECRUITMENT_AGENCY_PORTAL` | Only after the agency RBAC of stage 0 is verified with an agency login. |
| 3.8 | `HR_RECRUITMENT_DSR_PORTAL` | Careers `/privacy/verify` page live; DAM accepts `application/json`. |

### Stage 4: analytics

| Order | Flag | Notes |
|---|---|---|
| 4.1 | `HR_RECRUITMENT_CANONICAL_ANALYTICS` | on. |
| 4.2 | `HR_RECRUITMENT_CANONICAL_DASHBOARD` | Changes reported figures: reconcile with the dashboard owners first. |
| 4.3 | `HR_RECRUITMENT_ANALYTICS_ALERTS` | Thresholds and `alertRecipientId` set per tenant. |

### Stage 5: AI

| Order | Flag | Notes |
|---|---|---|
| 5.1 | `HR_RECRUITMENT_AI` | AI plane reachable (`REDIS_URL`); an approved provider. |
| 5.2 | `HR_RESUME_PARSE_WORKER_ENABLED` | Same name is the worker switch on the pod. |
| 5.3 | `HR_RECRUITMENT_SCORING` | Reads parse output: after 5.2 has run for a while. |

### Stage 6: retention, last and per tenant

| Order | Flag | Notes |
|---|---|---|
| 6.1 | `HR_RECRUITMENT_RETENTION_AUTOMATION` | Keep `HR_CANDIDATE_RETENTION_MODE=dry-run` (default). Apply happens per tenant only after its data-policy owner signs off a dry-run from the last 7 days (`hr_candidate_retention_signoff`); `hr_candidate_retention_apply_disable` switches it back. |

## 2. Manifests to hand over

Print them from a checkout of the release commit:

```bash
# Gateway: tool name -> { resource, action, scope }
node -e "import('./src/release/recruitment-tools.manifest.js').then((m) => process.stdout.write(JSON.stringify(m.recruitmentGatewayToolMap(), null, 2)))" > recruitment-gateway-tool-map.json

# RBAC: keys per role (canonical "hr.recruitment.read" form), plus the Approval Centre keys
node -e "import('./src/release/recruitment-tools.manifest.js').then((m) => process.stdout.write(JSON.stringify({ roles: Object.fromEntries(Object.entries(m.RECRUITMENT_ROLE_GRANTS).map(([r, d]) => [r, { claims: d.claims, scope: d.scope, keys: m.recruitmentRoleScopes(r) }])), approvalCentre: m.APPROVAL_CENTRE_KEYS }, null, 2)))" > recruitment-rbac-roles.json

# Notification Hub: event -> routes, and the directly sent templates
node -e "import('./src/release/recruitment-events.manifest.js').then((m) => process.stdout.write(JSON.stringify({ events: m.RECRUITMENT_EVENT_MANIFEST, directTemplates: m.RECRUITMENT_DIRECT_HUB_TEMPLATES }, null, 2)))" > recruitment-hub-mappings.json
```

Owner notes:

- **Gateway**: the map covers every recruitment tool; the pre-existing
  onboarding screens and skills tools are `RECRUITMENT_LEGACY_TOOLS` and keep
  their existing entries. The gateway's own exposure test must list the same
  names.
- **RBAC**: RBAC issues the role claims and grants. Grant `hr:recruitment`
  only to roles whose claim the row-scope library knows (scope not null in the
  table): any other claim resolves to NONE and sees no recruitment rows. Mint
  `employeeId` for every staff login (without it a hiring manager or
  interviewer claim also sees nothing). The privacy and administration tools share
  `hr:recruitment` with the recruiter's tools today (open decision: a dedicated
  resource if the "HR admin only" line must be enforced by key).
- **Notification Hub**: candidates are reached only through the
  candidate-communication module (routes with `candidateFacing: true`), never
  from an event directly. A route marked `pending` names a template that is not
  built yet.

## 3. Alerts

`observability/alerts/recruitment-onboarding.rules.yml` (handoff pages) and
`observability/alerts/recruitment-golive.rules.yml` (privacy, notifications,
Phase 5 volumes). Load both; route `severity: page` to on-call and
`severity: ticket` to the HR engineering queue.

| Alert | Severity | Means |
|---|---|---|
| `HrRecruitmentHandoffFailed` | page | An accepted offer did not produce its employee and checklist. |
| `HrRecruitmentHandoffFailuresSustained` | page | Three or more handoff failures in an hour. |
| `HrRecruitmentRetentionRunFailed` | page | A retention run failed. |
| `HrRecruitmentRetentionApplyRefused` | ticket | Apply was asked for a tenant without the owner's sign-off. |
| `HrRecruitmentRetentionApplied` | ticket | Candidate data was erased; confirm it was intended. |
| `HrRecruitmentDsrSlaAtRisk` | ticket | A data-subject request is near or past its deadline. |
| `HrRecruitmentNotificationsDropped` | ticket | Events or candidate emails are not reaching the hub. |

The seven counters (`/metrics`): `hr_recruitment_transition_failures_total`,
`hr_recruitment_handoffs_total`, `hr_recruitment_resume_parses_total`,
`hr_recruitment_notifications_total`, `hr_recruitment_denials_total`,
`hr_recruitment_exports_total`, `hr_recruitment_retention_runs_total`.

## 4. Smoke commands

Read-only (any time, any environment; reads one row per area):

```bash
HR_SMOKE_MCP_URL=https://<hr-host>/mcp HR_SMOKE_TENANT_ID=<tenant uuid> \
HR_SMOKE_TOKEN=<service JWT for the smoke account> \
node scripts/recruitment-smoke.mjs | jq -r 'select(.table) | .msg'
```

Instead of `HR_SMOKE_TOKEN`, `HR_SMOKE_USER_ID` and `HR_SMOKE_EMPLOYEE_ID`
with `SERVICE_JWT_SECRET` mint a 15 minute HS256 token (HR_ADMIN keys; set
`HR_SMOKE_ROLES` to change the role claim).

Write journey (staging only, a dedicated smoke tenant or account):

```bash
HR_SMOKE_MCP_URL=... HR_SMOKE_TENANT_ID=... HR_SMOKE_TOKEN=... \
HR_SMOKE_EMPLOYEE_ID=<smoke employee id> HR_SMOKE_EMPLOYEE_CODE=<its employee code> \
HR_SMOKE_DEPARTMENT_ID=<department id> HR_SMOKE_PORTAL_URL=https://<careers host> \
HR_SMOKE_MANAGER_TOKEN=... HR_SMOKE_HR_VERIFIER_TOKEN=... HR_SMOKE_APPROVER_TOKEN=... \
node scripts/recruitment-smoke.mjs --write | jq -r 'select(.table) | .msg'
```

Fixtures the write journey needs on staging:

- The smoke employee (`HR_SMOKE_EMPLOYEE_ID`, code `HR_SMOKE_EMPLOYEE_CODE`)
  is the requisition's hiring manager and recruiter and the offer's creator. Its
  login (numeric `userId` linked to the employee) holds the HR_ADMIN keys and
  `hr.approvals.self`, and it has an active line manager.
- Three more linked logins for the HR Approval Centre, three different
  people: that line manager (`hr.approvals.manager`, `HR_SMOKE_MANAGER_*`), an HR
  verifier (`hr.approvals.verify`, `HR_SMOKE_HR_VERIFIER_*`) and a management
  approver (`hr.approvals.approve`, `HR_SMOKE_APPROVER_*`). Each is a `*_TOKEN`
  or `*_USER_ID` + `*_EMPLOYEE_ID` to mint.
- The portal host maps to the tenant (`HR_PORTAL_HOSTS`), or set
  `HR_SMOKE_PORTAL_TENANT_HEADER=true` against a gateway that trusts
  `X-Portal-Tenant`. The portal allows 6 applications a minute per IP.
- Optional: `HR_SMOKE_COST_CENTER_REF`, `HR_SMOKE_INTERVIEWER_ID`,
  `HR_SMOKE_OFFER_SALARY`, `HR_SMOKE_CURRENCY`, `HR_SMOKE_EMPLOYEE_CATEGORY`,
  `HR_SMOKE_CANDIDATE_EMAIL` (`{run}` is replaced by the run id),
  `HR_SMOKE_REQUISITION_JSON` (extra create fields), `HR_SMOKE_REST_URL` (when
  `/api` is not on the MCP URL's origin), `HR_SMOKE_TIMEOUT_MS`.

The journey closes (or withdraws) its requisition whatever happens and prints
the ids it created. A passing run leaves a real candidate and a real employee
in the staging tenant: separate or anonymize them there as for any test hire.

## 5. Go-live checklist (plan 13.1) and what proves each line

| # | Line | Proof in this repository | Outside this repository |
|---|---|---|---|
| 1 | The end-to-end journey passes on staging against the Approval Centre with a dedicated service account | `scripts/recruitment-smoke.mjs --write` (section 4); locally `tests/integration/P4.hire-handoff.db.test.js` and `tests/integration/recruitment.e2e.test.js` | Frontend Playwright journey (plan 9.6) |
| 2 | All seven counters plus the new ones are visible in Prometheus with the alerts configured | `tests/unit/release/recruitment-alert-rules.test.js`, `tests/unit/lib/recruitment-onboarding-alert-rules.test.js`; on staging `curl -s https://<hr-host>/metrics \| grep -c '^# TYPE hr_recruitment_'` | Prometheus loads `observability/alerts/*.rules.yml`; Alertmanager routes page and ticket |
| 3 | Every tool called by the frontend is pinned in both registries and the gateway map; federation drift is empty | `tests/unit/mcp/recruitmentMcpInventory.test.js`, `tests/unit/release/recruitment-tools-manifest.test.js`, the smoke's tools/list check | Gateway exposure test loads the gateway map; frontend called-tools list checked against the manifest |
| 4 | Pixel diff is zero on unchanged screens and baselines exist for every new screen | none (frontend) | Frontend visual gate (E-04) |
| 5 | Retention runs in dry-run with a reviewed report; apply stays off until the data-policy owner enables it per tenant | `tests/integration/P5.agency-retention.db.test.js`; alert `HrRecruitmentRetentionApplied`; smoke reads `hr_candidate_retention_runs_list` | The owner's sign-off per tenant |
| 6 | No console logging, zero eslint warnings in src/lib, numeric error codes registered, the migration chain replays from zero | `npm run gate:p1` (lint with `--max-warnings 0`, `no-console` is an error); `tests/unit/middlewares/feature-disabled-errors.test.js` and `tests/unit/middlewares/dependency-unavailable-errors.test.js`; `tests/integration/F-DB-01.migration-chain.db.test.js` | |
| 7 | The interview-day journey passes at the pilot site, including a kiosk crash and resume | `tests/unit/services/kiosk-resume.service.test.js`, `tests/unit/routes/kiosk-resume.routes.test.js` | Pilot-site rehearsal and the frontend interview-day journey |
