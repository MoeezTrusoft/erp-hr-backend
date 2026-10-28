import test from "node:test";
import assert from "node:assert/strict";
import {
  releasedDistribution,
  cycleMetricsCsv,
} from "../../src/services/appraisals/metrics.js";

test("Distribution suppression prevents a small rating group being recovered from totals", async () => {
  const result = await releasedDistribution(
    {
      $queryRaw: async () => [
        { stage: "CALCULATED", band: "Effective", count: 20 },
        { stage: "RELEASED", band: "Effective", count: 19 },
        { stage: "RELEASED", band: "Developing", count: 1 },
      ],
    },
    "tenant",
    "cycle",
  );
  assert.equal(result.population, 20);
  assert.equal(result.suppressed, true);
  assert.deepEqual(result.bands, []);
  assert.equal(result.potential.available, false);
});

test("A sufficiently populated cohort retains calculated and released bands without invented potential", async () => {
  const rows = [
    { stage: "CALCULATED", band: "Effective", count: 10 },
    { stage: "RELEASED", band: "Effective", count: 5 },
    { stage: "RELEASED", band: "Developing", count: 5 },
  ];
  const result = await releasedDistribution(
    { $queryRaw: async () => rows },
    "tenant",
    "cycle",
  );
  assert.equal(result.suppressed, false);
  assert.deepEqual(result.bands, rows);
});

test("CSV quotes and neutralises untrusted rubric labels while preserving non-ASCII text", () => {
  const content = cycleMetricsCsv({
    cycleId: "cycle",
    metricVersion: 2,
    asOf: new Date("2026-10-26T00:00:00Z"),
    states: [],
    distribution: {
      suppressed: false,
      basis: "Released",
      bands: [
        { stage: "RELEASED", band: '=HYPERLINK("bad")', count: 5 },
        { stage: "RELEASED", band: "\t@SUM(1)", count: 5 },
        { stage: "RELEASED", band: "کارکردگی, اچھی", count: 5 },
      ],
    },
  });
  assert.ok(content.startsWith("\uFEFF"));
  assert.ok(content.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(content.includes('"\'\t@SUM(1)"'));
  assert.ok(content.includes('"کارکردگی, اچھی"'));
});
