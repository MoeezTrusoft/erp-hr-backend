# Public attendance automation

The public ERP is the attendance calculation authority. Its five imported company
setups must be published and pass readiness before enabling
`ATTENDANCE_CAPTURE_WORKER_ENABLED=true`. Keep the Kubernetes source worker and
the backend's optional single-device listener disabled when external collectors
already own device connections.

The finalization planner uses the release's local calendar date, including the
first hours of a new release before UTC midnight. Publishing queues work through
the current local date. The normal worker plans dates, retries failed jobs,
reconciles identities and monitors device health. Missing data and protected
payroll periods remain held. Published configuration expires at its reviewed
coverage date; prepare the next calendar period before that date.

The attendance writer explicitly recognizes transactions opened by the tenant
helper. Some extended Prisma transaction clients still expose `$transaction`;
testing that property alone recursively opens transactions until they expire.
Worker evaluation must reuse the transaction already holding its locks.

## Existing device collectors

The CSV collector remains responsible for read-only ZKTeco hardware polling and
local raw CSV retention. Run `scripts/attendance_csv_bridge.py` as its ERP bridge
with these environment settings:

- `BIO_BASE_DIR`: the existing collector directory containing `data/` and `state/`.
- `ERP_INTAKE_URL`: the public HTTPS `/device-attendance/iclock-ingest` endpoint.
- `ERP_INTAKE_KEY`: the retained credential, supplied by the protected service environment.
- `ERP_DEVICE_SERIALS`: comma-separated approved device serial numbers.
- `ERP_START_DATE`: the reviewed first operating date, in `YYYY-MM-DD` form.
- `ERP_BRIDGE_STATE`: a dedicated destination checkpoint file.
- `BRIDGE_PUSH_SECONDS`: defaults to 30 seconds.

Checkpoint by appended CSV rows, not punch timestamps. Delayed uploads older than
the last delivered punch are included. Persist each acknowledged batch atomically;
on failure leave its checkpoint unchanged and retry. Reject changed historical
CSV prefixes for operator review. The HR receiver deduplicates retried punches.
Only a collector poll completed in the last 120 seconds refreshes device health;
old CSV data cannot keep a disconnected device healthy.

For the existing ADMS receiver, run `scripts/attendance_adms_adapter.py` with
`ICLOCK_LEGACY_SCRIPT` pointing to its retained Python implementation,
`HR_INGEST_URL`, `HR_INTAKE_KEY`, `ERP_DEVICE_SERIALS` and optional `ICLOCK_PORT`
(default 8090). Keep both adapter Python files together. Registered device polls
send throttled heartbeats; the original receiver still acknowledges punches only
after the HR endpoint confirms durable storage. Unknown serials and oversized
uploads are rejected. This preserves the existing native-device trust boundary;
serial checks are not liveness detection or cryptographic hardware identity.

Before switching destinations, back up the database, service environment, unit
overrides, legacy receiver and bridge checkpoints. Verify credentials with an
empty intake batch (expected 400 after authentication; no punch is inserted).
Validate collector snapshots and live device polls, then verify fresh heartbeats
in the public database. Preserve raw records and the old checkpoint during rollback.

## Verification

Run `python -m unittest discover -s scripts -p test_attendance_csv_bridge.py` and
the attendance evaluation/setup/capture-worker unit suites. Before production
activation, rehearse the planner and evaluator against a current database copy;
confirm local-date jobs, source-company scope, published snapshot readiness,
device data holds and unchanged existing employee/payroll history. After rollout,
check worker retries, current-date job states, all three device heartbeats and
gateway operations. Never use fabricated employee punches as a live test.
