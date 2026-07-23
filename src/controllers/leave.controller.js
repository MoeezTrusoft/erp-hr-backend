import * as leaveService from '../services/leave.service.js';
import { createRequisitionController } from './requisition.controller.js';
import { respondServerError, respondPreconditionAware } from '../utils/httpError.js';

// C.2 / T-P2.2 — the verified tenant arrives on req.user.tenantId (set by
// internalServiceGuard from the signed service-JWT claim; T-P2.1) — NEVER from
// a request header. Threaded into the scoped leave service calls so tenant B
// cannot read/mutate tenant A's leave rows.
const tenantOf = (req) => req.user?.tenantId ?? null;

export const getLeavePolicies = async (req, res) => {
  try {
    const policies = await leaveService.getLeavePolicies(req.query);
    res.json({ success: true, data: policies });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getLeavePolicyById = async (req, res) => {
  try {
    const policy = await leaveService.getLeavePolicyById(parseInt(req.params.id));
    if (!policy) {
      return res.status(404).json({ success: false, error: 'Leave policy not found' });
    }
    res.json({ success: true, data: policy });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const createLeavePolicy = async (req, res) => {
  try {

     const employeeId = req.headers['employee-id'];
    const policy = await leaveService.createLeavePolicy({
      ...req.body,
      createdById: employeeId
  });
    res.status(201).json({ success: true,message:policy,  receivedUserId: req.headers["x-user-id"] });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const updateLeavePolicy = async (req, res) => {
  try {
    const employeeId = req.headers['employee-id'];
    const policy = await leaveService.updateLeavePolicy(
      parseInt(req.params.id),
      { ...req.body, updatedById: parseInt(employeeId)}
    );
    res.json({ success: true, data: policy });
  } catch (error) {
    // API-2 — surface a stale-write as 412 (HR-4120) with currentVersion.
    if (respondPreconditionAware(res, error)) return;
    res.status(400).json({ success: false, error: error.message });
  }
};

export const deleteLeavePolicy = async (req, res) => {
  try {
    const deletedBy = req.headers['employee-id'];
    await leaveService.deleteLeavePolicy(parseInt(req.params.id), deletedBy);
    res.json({ success: true, message: 'Leave policy deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getLeaveRequests = async (req, res) => {
  try {
    // If user is not HR/Manager, only show their own requests
    const filters = req.user.role === 'EMPLOYEE'
      ? { ...req.query, employeeId: req.user.id }
      : { ...req.query };
    filters.tenantId = tenantOf(req);

    const requests = await leaveService.getLeaveRequests(filters);
    res.json({ success: true, data: requests });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getLeaveRequestById = async (req, res) => {
  try {
    const request = await leaveService.getLeaveRequestById(parseInt(req.params.id), tenantOf(req));
    if (!request) {
      return res.status(404).json({ success: false, error: 'Leave request not found' });
    }

    // Check if user has permission to view this request
    if (req.user.role === 'EMPLOYEE' && request.employeeId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const createLeaveRequest = async (req, res) => {
  try {
    
    const employeeId = req.headers['employee-id'];
    const request = await leaveService.createLeaveRequest({
      ...req.body,
     // employeeId: req.user.id,
      createdById: employeeId
    }, undefined, tenantOf(req));
    res.status(201).json({ success: true, data: request });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const cancelLeaveRequest = async (req, res) => {
  try {
    const leaveRequestId = Number(req.params.id);
     const updatedById = req.headers['employee-id'];
    const request = await leaveService.cancelLeaveRequest(
      leaveRequestId,
      Number(updatedById),
      req.body?.reason
    );
    res.json({ success: true, data: request });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getPendingApprovals = async (req, res) => {
  try {
    const approvals = await leaveService.getPendingApprovals(req.user.id, req.user.role);
    res.json({ success: true, data: approvals });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getLeaveRequestApprovals = async (req, res) => {
  try {
    const approvals = await leaveService.getLeaveRequestApprovals(parseInt(req.params.id));
    res.json({ success: true, data: approvals });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const approveLeaveRequest = async (req, res) => {
  try {
    const employeeId = req.headers['employee-id'];
    const result = await leaveService.approveLeaveRequest(
      parseInt(req.params.id),
      {
        ...req.body,
        approverId: employeeId,
        createdById: employeeId
      }
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const rejectLeaveRequest = async (req, res) => {
  try {
    const createdBy = req.headers['employee-id'];
    const result = await leaveService.rejectLeaveRequest(
      parseInt(req.params.id),
      {
        ...req.body,
        approverId:  createdBy,
        createdById:  createdBy
      }
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getLeaveBalances = async (req, res) => {
  try {
    const balances = await leaveService.getLeaveBalances(req.query);
    res.json({ success: true, data: balances });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getEmployeeLeaveBalances = async (req, res) => {
  try {
    // Employees can only view their own balances
    const employeeId = req.user.role === 'EMPLOYEE'
      ? req.user.id
      : parseInt(req.params.employeeId);

    const balances = await leaveService.getEmployeeLeaveBalances(employeeId);
    res.json({ success: true, data: balances });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const updateLeaveBalance = async (req, res) => {
  try {
    const UpdatedBy = req.headers['employee-id'];
    const balance = await leaveService.updateLeaveBalance(
      parseInt(req.params.employeeId),
      { ...req.body, updatedById: UpdatedBy}
    );
    res.json({ success: true, data: balance });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const runLeaveAccruals = async (req, res) => {
  try {
    const result = await leaveService.runLeaveAccruals(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getAccrualHistory = async (req, res) => {
  try {
    const history = await leaveService.getAccrualHistory(req.query);
    res.json({ success: true, data: history });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getHolidays = async (req, res) => {
  try {
    const holidays = await leaveService.getHolidays(req.query);
    res.json({ success: true, data: holidays });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getHolidayCalendar = async (req, res) => {
  try {
    const calendar = await leaveService.getHolidayCalendar(req.user.id);
    res.json({ success: true, data: calendar });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const createHoliday = async (req, res) => {
  try {
    const employeeId = req.headers['employee-id'];
    const holiday = await leaveService.createHoliday({
      ...req.body,
      createdById: employeeId
    });
    res.status(201).json({ success: true, data: holiday });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};