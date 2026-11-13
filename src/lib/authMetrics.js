// src/lib/authMetrics.js — A-HR-SERVICE-JWT-INBOUND.
//
// Single Prometheus counter so operators can watch the X-Internal-Secret
// → service-JWT migration without grepping logs. Naming and label
// allowlist mirror the RBAC reference implementation
// (erp-rbac-backend/src/lib/authMetrics.js) so dashboards and alert
// queries are identical across services:
//
//   auth_internal_boundary_total{ source, outcome }
//
//   * source=service-jwt,   outcome=accept   — valid service JWT accepted
//   * source=legacy-secret, outcome=accept   — transitional X-Internal-Secret
//                                              accepted (this is the line
//                                              we want to see go to zero
//                                              for ≥14 days before sunset)
//   * source=anonymous,     outcome=reject   — no credentials presented
//   * source=rejected,      outcome=reject   — credentials presented but
//                                              rejected (tampered/expired/
//                                              wrong-aud JWT, wrong legacy
//                                              value, prod fail-closed)
//
// Allowed label values are pinned to a small allowlist so this counter
// can never blow up label cardinality — a stray value would otherwise
// let one noisy caller exhaust the metric store. Bad inputs collapse to
// `source=none` / `outcome=reject` rather than throwing, so a metrics
// registry hiccup never derails the boundary check.
//
// Forbidden:
//   * Never label with raw token text.
//   * Never label with raw error messages.
//   * Never label with email / userId / tenantId / IP / any per-request value.

import client from 'prom-client';

const INTERNAL_BOUNDARY_METRIC_NAME = 'auth_internal_boundary_total';

const INTERNAL_BOUNDARY_SOURCE_ALLOWED = new Set([
    'service-jwt',
    'legacy-secret',
    'anonymous',
    'rejected',
    'none',
]);
const INTERNAL_BOUNDARY_OUTCOME_ALLOWED = new Set(['accept', 'reject']);

function normalizeInternalBoundarySource(v) {
    return INTERNAL_BOUNDARY_SOURCE_ALLOWED.has(v) ? v : 'none';
}
function normalizeInternalBoundaryOutcome(v) {
    return INTERNAL_BOUNDARY_OUTCOME_ALLOWED.has(v) ? v : 'reject';
}

// --- Auth-cutover accept counters --------------------------------------
// Two per-service accept counters that split the boundary "accept" signal
// by credential type so the X-Internal-Secret → service-JWT cutover is
// observable per service. These mirror the boundary counter's
// re-registration safety (getSingleMetric-on-default-registry-first) so a
// double-import / hot-reload does not throw.
//
//   service_jwt_accept_total{ service }    — valid service JWT accepted
//   legacy_secret_accept_total{ service }  — transitional X-Internal-Secret
//                                            accepted (drive this to zero
//                                            before the legacy sunset)
//
// Both are initialized with .inc({ service: 'hr' }, 0) at module load so
// they are exported with value 0 on /metrics before any traffic.
const SERVICE_JWT_ACCEPT_METRIC_NAME = 'service_jwt_accept_total';
const LEGACY_SECRET_ACCEPT_METRIC_NAME = 'legacy_secret_accept_total';

function buildServiceJwtAcceptCounter() {
    return new client.Counter({
        name: SERVICE_JWT_ACCEPT_METRIC_NAME,
        help: 'service-JWT accepts',
        labelNames: ['service'],
    });
}

function buildLegacySecretAcceptCounter() {
    return new client.Counter({
        name: LEGACY_SECRET_ACCEPT_METRIC_NAME,
        help: 'legacy X-Internal-Secret accepts',
        labelNames: ['service'],
    });
}

let _serviceJwtAcceptCounter = null;
function serviceJwtAcceptCounter() {
    if (_serviceJwtAcceptCounter === null) {
        _serviceJwtAcceptCounter =
            client.register.getSingleMetric(SERVICE_JWT_ACCEPT_METRIC_NAME) ||
            buildServiceJwtAcceptCounter();
        // Materialize the {service:'hr'} child at value 0 so it is present
        // on /metrics before the first accept.
        try {
            _serviceJwtAcceptCounter.inc({ service: 'hr' }, 0);
        } catch {
            // Counter already seeded on a prior import; nothing to do.
        }
    }
    return _serviceJwtAcceptCounter;
}

