# Company LibreSign operations

## Current deployment

The five active installations run on Kubernetes on erptrusoft. Docker service and socket must remain stopped and masked. The Compose and Windows installer files in this directory are historical provisioning tools; do not run them against the current deployment.

| Company | Namespace | Production sender |
| --- | --- | --- |
| Trusoft | sign-trusoft | recruitment@trusoft.ai |
| BOC | sign-boc | recruitment@blazeoptics.pk |
| HomeVision | sign-homevision | recruitment@emgdigital.pk |
| HomeNet | sign-homenet | No email; isolated Mailpit |
| JOC | sign-joc | No email; isolated Mailpit |

Trusoft Live Website is temporary and excluded. Each company has its own Nextcloud, PostgreSQL, Redis, keys, account and document storage. Public URLs remain https://erp.trusoft.ai/signing/<company-uuid>. Exactly the three production-mail companies are mounted in HR's erp-hr-recruitment-libresign Secret. The sender mappings and exclusion decisions came from the owner.

All five application and cron deployments now use Nextcloud 35.0.2.2, LibreSign 15.0.8 and PHP 8.5.12 on the pinned Alpine candidate `localhost:5000/erp-build/libresign-alpine@sha256:9adaf20f7219646396adaf0d89acd1fcb1386b2d17b164eb791730d8d5b1b08f`. The exact-image Kubernetes scan reports zero critical, high or medium findings, one low and one unknown. The retained Symfony and WebAuthn findings are applicability-reviewed against twelve source hashes; they are not patched or suppressed. The original image with four critical and 245 high findings is retained only as a rollback artifact. This app-image acceptance does not certify database, Redis, host or cluster vulnerability status. The CA is self-managed and is not represented as a publicly trusted qualified signing certificate.

## Verified recovery

Kubernetes-Recover.py clones the original Docker volumes, checks contents, modes and ownership, and generates isolated namespaces, Retain local PVs, PVCs, Secrets and deployments. Original volumes remain untouched. The recovered image was exported from standalone containerd's moby namespace and imported into k3s containerd without starting Docker. Only the five nginx loopback upstreams were changed after health checks.

The recovery artifacts reside in /opt/erp-cicd/recruitment-signing-k8s. All 22 deployments passed readiness: four per company and two Mailpit sinks. Kubernetes-Acceptance.mjs verifies public HTTPS, non-admin accounts, foreign-account/document denial, idempotent upload and erasure without sending invitations. Kubernetes-Validate.py verifies own-database access, cross-company database/Redis denial, bound PVCs, live HR authentication for the three exact bindings and stopped Docker. Kubernetes-SmtpCheck.php verifies strict TLS and authentication without MAIL FROM, RCPT TO or DATA.

Kubernetes-CompanySinkProbe.py executes its client in a restricted temporary Kubernetes Job and permits only the HomeNet/JOC Mailpit installations. Both passed full signing, signed-PDF retrieval, whole-document cryptographic verification and erasure. The three previously authorized production setup invitations were delivered to the approved recruitment mailboxes. Their exact setup-only provider workflows have since been erased to prevent reminders; inbox receipt evidence is preserved. Do not resend them as part of a health check.

Sanitized server evidence:

- recovery-complete.json: recovery and readiness.
- acceptance.json: five-company provider acceptance.
- runtime-validation.json: network isolation and HR bindings.
- setup-cleanup.json: exact authorized setup-workflow cleanup.
- image-vulnerabilities.json: original rollback-image findings.
- alpine-candidate-2c12f7c79ecc9bcc/scan-results/receipt.json: exact candidate scan in Kubernetes.
- alpine-candidate-2c12f7c79ecc9bcc/advisory-review.json: retained findings and source hashes.
- alpine-candidate-2c12f7c79ecc9bcc/web-container-qualification.json: actual nonroot, read-only web sidecar evidence.
- alpine-rollout/batch-progress.json: all five company runtime acceptance results.
- alpine-rollout/<company>/: rollback snapshots, HTTPS and signing/SMTP receipts.

Generated company manifests contain Secrets and are mode 0600. Never print, commit or attach their contents. Live volumes are under /var/lib/erp-recruitment-signing/<company-uuid>.

## DAM backups and recovery

The owner selected DAM as the backup destination. Kubernetes-Backup.py captures a consistent PostgreSQL dump, the complete Nextcloud tree (including signing keys), company runtime configuration and that company's HR app credential. It pauses cron, enables maintenance, drains the app, captures the snapshot, then restores the app and cron in a finally block. Only one company is paused at a time. Redis is disposable and is initialized fresh during recovery.

Backup-Crypto.mjs encrypts each archive with a new 256-bit AES-GCM key and an authenticated, versioned envelope. Local decrypt-and-hash verification precedes plaintext deletion. Ciphertext is split into 64 MiB assets to remain below DAM's 100 MiB upload limit. The separate recovery-key asset contains binary key bytes; it has a different protected parent capability. This is protection through DAM access control, not independent key escrow outside DAM.

