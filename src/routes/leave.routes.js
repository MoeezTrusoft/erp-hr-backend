import express from 'express';
import * as leaveController from '../controllers/leave.controller.js';
import { idempotency } from '../middlewares/idempotency.middleware.js';


const router = express.Router();


// Leave Policies
router.get('/policies', leaveController.getLeavePolicies);
router.get('/policies/:id', leaveController.getLeavePolicyById);
router.post('/policies', leaveController.createLeavePolicy);
router.put('/policies/:id', leaveController.updateLeavePolicy);
router.delete('/policies/:id', leaveController.deleteLeavePolicy);

// Leave Requests
router.get('/requests', leaveController.getLeaveRequests);
router.get('/requests/:id', leaveController.getLeaveRequestById);
// C.2 / T-P2.2 — idempotent create: a repeat with the same Idempotency-Key
// replays the first response (store+replay) instead of double-applying.
router.post('/requests', idempotency(), leaveController.createLeaveRequest);
router.put('/requests/:id/cancel', leaveController.cancelLeaveRequest);

// Leave Approvals
router.get('/approvals/pending', leaveController.getPendingApprovals);
router.get('/requests/:id/approvals', leaveController.getLeaveRequestApprovals);
router.post('/requests/:id/approve', leaveController.approveLeaveRequest);
router.post('/requests/:id/reject', leaveController.rejectLeaveRequest);

// Leave Balances
router.get('/balances', leaveController.getLeaveBalances);
router.get('/balances/employee/:employeeId', leaveController.getEmployeeLeaveBalances);
router.put('/balances/:employeeId', leaveController.updateLeaveBalance);

// Leave Accruals
router.post('/accruals/run', leaveController.runLeaveAccruals);
router.get('/accruals/history', leaveController.getAccrualHistory);

// Holidays
router.get('/holidays', leaveController.getHolidays);
router.get('/holidays/calendar', leaveController.getHolidayCalendar);
router.post('/holidays', leaveController.createHoliday);

export default router;