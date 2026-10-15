import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||=
  "postgresql://assessment_test_user@127.0.0.1:55439/hr_task_assessment_test";
const { aggregateForecast } =
  await import("../../src/services/assessment/forecast.js");
const horizons = [
  { days: 0, at: "2026-10-15T00:00:00Z" },
  { days: 90, at: "2027-01-13T00:00:00Z" },
];
const task = {
    taskCode: "API",
    taskVersion: 1,
    complexity: "ROUTINE",
    technology: "NODE",
    scope: "API",
  },
  requirement = {
    taskCode: "API",
    taskVersion: 1,
    requiredK: 3,
    requiredS: 3,
    prerequisites: [],
  };
const person = {
  employeeCode: "TEST-001",
  restrictions: [],
  renewals: [{ taskCodes: ["API"], dueAt: "2026-12-01T00:00:00Z" }],
  capabilities: ["K", "S"].map((dimension) => ({
    taskCode: "API",
    taskVersion: 1,
    scopeKey: "ROUTINE|NODE|API",
    dimension,
    status: "CURRENT",
    score: 3,
    expiresAt: "2026-11-01T00:00:00Z",
  })),
  windows: horizons.map((h) => ({
    days: h.days,
    profile: { requirements: [requirement] },
    tasks: [task],
    credentials: [],
    sites: ["HQ"],
    availableSites: ["HQ"],
    calendarUnconfirmed: false,
  })),
};
test("Forecast counts people once per task and does not assume a scheduled renewal will pass", () => {
  const rows = aggregateForecast([person], horizons),
    current = rows.find((r) => r.days === 0),
    future = rows.find((r) => r.days === 90);
  assert.equal(current.employees, 1);
  assert.equal(current.eligible, 1);
  assert.equal(current.calendarAvailable, 1);
  assert.equal(future.eligible, 0);
  assert.equal(future.expiredEvidence, 1);
  assert.equal(future.scheduledRenewals, 1);
  assert.equal(JSON.stringify(rows).includes("TEST-001"), false);
});
test("Restrictions and absent evidence stay separate; availability is specific to the site", () => {
  const changed = structuredClone(person);
  changed.restrictions = [{ taskCode: "API", liftedAt: null }];
  let row = aggregateForecast([changed], horizons).find((r) => r.days === 0);
  assert.equal(row.eligible, 0);
  assert.equal(row.restricted, 1);
  changed.restrictions = [];
  changed.capabilities = [];
  row = aggregateForecast([changed], horizons).find((r) => r.days === 0);
  assert.equal(row.pendingEvidence, 1);
  changed.capabilities = person.capabilities;
  changed.windows[0].sites = ["HQ", "SITE"];
  row = aggregateForecast([changed], horizons).find(
    (r) => r.days === 0 && r.site === "SITE",
  );
  assert.equal(row.calendarAvailable, 0);
});
