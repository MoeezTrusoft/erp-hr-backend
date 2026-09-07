# Handoff — HR attendance remediation, 2026-09-06/07

Written at the end of a long session. Everything here is verified against
production unless it says otherwise.

---

## 1. STOP — one thing is committed but NOT deployed

`c4044ec` (**HR-RECON-02**, the Mon–Sat denominator fix) is pushed to `main`
and green in CI, but **the running pod does not have it**. Last deployed image:

```
localhost:5000/trusoft-erp/erp-hr:main-acd81416bb13
```

To finish it — find the 12-char tag first, CI never uses the 7-char form:

```bash
curl -s http://127.0.0.1:5000/v2/trusoft-erp/erp-hr/tags/list \
  | tr ',' '\n' | grep -o 'main-c4044ec[0-9a-f]*'
kubectl -n erp-svc set image deploy/erp-hr-backend hr=localhost:5000/trusoft-erp/erp-hr:main-c4044ec<...>
kubectl -n erp-svc rollout status deploy/erp-hr-backend
```

Nothing else is half-done. No migration is pending.

---

## 2. What this work was

August 2026 attendance did not reconcile against the workbook HR closed the
month on. The gap was large and the derived data was actively wrong in ways
that cost people money — absences invented on rest days, shifts counted twice,
days held out of payroll for no reason.

Starting point vs HR, and where it ended:

| | HR | at the start | now |
|---|---|---|---|
| absent | 16 | 50 | **5** |
| check-out-missing | 0 | 50 | **0** |
| late | 134 | 159 | **144** |
| early | 2 | 0 | 0 |

August now holds 2142 rows: `PRESENT 1233 · WEEKLY_OFF 552 · HOLIDAY 159 ·
LATE 147 · HALF_DAY 42 · ABSENT 5 · MISSING_CHECKOUT 4`. Every day for every
tracked employee is positively stated, so a blank now means "we do not have
it" and nothing else.

---

## 3. Shipped, in order

Each was TDD'd (failing test first, finding ID in the name) and deployed
separately. `git log --oneline 798a9be..c4044ec` for the full list.

| Commit | ID | What was wrong |
|---|---|---|
| `993169c` | `HR-ATT-RETRACT-01` | The writer only added/updated. A day with no punches produced no shift, so a stored row outlived any roster correction — 31 rest-day rows reported "unchanged" forever. |
| `e49cddd` | `HR-ATT-DUPLICATE-01` | The MB460 records every press 3–4×. The first duplicate closed a shift and cleared the open-shift state; the second was read as an ARRIVAL and invented a session on the next (rest) day. This is why deleting rows never held. |
| `1291a02` | `HR-ATT-WINDOW-01` | Punches were queried strictly inside `[from,to]`, so a night shift starting the evening before lost its check-in — 8 of 37 rows on 08-01 were phantom MISSING_CHECKOUT. Every month boundary parked a day's pay. |
| `6b95f74` | `HR-ROSTER-01/02`, `HR-ATT-REGRESSION-01` | `resolveWorkingDays` documented effective dating and did not implement it (one schedule for the whole window). Roster changes are now versioned. August frozen as a fixture. |
| `7212bdd` | `HR-ATT-OFFDAY-01` | A lone scan on a rostered off day opened a session. Eleven hand-deletes had all been undone by the next re-derivation. |
| `2944c8c` | `HR-PAY-ELIG-01` | People not on payroll were still being evaluated. Adds `Employee.payroll_included`. |
| `af4dca0` | `HR-ROSTER-04` | `schedule_pattern.shift` held ONE window, so "Saturday is a short day" was inexpressible. Adds `shiftByDay`. |
| `5e74c6b` | `HR-ATT-DIRECTION-01`, `HR-ATT-TOLERANCE-01` | A lone punch was always the arrival (wrong for 23 of 61 days); the 5h close window missed hamza's 05:06 departure by 6 minutes. |
| `5208c4a` + `c46b8d9` | `HR-ATT-STATUS-01` | No way to say "not working" — an off day was an absent row or no row. Adds `WEEKLY_OFF`/`HOLIDAY`/`ON_LEAVE`. **c46b8d9 fixes a transaction-timeout bug in the first version.** |
| `06f04d5` | `HR-HOL-01` | Holiday calendar loader (see §6 — the data already existed). |
| `43decbd` | `HR-ATT-CORRECTION-02` | The audit recorded only the new values, never the before-state. Plus a backfill for 42 corrections applied by script with no author. |
| `9c69532` | `HR-RECON-01` | Month-end reconciliation as a runnable report instead of a scratchpad script. |
| `1632205` | `HR-ROSTER-03`, `HR-IMPORT-01` | `schedule_pattern` was unvalidated (a typo meant a silent seven-day week); sheet matching was fuzzy name overlap. Adds `Employee.sheet_alias`. |
| `acd8141` | `HR-ROSTER-02` fix | `changeRoster`'s CREATE path never set `schedule_name`/`total_hours_per_week` (NOT NULL). Had never run until Meesam's re-hire. |
| `c4044ec` | `HR-RECON-02` | **NOT DEPLOYED.** Weekly graph and absenteeism trend hardcoded Mon–Sat. |

