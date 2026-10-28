# Appraisal reminder delivery

The dedicated appraisal worker can dispatch durable `PerfReminderIntent` rows to Notification Hub. This is an opt-in integration; `APPRAISAL_NOTIFICATIONS_ENABLED` must equal `true`. It remains off until the tenant service account, Hub templates and acceptance checks are verified.

Required runtime configuration:

- `RBAC_SERVICE_URL`: authenticated RBAC HTTPS base URL.
- `APPRAISAL_NOTIFICATION_ENDPOINT`: Notification Hub HTTPS `/api/v1/notify` endpoint.
- `APPRAISAL_NOTIFICATION_CREDENTIALS_JSON`: secret-store supplied object keyed by tenant UUID. Each entry contains that tenant's service-account `clientId` and `clientSecret`. Never commit values.
- `APPRAISAL_TENANT_IDS`: existing explicit worker tenant allowlist.

The worker obtains a short-lived RBAC token, checks its company and expiry, resolves the employee's linked numeric RBAC user ID through `rbac_user_resolve`, and verifies the returned employee mapping before using the tenant-specific user UUID. It does not convert an employee integer into a UUID. Redirects are rejected and each dependency request has a five-second timeout.

Only in-app reminders are requested. Self and manager messages use fixed Hub templates `hr.performance.self_due` and `hr.performance.manager_due`; the notification body contains the due date, with a permission-checked workspace link. Ratings, comments, peer participation and compensation are excluded.

Before dispatch, the worker locks the review and reminder, checks the current state, schedule version, due date, cycle status, recipient employment status and reporting line. Obsolete rows become `CANCELLED`; future rows wait. Success means `ACCEPTED`, with the Hub notification UUID in `hubReceipt`, not a claim of channel delivery. The stable tenant/intent dedupe key preserves one logical notification across a crash after remote acceptance but before local commit. Failed attempts stay pending; paginated jobs prevent a failed first page from starving later reminders. The five-minute scheduler requeues pending work after a Redis outage.

Acceptance still required before enabling: real tenant service-account authorization, Hub in-app persistence and recipient preferences, deployed workspace-link access, channel receipt reconciliation, approved cadence/escalation policy, Urdu templates and operational alerting. No live notifications have been sent by development tests. This integration does not complete the full Performance Appraisals release.
