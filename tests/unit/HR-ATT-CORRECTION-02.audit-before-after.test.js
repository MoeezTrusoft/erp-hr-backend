// Corrections append immutable evidence and retain earlier evaluation revisions.
import { describe, it, expect } from '@jest/globals';
import { evaluationDb, evaluate, TENANT, DATE } from '../helpers/evaluationDb.js';
import { applyMissingTime as enterRuleTime } from '../../src/services/attendanceRules.service.js';
const user = { tenantId: TENANT, userId: 'hr-2', employeeId: 2, roles: ['HR'] };
describe('HR missing-time audit', () => {
  it('retains original evaluation and device evidence, attributing the added time', async () => {
    const db = evaluationDb({ punches: [['09:41', 0]] });
    await evaluate(db);
    const before = db.snapshot();
    await enterRuleTime({ user, employeeId: 1, date: DATE, checkOut: '17:00',
      version: 1, reason: 'Verified signed checkout register' }, db);
    const after = db.snapshot();
    expect(after.attendanceDevicePunch).toEqual(before.attendanceDevicePunch);
    expect(after.attendanceEvaluation).toHaveLength(2);
    expect(after.attendanceEvaluation[0]).toEqual(before.attendanceEvaluation[0]);
    expect(after.attendanceManualTime[0]).toMatchObject({ direction: 'OUT',
      actorId: 'hr-2', reason: 'Verified signed checkout register' });
    expect(after.attendanceRuleAudit.find(a => a.action === 'MANUAL_TIME_ENTERED')).toMatchObject({
      actorId: 'hr-2', employeeId: 1, data: { direction: 'OUT', reason: 'Verified signed checkout register' },
    });
    expect(after.attendance[0].check_in).toEqual(before.attendanceDevicePunch[0].punchedAt);
    expect(after.attendance[0].day_credit).toBeNull(); // Lateness still awaits Management.
  });
});
