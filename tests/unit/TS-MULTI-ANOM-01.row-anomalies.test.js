// TS-MULTI-ANOM-01 — a timesheet row lists every active rules-v2 case of the day,
// each with its own request state, so cases are shown and raised individually.
import { describe, it, expect } from '@jest/globals';
import { rowAnomalies } from '../../src/lib/timesheetRowAnomalies.js';

const base = { rulesVersion: 2, evidenceState: 'ACTIVE', sourceKind: 'RULES', status: 'PENDING' };
const day = [
  { ...base, id: 12, type: 'MISSING_CHECKOUT' },
  { ...base, id: 11, type: 'LATE_CHECKIN' },
  { ...base, id: 13, type: 'EARLY_CHECKOUT', evidenceState: 'SUPERSEDED' },
  { ...base, id: 14, type: 'LATE_CHECKIN', rulesVersion: 1 },
  { ...base, id: 15, type: 'ABSENT', sourceKind: 'REGULARIZATION' },
  { ...base, id: 16, type: 'OTHER' },
];

describe('rowAnomalies', () => {
  it('keeps only active rules-v2 cases, most severe first', () => {
    expect(rowAnomalies(day).map((a) => a.id)).toEqual([12, 11]);
  });

  it('marks a case UNSUBMITTED until it has its own approval', () => {
    const out = rowAnomalies(day, {
      approvalByAnomaly: new Map([['11', { id: 'ap1', stage: 'HR' }]]),
      decisionsByAnomaly: new Map(),
    });
    expect(out.find((a) => a.id === 12).request.status).toBe('UNSUBMITTED');
    expect(out.find((a) => a.id === 12).request.anomalyId).toBe(12);
    expect(out.find((a) => a.id === 11).request).toMatchObject({ status: 'PENDING', stage: 'HR', anomalyId: 11 });
  });

  it('is empty for a clean day', () => {
    expect(rowAnomalies([])).toEqual([]);
  });
});
