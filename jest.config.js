// jest.config.js (project root)
//
// This is the config Jest actually reads -- the older
// `tests/jest.config.js` sits at a path Jest does not auto-discover and
// is effectively dead. We keep this file deliberately minimal so the
// default Jest behaviour the suite currently depends on is preserved
// (testMatch, transformer, default timeout). The only thing we add is
// a `testPathIgnorePatterns` entry that keeps wall-clock performance
// suites (filename ends in `.performance.test.js`) out of the default
// `npm test` / `gate:p1` runs.
//
// To exercise the perf suites, use `npm run test:perf` (declared in
// package.json). That script overrides this `testPathIgnorePatterns`
// on the CLI so the perf files run.
export default {
    testPathIgnorePatterns: [
        '/node_modules/',
        '\\.performance\\.test\\.js$',
    ],
};
