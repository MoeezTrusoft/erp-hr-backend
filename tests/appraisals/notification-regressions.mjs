import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchReminders } from '../../src/services/appraisals/notifications.js';

export async function notificationRegressions(t, { tenant, other, people, db, admin, reviewId }) {
  const review = await db(tx => tx.perfReview.findFirst({ where: { id: reviewId, tenantId: tenant } }));
  const create = (stage, changes = {}) => db(tx => tx.perfReminderIntent.create({ data: {
    tenantId: tenant, reviewId, recipientId: people.EMPLOYEE.id,
    scheduleVersion: review.scheduleVersion, stage, dueAt: review.selfDue, ...changes,
  } }));
  const now = new Date('2028-01-01T00:00:00Z');
  await t.test('Notification acceptance survives a post-Hub database failure and concurrent replay without another logical notification', async () => {
    const intent = await create('SELF_2027-06-01');
    const logical = new Map();
    const deliver = async input => {
      assert.equal(input.tenantId, tenant);
      assert.equal(input.userId, people.EMPLOYEE.userId);
      if (!logical.has(input.intentId)) logical.set(input.intentId, randomUUID());
      return { notificationId: logical.get(input.intentId) };
    };
    await admin.query(`CREATE FUNCTION appraisal_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId"='${tenant}'::uuid AND NEW.state='ACCEPTED' THEN RAISE EXCEPTION 'simulated receipt persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER appraisal_test_fail_receipt BEFORE UPDATE ON "PerfReminderIntent" FOR EACH ROW EXECUTE FUNCTION appraisal_test_fail_receipt()`);
    try {
      assert.equal((await dispatchReminders(tenant, { deliver, now })).failed, 1);
      assert.equal((await db(tx => tx.perfReminderIntent.findFirst({ where: { id: intent.id } }))).state, 'PENDING');
    } finally {
      await admin.query('DROP TRIGGER appraisal_test_fail_receipt ON "PerfReminderIntent"; DROP FUNCTION appraisal_test_fail_receipt()');
    }
    const outcomes = await Promise.all([dispatchReminders(tenant, { deliver, now }), dispatchReminders(tenant, { deliver, now })]);
    assert.equal(outcomes.reduce((sum, value) => sum + value.accepted, 0), 1);
    assert.equal(logical.size, 1);
    const saved = await db(tx => tx.perfReminderIntent.findFirst({ where: { id: intent.id } }));
    assert.equal(saved.state, 'ACCEPTED');
    assert.equal(saved.hubReceipt, logical.get(intent.id));
  });
  await t.test('Obsolete schedules and manager reminders are cancelled, future reminders wait, and another company sends nothing', async () => {
    await create('SELF_2027-06-02', { scheduleVersion: review.scheduleVersion + 1 });
    await create('MANAGER_2027-06-02', { recipientId: people.MANAGER.id, dueAt: review.managerDue });
    await create('SELF_2027-06-03');
    let calls = 0;
    const deliver = async () => { calls++; return { notificationId: randomUUID() }; };
    const result = await dispatchReminders(tenant, { deliver, now: new Date('2026-01-01') });
    assert.equal(result.cancelled, 2);
    assert.equal(result.skipped, 1);
    await dispatchReminders(other, { deliver, now });
    assert.equal(calls, 0);
    await db(tx => tx.perfReminderIntent.updateMany({ where: { tenantId: tenant, state: 'PENDING' }, data: { state: 'CANCELLED' } }));
  });
}
