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
2. Deploy HR with flags at the stage-1 posture (defaults: AI off, retention
   off, everything else on).
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

## 7. Known residue (not blockers)

- Retention **apply** remains off pending the §8 sign-off sequence.
- Requisition attachment MCP tools blocked on the DAM ACL matrix; Finance/
  Workforce-Planning budget/headcount validity blocked on those services.
- Phase 5 portal notification pieces (magic-link, save-and-return) are
  Notification-Hub/frontend residue.
