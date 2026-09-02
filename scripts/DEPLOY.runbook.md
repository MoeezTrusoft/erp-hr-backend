# HR Production Deploy Runbook (REQ-HR-DEPLOY-HARDENING-2026-09-02 §2d)

This is the whole procedure for getting a new `erp-hr-backend` image into
production. It is manual on purpose — see §5, ArgoCD is frozen. Follow the steps
in order. Every step has a line telling you how to know it worked and a line
telling you how to undo it.

Read §6 (known traps) before you start if you have not deployed this service
before, or if it is 2am.

## 0. What you are deploying into

Single-node k3s cluster named `erptrusoft`, reachable at:

```
ssh erp_trusoft@103.245.195.3 -p 2272
```

Two namespaces matter:

- `erp-svc` — the application Deployments, including `erp-hr-backend`.
- `erp-data` — the CloudNativePG cluster `erp-pg-1`, which hosts the `erp-hr`
  database.

Images live in a registry on the same node and are referenced as
`localhost:5000/trusoft-erp/erp-hr:main-<sha>`. Tags are immutable: a given tag
always means one build. There is no mirror and no backup of that registry — if
the node's registry volume is lost, every rollback target is lost with it.

`erp-hr-backend` runs 2 replicas with a PodDisruptionBudget of `minAvailable: 1`.
Both replicas serve traffic during a rolling update, which is why the schema
rules in `scripts/MIGRATIONS.md` are not optional.

Note: the k8s manifests are not in this repository. This repo contains the
application, the Dockerfile, and the scripts referenced below.

---

## 1. Pull on the server first

`deploy.sh` builds from the checkout on the server. Not from the git remote. If
you push to the remote and then run the build without pulling on the server, the
build succeeds, the image gets a fresh tag, the rollout goes green, and you have
shipped the old code. Nothing anywhere reports an error. This has cost real time
twice.

```
ssh erp_trusoft@103.245.195.3 -p 2272
cd <server checkout of erp-hr-backend>
git pull
git log -1 --oneline
```

**Verify:** the SHA from `git log -1` is the commit you intend to ship. Compare
it against the commit you pushed. If they differ, stop; you are about to build
the wrong tree.

**Rollback:** nothing has changed yet. `git reset --hard <sha>` if the pull
brought in more than you wanted.

---

## 2. Apply migrations, before the new image rolls

Migrations do not run on pod boot. There is no init container and no migration
Job. If you skip this step, the new image starts against the old schema and
fails at query time, not at startup — so the pod goes Ready and then 500s.

The order is migrate-then-deploy, and it is correct specifically because the
migrations in a release are additive: a nullable `ADD COLUMN`, a `CREATE TABLE`,
a `CREATE INDEX`. None of those break the old image that is still serving
traffic while you work. It keeps reading the columns it already knew about. See
`scripts/MIGRATIONS.md` for the rule that keeps this true, and what happens to
`rollout undo` when someone breaks it.

Prisma 7 requires a config file for any CLI command that touches the database.
The image does not carry one — the Dockerfile copies `package.json`,
`package-lock.json`, `prisma/`, and `src/`, and `prisma.config.js` is not in
that list. Write one into the container before running the CLI, and use a plain
object export; the module-resolution helpers fail inside the runtime image:

```js
export default {
  schema: '/app/prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL },
};
```

`schema` must point at the real schema file. If it points anywhere else,
`prisma migrate resolve` fails with **P3017** ("migration not found"), because
Prisma resolves the migrations directory relative to the schema.

Apply:

```
kubectl -n erp-svc exec deploy/erp-hr-backend -- npx prisma migrate deploy
```

**Verify:** the command prints the migrations it applied and exits 0. Then
confirm nothing is pending:

```
kubectl -n erp-svc exec deploy/erp-hr-backend -- npx prisma migrate status
```

**Rollback:** there is no automatic down-migration and you should not write one
under time pressure. Because the migration was additive, the correct response to
a bad migration is to leave the new column or table in place, unused, and roll
the *image* back (step 4). A column nobody reads is harmless. Reverting the
schema is the dangerous move, not the additive change.

---

## 3. Roll the new image

```
kubectl -n erp-svc set image deploy/erp-hr-backend \
  <container>=localhost:5000/trusoft-erp/erp-hr:main-<sha>
kubectl -n erp-svc rollout status deploy/erp-hr-backend --timeout=300s
```

Get the container name from `kubectl -n erp-svc get deploy erp-hr-backend -o
jsonpath='{.spec.template.spec.containers[*].name}'` rather than guessing — a
wrong container name makes `set image` a silent no-op on some kubectl versions.

Before you run this, write down the image you are replacing:

```
kubectl -n erp-svc get deploy erp-hr-backend \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

That string is your rollback target. Save it somewhere outside the terminal you
are about to lose.

**Verify:** `rollout status` returns "successfully rolled out" within the
timeout, and `kubectl -n erp-svc get pods -l app=erp-hr-backend` shows 2 pods
Running and Ready on the new image.

**Rollback:**

```
kubectl -n erp-svc rollout undo deploy/erp-hr-backend
kubectl -n erp-svc rollout status deploy/erp-hr-backend --timeout=300s
```

With `minAvailable: 1` the rollout will refuse to take both replicas down at
once. If `rollout status` hangs rather than failing, that is usually the PDB
holding the line while a new pod fails its probes — look at the new pod's logs
rather than raising the timeout.

---

## 4. Concurrent indexes, if the release adds any

Index work under `scripts/sql/F-DB-06-08-14.hr-indexes.sql` is deliberately
outside the Prisma migration chain, per `ARCH-01 §5.5`: those statements are
`CREATE INDEX CONCURRENTLY` and cannot run inside a transaction. Skip this step
if the release did not touch that file.

```
DATABASE_DIRECT_URL=<direct postgres url> npm run db:indexes:deploy
```

The full procedure, including how to detect an interrupted build, is in
`scripts/F-DB-06-08-14.hr-indexes.runbook.md`. Read it; do not improvise here.
The script requires `DATABASE_DIRECT_URL` (or `DATABASE_URL`) and refuses to run
without one.

**Verify:** the query in that runbook returns no rows:

```sql
SELECT indexrelid::regclass, indisvalid, indisready
FROM pg_index
WHERE NOT indisvalid OR NOT indisready;
```

**Rollback:** re-running the script is safe; every statement is idempotent. An
interrupted `CREATE INDEX CONCURRENTLY` leaves an invalid index that the query
above will show — drop it concurrently and re-run.

---

## 5. Post-deploy smoke — this is the gate

```
npm run smoke:deploy
```

That runs `scripts/deploy-smoke.mjs`. It is deliberately not a health check.
`/readyz` stayed green through an entire window in which the gitops manifest had
no `HR_ATTENDANCE_INTAKE_KEY`, which meant the biometric device was being 403'd
and losing punches silently. The smoke asserts, in order:

1. `GET /healthz` and `GET /readyz` both return 200.
2. Attendance intake with **no** key returns 403.
3. Attendance intake with a **wrong** key returns 403.
4. Attendance intake with the **real** key returns 200 and reports
   `summary.rawStored === 1`.
5. A tenant-scoped read of the attendance policy returns a stored row, not the
   in-code defaults — an RLS-model omission reads back as "unconfigured" with no
   error, and once shipped a grace period written as 15 and read back as 0.

The negative cases run before the positive one on purpose: a route that 200s
without a key is worse than one that 403s with a good key, because it means
anyone inside the cluster can inject attendance.

It needs `HR_ATTENDANCE_INTAKE_KEY` and `HR_ATTENDANCE_INTAKE_TENANT_ID` in the
environment and will fail immediately without them. It writes one punch for
device id `SMOKE0` — which matches no employee, so no `Attendance` row is
created and no real person is touched — and deletes it again in a `finally`
block.

**Verify:** exit code 0, and the final line reads `N passed, 0 failed`.

**Rollback:** any non-zero exit means roll back. Do not debug in place with the
new image serving traffic:

```
kubectl -n erp-svc rollout undo deploy/erp-hr-backend
```

Then re-run the smoke against the restored image to confirm the failure was the
release and not the environment.

---

## 6. Leave ArgoCD alone

`argocd-application-controller` is scaled to 0. That is deliberate, and it stays
that way until someone reconciles the gitops repo.

The gitops manifest still pins `main-4657b463c9cf`. Live HR is `main-1e14940`.
Unfreezing the controller triggers a resync, the resync applies the manifest,
and HR rolls **backwards** to a months-old image. Immediately, with no
confirmation prompt.

Separately, the gitops checkout at `/opt/erp-cicd/gitops` is corrupt. `git fsck`
reports a missing tree object and `git status` fails outright. It needs a fresh
clone, not a repair — do not spend the night trying to salvage it, and do not
scale the controller up hoping the corruption is cosmetic.

Both of those have to be fixed together, in daylight, as their own piece of
work: fresh clone, manifest updated to the live image, then unfreeze.

---

## 7. Known traps

- **The server checkout is the build input.** Step 1 exists because skipping it
  produces a green deploy of stale code with no error anywhere. Twice.

- **Do not unfreeze ArgoCD.** It will roll HR backwards. §6.

- **`/opt/erp-cicd/gitops` is corrupt.** Missing tree object; `git status`
  fails. Fresh clone only.

- **Migrations do not run on boot.** No init container, no Job. If you forget
  step 2, the pod becomes Ready and then fails on the first query that touches
  the new column.

- **Prisma 7 CLI needs a config file.** `prisma.config.js` now ships in the
  image, so `migrate status` / `migrate deploy` work in-cluster without help.
  Pods built BEFORE this change do not have it — there, write the plain object
  form shown in step 2 into the container. The fancier `import { defineConfig }
  from 'prisma/config'` form fails module resolution from outside /app, and a
  `schema` path pointing anywhere other than the real schema gives you P3017,
  because the CLI looks for `migrations/` next to whatever schema you name.

- **The port had three different values.** `src/server.js` and
  `scripts/deploy-smoke.mjs` now agree on a `PORT || 3003` fallback, pinned by
  `tests/unit/REQ-HR-DEPLOY-HARDENING-3a.deployability.test.js`. The Dockerfile
  still `EXPOSE`s 3001 and prod sets `PORT=3001` explicitly, which is fine —
  EXPOSE is documentation, and an explicit PORT beats any fallback. Still read
  the container port off the Deployment and set `SMOKE_BASE_URL` when you are
  targeting a specific pod.

- **`scripts/` ships in the image as of this change**, so `npm run smoke:deploy`
  and `npm run db:indexes:deploy` run inside the pod. Before it, the Dockerfile
  copied only `package.json`, `package-lock.json`, `prisma/` and `src/`, and the
  smoke had to be hand-copied into a running container to work at all. Against
  an older image, run it from the server checkout with `SMOKE_BASE_URL` pointing
  at the pod you want to test.

- **The registry has no backup.** Image tags are immutable and single-node. Your
  rollback target only exists as long as that node's registry volume does.
  Record the outgoing image tag (step 3) before you replace it.

- **`prisma migrate diff` will never be clean.** That is expected and
  documented. Do not "fix" it. See `scripts/MIGRATIONS.md`.