Tests: **172 suites / 2473 passing.**

---

## 4. Data applied to production

- **Rosters corrected** (effective 1 Aug, versioned): Tanveer → Sat+Sun, Hasher
  → Sat+Mon, Sameer and Usman → Tue+Wed+Thu. 29 of 33 Homenet rosters were
  already right.
- **Akash (EMP160)**: weekday `07:30–15:00` + Saturday `10:00–13:00` via
  `shiftByDay`. His 5 Saturdays were ABSENT because a 2–3h day judged against
  `07:00–15:00` fell under the half-day threshold. EMG lates fell 50 → 35.
- **M. meesam (EMP213)**: `09:00–17:00`, Mon–Fri, effective **2026-09-07** (his
  re-hire). Two contiguous versions now: id 16 `08-01 → 09-06`, id 76
  `09-07 → open`.
- **Sameer (EMP197)**: `payroll_included = false`. He is not on payroll; his 15
  shifts left the reconciliation.
- **39 HR-sheet fills + 3 time fills**, all `manually_corrected`. **36 of the 39
  values are the ROSTERED BOUNDARY, not observed times** — HR credited the
  scheduled shift where a scan was absent. Only Rustam 08-01 (`09:27`) and
  Meesam 08-17 (`00:17`) are real readings. The remark on each row says so.
- **711 off-day rows** written (`WEEKLY_OFF 552`, `HOLIDAY 159`).
- **42 corrections backfilled** with author/timestamp/reason. 263 of 263 August
  corrected rows are now attributed; audit log 359 → 401.
- **17 sheet aliases** recorded, no clashes.

---

## 5. Still open

1. **Deploy `c4044ec`** (§1).
2. **The real payroll run has never executed.** Last dry run: 74 employees,
   gross 4,055,161, tax 102,650, loans 48,000, attendance deductions 74,251,
   **net 3,830,261**. The attendance underneath it is now trustworthy; this is
   the natural next step and needs explicit approval.
3. **Reconciliation on MCP/UI** — the service and script exist; exposing it
   needs an RBAC permission key seeded first (see CLAUDE.md lessons: a tool
   registered without its permission returns 403).
4. **Absent is 5 vs HR's 16.** We are UNDER. Their count probably includes
   leave-type absences we classify separately — worth one question to HR.
5. **Per-employee late deltas.** Aggregate is +1 of 134, but 32 employees
   differ individually by ±1–4 (Samar +4, Faizan +3, Wajahat −4, G Rasool −3).
   These look like HR hand-adjustments on borderline minutes; no policy
   reproduces them.
6. **Three rosters still fail validation** — affan, afzal, shizza. All
   terminated, so harmless; the validator will catch them if anyone is re-hired.
7. **The four payroll features** from the older backlog: day-N-of-following-month
   calendar anchor, weekend-shift direction, FOC exemption from attendance
   penalties, per-employee payment scheduling.

---

## 6. Things I got wrong — do not re-derive them

- **"No holidays are loaded" was FALSE.** Five per-tenant calendars with 15 rows
  already existed. I took it from my own plan item and wrote a loader for data
  that was there. 4 Aug Chehlum, 14 Aug Independence Day, 26 Aug Eid
  Milad-un-Nabi — which is why those three days show ~16–26 attendance rows
  against ~55. HR will declare future/past holidays through a calendar UI; do
  not bulk-load a list.
