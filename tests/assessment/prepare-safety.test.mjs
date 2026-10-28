import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFullHrDatabase } from '../helpers/prepareFullHrDatabase.mjs';

test('full-chain test preparation rejects remote, unrelated and unconfirmed resets before connection', async () => {
  for (const [url, reset] of [
    ['postgresql://test@example.invalid/hr_task_assessment_test', true],
    ['postgresql://test@127.0.0.1/erp_hr', true],
    ['postgresql://test@127.0.0.1/hr_task_assessment_test_extra', true],
    ['postgresql://test@127.0.0.1/hr_task_assessment_test', false],
  ]) await assert.rejects(prepareFullHrDatabase(url, reset), /restricted to the disposable loopback/);
});
