// CI database probes must fail when setup failed, never silently return green.
// Ordinary local suites retain their existing optional-database behavior.
import assert from 'node:assert/strict';

export function assertRequiredDatabaseReady(ready, env = process.env) {
    if (env.CROSS_SERVICE_DISPOSABLE !== '1') return;
    const url = new URL(env.DATABASE_URL);
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/hr_regression_test');
    assert.equal(ready, true, 'Mandatory HR database fixture did not initialize; no database assertions may be skipped');
}
