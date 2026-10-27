# Recruitment automation monitoring

Attachment sections 13.1 and 14 require the seven existing rollout counters and automation counters. This source is prepared for Kubernetes qualification; it has not been deployed or scraped in production.

The existing HR /metrics registry attaches all families. The BullMQ processor observes all 25 recruitment, assessment, candidate-retention and application-draft tasks. A unit inventory check detects a new schedule missing from this bounded list. Unrelated HR jobs do not enter recruitment metrics. Each attempt records started, completed, skipped or failed, elapsed seconds and its last finish time. Completed means the batch returned, not that every row succeeded. Retried attempts count separately.

Completed delivery, scoring and calendar batches contribute bounded outcome counts. Communication accepted means Notification Hub accepted the request; it does not prove transport delivery or candidate receipt. Company signing invitation receipts are separate evidence. Calendar outcomes distinguish interview and onboarding reconciliation. Scoring counts a row only after its transaction commits; communication counts a final result only while the same claim is still owned.

The four alert counter families initialize all 112 finite supported label combinations to zero when registered, without resetting existing values. This supplies a baseline for the first event after healthy scrapes, following [Prometheus instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/#avoid-missing-metrics). An event before the first scrape still has no observed zero baseline; counter-based alerts cannot recover that event reliably. Database state and provider receipts must cover that unavoidable limitation.

Counters are operational, process-local and best effort. A crash or exception midway through a batch can omit row-level counts; the failed scheduler attempt remains visible if it can be recorded. They are not audit ledgers. Authoritative workflow state and provider receipts remain in the database. No labels contain company IDs, candidate IDs, email, request text, error messages or arbitrary job names. The task label avoids collision with Prometheus's target job label. Transition and denial labels accept only finite known codes.

## Qualification and installation

1. In the existing Kubernetes qualification lane, run the observability suite plan, full HR tests/lint/boundaries and real HTTP /metrics scrape. Include the worker process in scraping if production separates it from the API.
2. Pin the operator-approved Prometheus/promtool image. Run promtool check rules deploy/monitoring/recruitment.rules.json and promtool test rules deploy/monitoring/recruitment.rules.test.json in that cluster. These JSON documents are YAML-compatible. Do not install a new monitoring stack for this change.
3. Add recruitment.rules.json to the existing Prometheus rule_files or its operator-equivalent resource after staged replay passes. Configure the approved Alertmanager receiver. External receiver tests require separate authorization.
4. Verify all seven original counter families and six automation families on the actual scrape target. Exercise success, provider failure, cancellation, flag skip and scheduler retry with synthetic data. Retain scrape/alert evidence and scoped queue reconciliation.
5. Capture staging observation and existing platform worker/target liveness. The stall rule watches previously active frequent tasks; it cannot detect an exporter that vanished or a worker that never started. Daily tasks require platform scheduling checks against their actual cadence. Existing platform alerts must cover these cases before go-live.

Rules ship warning thresholds: any scheduler or terminal communication failure persisting five minutes, five scoring failures in fifteen minutes persisting five minutes, five calendar retries in fifteen minutes persisting ten minutes, and no finish for ten minutes on a previously active frequent task persisting five minutes. The operations owner may tune these against the baseline. Source inspection asserts no successful alert or live counter value.

## Operator response

Use the task or calendar kind to locate correlated structured logs and the company-scoped recovery queue. Verify dependencies, schema, provider health and immutable request identity. Respect backoff, privacy cancellation and transaction ownership. A queue acknowledgement is not evidence of candidate delivery. Retry only through existing authorized recovery actions; never change tenant ownership, loosen TLS checks or mark records completed by hand.

Rollback removes these rules and the telemetry release. Workflow switches remain the existing per-feature controls; monitoring introduces no schema change or destructive cleanup.
