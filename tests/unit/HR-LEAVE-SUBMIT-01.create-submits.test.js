// HR-LEAVE-SUBMIT-01 — an employee's leave request is filed into the Approval
// Centre as part of creating it; HR's on-behalf request stays PENDING.
import { describe, expect, it, jest } from '@jest/globals';
import { fileLeaveForApproval } from '../../src/lib/leaveSubmission.js';

const response = () => ({ success: true, data: { id: 7, status: 'PENDING' } });

describe('fileLeaveForApproval', () => {
  it('submits the employee request to the Approval Centre', async () => {
    const submit = jest.fn(async () => ({}));
    const out = await fileLeaveForApproval({ response: response(), filedForSelf: true, reason: 'Family', submit });
    expect(submit).toHaveBeenCalledWith('LEAVE', 7, 'Family');
    expect(out).toMatchObject({ success: true, data: { id: 7, submittedForApproval: true } });
  });
  it('keeps the request and reports why when the submit fails', async () => {
    const submit = jest.fn(async () => {
      throw new Error('Verified employee identity required');
    });
    const out = await fileLeaveForApproval({ response: response(), filedForSelf: true, submit });
    expect(out.data).toMatchObject({ id: 7, submittedForApproval: false, submitNote: 'Verified employee identity required' });
  });
  it('does not submit on behalf of another employee', async () => {
    const submit = jest.fn();
    const out = await fileLeaveForApproval({ response: response(), filedForSelf: false, submit });
    expect(submit).not.toHaveBeenCalled();
    expect(out.data.submittedForApproval).toBe(false);
  });
  it('also handles an unwrapped response', async () => {
    const submit = jest.fn(async () => ({}));
    const out = await fileLeaveForApproval({ response: { id: 3 }, filedForSelf: true, submit });
    expect(out).toMatchObject({ id: 3, submittedForApproval: true });
  });
});