let _legacySecretAcceptCounter = null;
function legacySecretAcceptCounter() {
    if (_legacySecretAcceptCounter === null) {
        _legacySecretAcceptCounter =
            client.register.getSingleMetric(LEGACY_SECRET_ACCEPT_METRIC_NAME) ||
            buildLegacySecretAcceptCounter();
        try {
            _legacySecretAcceptCounter.inc({ service: 'hr' }, 0);
        } catch {
            // Counter already seeded on a prior import; nothing to do.
        }
    }
    return _legacySecretAcceptCounter;
}

export function recordServiceJwtAccept(service = 'hr') {
    try {
        serviceJwtAcceptCounter().inc({ service });
    } catch {
        // Never derail the boundary check on a metrics registry hiccup.
    }
}

export function recordLegacySecretAccept(service = 'hr') {
    try {
        legacySecretAcceptCounter().inc({ service });
    } catch {
        // Never derail the boundary check on a metrics registry hiccup.
    }
}

export const SERVICE_JWT_ACCEPT_METRIC = SERVICE_JWT_ACCEPT_METRIC_NAME;
export const LEGACY_SECRET_ACCEPT_METRIC = LEGACY_SECRET_ACCEPT_METRIC_NAME;

function buildInternalBoundaryCounter() {
    return new client.Counter({
        name: INTERNAL_BOUNDARY_METRIC_NAME,
        help: 'Outcomes of the internal-service boundary guard, labeled by credential source and accept/reject. Drives the X-Internal-Secret sunset readiness.',
        labelNames: ['source', 'outcome'],
    });
}

// Re-registration safety: in Jest, the test module graph may be evaluated
// multiple times across suites. We look the counter up on the default
// registry by name first so re-registration doesn't throw.
let _internalBoundaryCounter = null;
function internalBoundaryCounter() {
    if (_internalBoundaryCounter === null) {
        _internalBoundaryCounter =
            client.register.getSingleMetric(INTERNAL_BOUNDARY_METRIC_NAME) ||
            buildInternalBoundaryCounter();
    }
    return _internalBoundaryCounter;
}

export function recordInternalBoundary({ source, outcome } = {}) {
    try {
        internalBoundaryCounter().inc({
            source: normalizeInternalBoundarySource(source),
            outcome: normalizeInternalBoundaryOutcome(outcome),
        });
    } catch {
        // Never derail the boundary check on a metrics registry hiccup.
    }
}

// Attach the internal-boundary counter to a caller-supplied private
// Registry so the HR /metrics endpoint (which reads from a private
// registry per createApp() call) can expose it alongside whatever else
// the app registers locally. Idempotent: re-attaching the same counter
// to the same registry is a no-op.
export function attachInternalBoundaryMetric(register) {
    if (!register || typeof register.registerMetric !== 'function') return;
    attachOne(register, INTERNAL_BOUNDARY_METRIC_NAME, internalBoundaryCounter);
    attachOne(register, SERVICE_JWT_ACCEPT_METRIC_NAME, serviceJwtAcceptCounter);
    attachOne(register, LEGACY_SECRET_ACCEPT_METRIC_NAME, legacySecretAcceptCounter);
}

// Idempotently attach a counter to a private registry: skip if a metric of
// the same name is already present, swallow a races/double-register throw.
function attachOne(register, name, counterFactory) {
    const already = register.getSingleMetric && register.getSingleMetric(name);
    if (already) return;
    try {
        register.registerMetric(counterFactory());
    } catch {
        // Already registered on this registry; nothing to do.
    }
}

export const INTERNAL_BOUNDARY_METRIC = INTERNAL_BOUNDARY_METRIC_NAME;

// Exposed for tests that want to start from a clean registry between
// suites without having to reach into prom-client internals.
export function _resetAuthMetricsForTests() {
    client.register.removeSingleMetric(INTERNAL_BOUNDARY_METRIC_NAME);
    client.register.removeSingleMetric(SERVICE_JWT_ACCEPT_METRIC_NAME);
    client.register.removeSingleMetric(LEGACY_SECRET_ACCEPT_METRIC_NAME);
    _internalBoundaryCounter = null;
    _serviceJwtAcceptCounter = null;
    _legacySecretAcceptCounter = null;
}
