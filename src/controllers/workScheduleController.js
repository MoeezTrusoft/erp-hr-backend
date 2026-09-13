import asyncHandler from 'express-async-handler';
import * as workScheduleService from '../services/workScheduleService.js';
import { requireEmployeeActor } from '../lib/employeeActor.js';

// @desc    Get work schedules
// @route   GET /api/time-attendance/work-schedules
// @access  Private
const getWorkSchedules = asyncHandler(async (req, res) => {
    const { employeeId } = req.query;
    const targetEmployeeId = req.user?.role === 'EMPLOYEE'
        ? await requireEmployeeActor(req.user)
        : employeeId || await requireEmployeeActor(req.user);

    const schedules = await workScheduleService.getWorkSchedules({
        employeeId: targetEmployeeId,
        tenantId: req.user?.tenantId
    });

    res.json({
        success: true,
        data: schedules
    });
});

// @desc    Create work schedule
// @route   POST /api/time-attendance/work-schedules
// @access  Private
const createWorkSchedule = asyncHandler(async (req, res) => {
    // Honor an explicit employeeId in the body (HR admin creating a schedule FOR
    // an employee); fall back to the caller's session employee-id header.
    // T-FIX: the fallback lookup is best-effort — an HR/admin caller without a
    // linked Employee row must still be able to create a schedule FOR someone
    // (service validates employeeId), not die on HR-0701.
    const employeeId = req.user?.role === 'EMPLOYEE'
        ? await requireEmployeeActor(req.user)
        : req.body?.employeeId || (await requireEmployeeActor(req.user).catch(() => null));
    const scheduleData = {
        ...req.body,
        employeeId,
        tenantId: req.user?.tenantId
    };

    const schedule = await workScheduleService.createWorkSchedule(scheduleData);

    res.status(201).json({
        success: true,
        data: schedule
    });
});

// @desc    Update work schedule
// @route   PUT /api/time-attendance/work-schedules/:id
// @access  Private
const updateWorkSchedule = asyncHandler(async (req, res) => {
    // T-FIX: actor is best-effort — HR/admin callers may have no linked Employee
    // row; an audit-log identity must never block a legitimate update.
    const updatedBy = await requireEmployeeActor(req.user).catch(() => null);
    // T-FIX (tenant fail-open): thread the VERIFIED tenant into the service.
    // This call dropped it, so scopedWhere(undefined) applied NO tenant filter —
    // any tenant's caller could mutate another tenant's schedule by bare id.
    // Caller-supplied tenantId in the body is stripped (verified tenant wins).
    const { tenantId: _spoofedTenant, ...safeBody } = req.body || {};
    const schedule = await workScheduleService.updateWorkSchedule(req.params.id, safeBody, updatedBy, req.user?.tenantId);

    res.json({
        success: true,
        data: schedule
    });
});

// @desc    Delete work schedule
// @route   DELETE /api/time-attendance/work-schedules/:id
// @access  Private
const deleteWorkSchedule = asyncHandler(async (req, res) => {
    // T-FIX: best-effort actor (see update) + verified tenant threading — this
    // path was tenant fail-open and locked out admins without Employee rows.
    const deletedBy = await requireEmployeeActor(req.user).catch(() => null);
    await workScheduleService.deleteWorkSchedule(req.params.id, deletedBy, req.user?.tenantId);

    res.json({
        success: true,
        message: 'Work schedule deleted successfully'
    });
});

export {
    getWorkSchedules,
    createWorkSchedule,
    updateWorkSchedule,
    deleteWorkSchedule
};
