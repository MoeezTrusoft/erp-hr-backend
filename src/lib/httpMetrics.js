// src/lib/httpMetrics.js — A-RED
// audit-reports/08-sota-roadmap.md DO-NOW #2 (RED + USE dashboards): a
// per-service http_request_duration_seconds histogram so Prometheus/Grafana
// can compute Rate / Error / p95 per route. Mirrors the gateway
// gw_mcp_upstream_duration_seconds pattern (idempotent getOrCreate, bounded
// labels) and the HR attachInternalBoundaryMetric pattern (a single shared
// metric attached onto each per-createApp() private Registry).
//
// PURELY observational: the middleware wraps res' "finish"/"close" events to
// observe the elapsed time. It never reads/writes the body, never short-
// circuits, never touches auth/tenancy, and always calls next(). A metrics
// hiccup is swallowed so the request path is never derailed.
//
// HR serves /metrics from a private Registry built per createApp() (no default
// labels), so the histogram carries an explicit service="hr" label. The
// histogram itself is a process-wide singleton (looked up on the default
// registry first for Jest re-import safety) and is ATTACHED onto each per-app
// register via attachHttpRequestDurationMetric(register) so /metrics exposes it.

import client from 'prom-client';

const METRIC_NAME = 'http_request_duration_seconds';
const SERVICE_LABEL = 'hr';

// Standard RED latency buckets (seconds) — same shape the gateway uses.
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function buildHistogram() {
    return new client.Histogram({
        name: METRIC_NAME,
        help: 'Duration in seconds of inbound HTTP requests, labeled by method, matched route, and status_code.',
        labelNames: ['service', 'method', 'route', 'status_code'],
        buckets: BUCKETS,
    });
}

// Process-wide singleton. Re-registration safety: in Jest the module graph may
// be evaluated multiple times across suites, so look the histogram up on the
// default registry by name first.
let _histogram = null;
function histogram() {
    if (_histogram === null) {
        _histogram =
            client.register.getSingleMetric(METRIC_NAME) || buildHistogram();
    }
    return _histogram;
}

// Resolve a BOUNDED route label. Prefer the Express-matched route pattern
// (req.baseUrl + req.route.path, e.g. "/api/employee/:id") so path params
// collapse to one series; otherwise "unmatched" so random/404 paths can never
// explode label cardinality.
export function resolveRouteLabel(req) {
    const routePath = req?.route?.path;
    if (typeof routePath === 'string' && routePath.length > 0) {
        const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
        const full = `${base}${routePath}`;
        return full.length > 0 ? full : routePath;
    }
    return 'unmatched';
}

// Express middleware: observe inbound request duration into the shared
// histogram. Mount BEFORE the route tree so res.on('finish') fires after the
// handler completes.
export function createHttpMetricsMiddleware() {
    const h = histogram();
    return function httpMetricsMiddleware(req, res, next) {
        const startNs = process.hrtime.bigint();
        let observed = false;

        const observe = () => {
            if (observed) return;
            observed = true;
            try {
                const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1e9;
                h.observe(
                    {
                        service: SERVICE_LABEL,
                        method: req.method,
                        route: resolveRouteLabel(req),
                        status_code: String(res.statusCode),
                    },
                    elapsedSec,
                );
            } catch {
                // Never derail the request on a metrics-registry hiccup.
            }
        };

        res.on('finish', observe);
        res.on('close', observe);

        next();
    };
}

// Attach the shared histogram onto a per-app private Registry so the HR
// /metrics endpoint (which reads from a private registry per createApp() call)
// exposes it. Idempotent: skip if already present; swallow a race/double-
// register throw. Mirrors attachInternalBoundaryMetric in authMetrics.js.
export function attachHttpRequestDurationMetric(register) {
    if (!register || typeof register.registerMetric !== 'function') return;
    const already = register.getSingleMetric && register.getSingleMetric(METRIC_NAME);
    if (already) return;
    try {
        register.registerMetric(histogram());
    } catch {
        // Already registered on this registry; nothing to do.
    }
}

export const HTTP_REQUEST_DURATION_METRIC = METRIC_NAME;

// Test seam: drop the singleton so a suite can start from a clean registry.
export function _resetHttpMetricsForTests() {
    client.register.removeSingleMetric(METRIC_NAME);
    _histogram = null;
}
