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
    const counter = internalBoundaryCounter();
    const already = register.getSingleMetric &&
        register.getSingleMetric(INTERNAL_BOUNDARY_METRIC_NAME);
    if (already) return;
    try {
        register.registerMetric(counter);
    } catch {
        // Already registered on this registry; nothing to do.
    }
}

export const INTERNAL_BOUNDARY_METRIC = INTERNAL_BOUNDARY_METRIC_NAME;

// Exposed for tests that want to start from a clean registry between
// suites without having to reach into prom-client internals.
export function _resetAuthMetricsForTests() {
    client.register.removeSingleMetric(INTERNAL_BOUNDARY_METRIC_NAME);
    _internalBoundaryCounter = null;
}