Dam-Backup-Transfer.mjs runs inside the HR pod so its signing key never leaves the pod. It uses short-lived EdDSA tenant and parent capabilities, supported OTHER parent types, private INHERITED policy, presigned multipart PUTs directly to the approved R2 endpoint, CLEAN scan admission and downloaded-content checksums. HR authorization is never forwarded to object storage. Completed parts are checkpointed and retries reconcile uncertain completion. Recovery keys and archives are not public assets. The live synthetic probe verified foreign-tenant, foreign-parent, absent/expired capability and anonymous access denial.

Kubernetes-DamBackup.py uploads and independently retrieves the recovery manifest, key and ciphertext from DAM. Kubernetes-RestoreProbe.py restores that retrieved database and application into an isolated temporary namespace with no public service and denied external ingress/egress. It checks database restoration and Nextcloud status, records results, and deletes only its owned probe namespace. It sends no public mail.

Run from the protected server directory after copying the matching scripts there:

~~~bash
python3 Kubernetes-BackupAll.py --index /opt/erp-cicd/recruitment-signing-k8s/backups/<unique-run>.json
~~~

The first five-company capture/upload/restore run passed with state FIVE_COMPANY_DAM_RESTORE_VERIFIED in first-dam-backup-20261023.json. All five company databases and applications restored from independently retrieved DAM bytes. The daily timer is active; retention deletion remains disabled. Backups depend on continued access to DAM, its catalog and its protected R2 configuration; DAM's own catalog backup, independent recovery credentials, immutable storage policy, RPO and RTO are separate operational requirements and have not been certified by these tests.

## HR integration and activation

HR reads /run/secrets/libresign/hr-libresign.json through HR_LIBRESIGN_CONFIG_FILE. Each entry contains its own HTTPS base URL, non-admin username and protected app-password-file path. Never share a provider account between companies. New recruitment source and feature activation remain separate from provider availability.

Onboarding uses DAM's /v1/uploads multipart API and a protected OTHER parent named hr-onboarding:<checklist-id>. Configure HR_DAM_UPLOAD_HOSTS and HR_DAM_DOWNLOAD_HOSTS with the exact approved HTTPS object hosts before activating document workflows. The current DAM quarantine and secure hosts are erp-media-bucket.c0d732db6a999137ce6774dc169d7d08.r2.cloudflarestorage.com and erp-secure.c0d732db6a999137ce6774dc169d7d08.r2.cloudflarestorage.com. Do not use a wildcard.

The offer signature worker reconciles uncertain creates by stable provider identity, verifies signed bytes in DAM before accepting an offer, and continues cleanup with new signing disabled. It never reads a candidate verification code in production. Company templates record immutable policy versions and preserve approved compensation and terms. Apply the reviewed contracts, migrations, services, RBAC and frontend changes before staged flag activation; see ../../docs/RECRUITMENT-ROLLOUT-RUNBOOK.md.


### Active routine backup service

The first-run index confirms Trusoft, BOC, HomeVision, HomeNet and JOC database/application restores. The service and timer are installed and enabled. First scheduled run: 2026-10-24 02:30:48 Pakistan time; activation did not run a catch-up backup.

Install Kubernetes-BackupSchedule.py, KubernetesBackupLock.py and KubernetesBackupSignals.py together with the updated BackupAll, Backup, DamBackup and RestoreProbe scripts. The signing singleton lock excludes concurrent manual and scheduled coordinators. Both also acquire Interior’s existing /opt/erp-cicd/interior-readiness-20261022/private/monthly-restore.lock for the full batch, preserving its inode and permissions, so monthly WAL recovery cannot overlap. A missing shared lock fails closed. SIGTERM requests let capture/restore children finish their finally cleanup before parents exit; interrupted runs retain their durable receipts and resume the same index. Four isolated Linux tests cover both lock boundaries, group cancellation cleanup/no automatic retry, and exact-five-company freshness.

The service is limited to 75% host CPU and 1 GiB memory; it stops after 6 hours with up to 5 minutes for cleanup. Its timer is 02:30 Asia/Karachi with up to 10 minutes jitter and Persistent=false, avoiding missed-run catch-up. A verified run less than 20 hours old is reused when no scheduled run is pending. A 30 GiB free-space check refuses a new capture before maintenance. Prior backups are never automatically deleted.

Operator checks after installation:

```sh
systemctl status recruitment-dam-backup.timer recruitment-dam-backup.service
python3 /opt/erp-cicd/recruitment-signing-k8s/Kubernetes-BackupSchedule.py --check
cat /opt/erp-cicd/recruitment-signing-k8s/backups/latest-dam-backup.json
```

The freshness check exits nonzero if no complete five-company restore is newer than 36 hours or fewer than 30 GiB remain. A PASS verifies the company backups; it does not certify the separate DAM catalogue/disaster-recovery requirements above.
