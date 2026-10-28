# Temporary deepmerge security patch

Derived from upstream deepmerge 4.3.1 (`dist/cjs.js`), MIT license retained.
Upstream SHA-256: `2e5160f84a1141bd927264afe4d15766f1e6cf07daef182b37ff53fea121de7d`.

GHSA-gcqx-w48m-w2h4 has no published upstream fix as of 2026-10-28.
The three destination writes now define own data properties instead of invoking
inherited setters. This prevents both source and target prototype poisoning,
including null-prototype inputs, without changing normal arrays, symbols,
custom merging or clone behavior. Jest uses this dependency for local configuration;
it is excluded from the production image by the development dependency boundary.

The npm override resolves `deepmerge` to this reviewed local source. A registry
audit cannot assess this private patch; regression tests in
`tests/security/dependency-patches.test.mjs` provide separate evidence. Remove
the override when an upstream fixed version passes the same tests.
