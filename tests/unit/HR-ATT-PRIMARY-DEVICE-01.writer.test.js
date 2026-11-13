// HR-ATT-PRIMARY-DEVICE-01 — the day's provenance rule, as pure arithmetic.
//
// The writer folds session punches into two fields on the Attendance row:
// primary_sn (the employee's primary device for the period) and
// secondary_punches (punches that arrived on any OTHER device). The subtlety
// the tests pin down: NULL/0 means "no primary assigned" — unmarked — and must
// never be confused with "all punches were on the primary".
import { describe, it, expect } from '@jest/globals';

const { computePrimaryProvenance } = await import(
  '../../src/services/attendanceWriter.service.js'
);

describe('HR-ATT-PRIMARY-DEVICE-01 computePrimaryProvenance', () => {
  it('counts punches on other devices, position-aligned with the session', async () => {
    // Check-in at Johar, check-out at Dalmia — the cross-site day, credited
    // normally but explicitly recorded.
    const out = computePrimaryProvenance({
      primarySn: 'EUF7243800353',
      punchSn: ['EUF7243800353', 'A8LN181960262'],
    });
    expect(out).toEqual({
      primary_sn: 'EUF7243800353',
      secondary_punches: 1,
    });
  });

  it('treats an all-primary day as zero secondaries', async () => {
    const out = computePrimaryProvenance({
      primarySn: 'EUF7243800353',
      punchSn: ['EUF7243800353', 'EUF7243800353', 'EUF7243800353'],
    });
    expect(out).toEqual({ primary_sn: 'EUF7243800353', secondary_punches: 0 });
  });

  it('leaves the row unmarked when no primary is assigned', async () => {
    // NULL/0 = unmarked, NOT "all primary". The writer skips the fields
    // entirely so the stored row keeps its previous (null) state.
    expect(computePrimaryProvenance({ primarySn: null, punchSn: ['X', 'Y'] })).toEqual({});
    expect(computePrimaryProvenance({ primarySn: undefined, punchSn: [] })).toEqual({});
  });

  it('ignores punches with a missing serial when counting secondaries', async () => {
    // punchSn entries are nullable (the column allows it); a null serial is
    // neither primary nor secondary — it is unknown provenance.
    const out = computePrimaryProvenance({
      primarySn: 'A',
      punchSn: ['A', null, 'B', null],
    });
    expect(out).toEqual({ primary_sn: 'A', secondary_punches: 1 });
  });

  it('stamps primary_sn even on a day with no punches recorded in the session', async () => {
    const out = computePrimaryProvenance({ primarySn: 'A', punchSn: [] });
    expect(out).toEqual({ primary_sn: 'A', secondary_punches: 0 });
  });
});