- **"The late gap is +25" was FALSE.** My fuzzy matcher mispaired people (it had
  HR's JOC `Akash Nanu` claiming EMG's `Akash`). One-to-one matching gives
  135 vs 134.
- **"Grace should be 15 minutes" was FALSE.** Fitting every grace value against
  HR: 0 → 135 (best), 5 → 131, 10 → 120, 15 → 102. The old "290 of 359 lates
  were under 15 minutes" measurement predated the roster fixes, when wrong
  shift starts were manufacturing the lates. **Grace 0 is correct.**

---

## 7. Operational gotchas

- **Deploy BEFORE migrate.** `prisma migrate deploy` runs from the pod's image.
  Migrating first reports "No pending migrations" and silently does nothing.
- **CI tags with a 12-char SHA.** A 7-char tag gives `ImagePullBackOff`.
- **`kubectl set image` / `apply` / `migrate deploy` are blocked for the agent**
  by the permission classifier — hand them to the operator. ArgoCD's
  application-controller is 0/0 by agreement, so nothing auto-syncs.
- **Never pass a command containing `<placeholder>`** — `<` is a shell redirect
  and the command silently does something else. This cost two failed deploys.
- **Verify writes by querying the database, not by reading a script's summary.**
  A transaction-timeout rollback printed "written: 0" with no error and I
  nearly accepted it.
- **Prisma interactive transactions have a 5-second budget.** Bulk with
  `createMany`/`updateMany`, chunk at 200, resolve lookups before opening the
  transaction.
- **A permissive mock ships bugs the real client refuses.** Twice this session:
  a query used `tenantId` where `Employee`'s column is `tenant_id`, and
  `changeRoster`'s create omitted NOT NULL columns. Both passed unit tests and
  failed in production. Make mocks enforce real column names and required
  fields.
- **Everything is UTC.** `startOfDay` uses local `setHours`; the same punches
  give 321 sessions under UTC and 390 under UTC+5. Run scripts and tests with
  `TZ=UTC`. There is a test pinning this.
- **`scripts/podrun.sh`** runs a local `.mjs` inside the prod pod — the way to
  run something that is not in the deployed image. It cannot import a `src/`
  module that the image lacks.

---

## 8. Where things live

```
src/lib/attendanceReplay.js          sessionisation: dedupe, open-shift, direction,
                                     off-day suppression, window padding
src/lib/schedulePattern.js           roster validation (HR-ROSTER-03)
src/lib/employeeIdentity.js          exact sheet-label matching (HR-IMPORT-01)
src/services/workingDay.service.js   per-day roster resolution (HR-ROSTER-01)
src/services/rosterChange.service.js versioned roster changes (HR-ROSTER-02)
src/services/attendanceWriter.service.js  apply/retract/assert (RETRACT-01, STATUS-01)
src/services/attendanceReconciliation.service.js   month-end report (RECON-01)
src/services/timesheetReport.service.js            HR screen (RECON-02)
tests/fixtures/HR-ATT-REGRESSION-01.august-2026.json   14 employees, 898 punches
```

Useful scripts (all dry-run by default, `--write` to commit):

```bash
scripts/reevaluate-range.mjs 2026-08-01 2026-08-31 [--write]
scripts/reconciliation-report.mjs 2026-08-01 2026-08-31 [--csv]
scripts/set-sheet-aliases.mjs [--write]          # also audits every roster
scripts/backfill-correction-attribution.mjs --actor EMP214 [--write]
scripts/load-holidays.mjs holidays.json --created-by EMP214 [--write]
```

---

## 9. The regression fixture matters

`HR-ATT-REGRESSION-01` freezes 14 employees / 898 punches / 319 sessions of real
August data, chosen because each exposed a distinct defect. It is a
characterisation test: it does not claim every line is CORRECT, it claims the
behaviour is KNOWN.

It fired once, on `HR-ATT-DIRECTION-01`/`TOLERANCE-01`, changing 13 of 14
employees. **Every change was one previously derived by hand from HR's sheet**,
so it was reviewed line by line and re-frozen deliberately. If it fires again,
do that — read the diff, decide, then re-freeze. Do not regenerate it to make
the suite green.
