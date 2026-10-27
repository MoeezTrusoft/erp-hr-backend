import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.NODE_ENV = "test";
const { matchPracticeCandidate } =
  await import("../../src/services/assessment/development-matching.js");
const now = new Date("2026-10-15T08:00:00Z"),
  from = "2026-10-15T09:00:00Z",
  to = "2026-10-15T12:00:00Z";
const requirement = {
  taskCode: "DEV-01",
  taskVersion: 1,
  requiredK: 2,
  requiredS: 2,
  scopeKey: "NORMAL",
  supervisedAllowed: true,
  prerequisites: [],
};
const action = { payload: { taskCode: "DEV-01", taskVersion: 1 } };
const opportunity = {
  id: randomUUID(),
  status: "AVAILABLE",
  payload: {
    source: "PM",
    sourceRecordId: randomUUID(),
    sourceVersion: 1,
    occurredAt: now.toISOString(),
    validUntil: "2026-10-15T08:15:00Z",
    risk: "LOW",
    requirements: [requirement],
    from,
    to,
    minutes: 120,
    site: "HO",
    nonroutine: false,
  },
};
const person = {
  active: true,
  employeeCode: "EMP-01",
  calendarIssues: [],
  restrictions: [],
  prerequisites: [],
  intervals: [{ start: from, end: to, site: "HO" }],
  capabilities: ["K", "S"].map((dimension) => ({
    taskCode: "DEV-01",
    taskVersion: 1,
    dimension,
    scopeKey: "NORMAL",
    score: 2,
    status: "CURRENT",
    expiresAt: "2026-11-01T00:00:00Z",
  })),
};
const supervisor = {
  ...person,
  employeeCode: "EMP-02",
  capabilities: person.capabilities.map((c) => ({ ...c, score: 3 })),
};
test("practice matches scoped K/S with a qualified supervisor and intersected minutes; no V conversion", () => {
  const result = matchPracticeCandidate({
    action,
    opportunity,
    person,
    supervisor,
    now,
  });
  assert.equal(result.minutes, 120);
  assert.equal(result.earliestFinish, "2026-10-15T11:00:00.000Z");
  assert.equal(result.requiresPlannerRecheck, true);
});
test("opportunity gaps, restrictions, stale offers and unavailable supervisors cannot become work authorization", () => {
  for (const changed of [
    { person: { ...person, restrictions: [{ taskCode: "DEV-01" }] } },
    { person: { ...person, capabilities: [] } },
    { supervisor: { ...supervisor, intervals: [] } },
    { supervisor: person },
    { opportunity: { ...opportunity, status: "WITHDRAWN" } },
    { now: new Date("2026-10-15T08:16:00Z") },
    {
      opportunity: {
        ...opportunity,
        payload: { ...opportunity.payload, risk: "HIGH" },
      },
    },
    {
      opportunity: {
        ...opportunity,
        payload: {
          ...opportunity.payload,
          requirements: [{ ...requirement, scopeKey: "OTHER" }],
        },
      },
    },
  ])
    assert.equal(
      matchPracticeCandidate({
        action,
        opportunity,
        person,
        supervisor,
        now,
        ...changed,
      }),
      null,
    );
});
