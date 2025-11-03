import express from 'express';
import * as leaveController from '../controllers/leave.controller.js';

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
router.post('/requests', leaveController.createLeaveRequest);
router.put('/requests/:id', leaveController.updateLeaveRequest);
router.delete('/requests/:id', leaveController.deleteLeaveRequest);

// Leave Approvals
router.get('/requests/:id/approvals', leaveController.getLeaveRequestApprovals);
router.post('/requests/:id/approve', leaveController.approveLeaveRequest);
router.post('/requests/:id/reject', leaveController.rejectLeaveRequest);

// Leave Balances
router.get('/balances', leaveController.getLeaveBalances);
router.get('/balances/:employeeId', leaveController.getEmployeeLeaveBalances);
router.put('/balances/:employeeId', leaveController.updateLeaveBalance);

// Leave Accruals
router.post('/accruals/run', leaveController.runLeaveAccruals);
router.get('/accruals/history', leaveController.getAccrualHistory);

export default router;