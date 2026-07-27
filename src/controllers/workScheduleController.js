import asyncHandler from 'express-async-handler';
import * as workScheduleService from '../services/workScheduleService.js';
import { requireEmployeeActor } from '../lib/employeeActor.js';

// @desc    Get work schedules
// @route   GET /api/time-attendance/work-schedules
// @access  Private
const getWorkSchedules = asyncHandler(async (req, res) => {
    const { employeeId } = req.query;
    const targetEmployeeId = req.user?.role === 'EMPLOYEE'
        ? requireEmployeeActor(req.user)
        : employeeId || requireEmployeeActor(req.user);

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
    const employeeId = req.user?.role === 'EMPLOYEE'
        ? requireEmployeeActor(req.user)
        : req.body?.employeeId || requireEmployeeActor(req.user);
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
    const updatedBy = requireEmployeeActor(req.user);
    const schedule = await workScheduleService.updateWorkSchedule(req.params.id, req.body,updatedBy);

    res.json({
        success: true,
        data: schedule
    });
});

// @desc    Delete work schedule
// @route   DELETE /api/time-attendance/work-schedules/:id
// @access  Private
const deleteWorkSchedule = asyncHandler(async (req, res) => {
    const deletedBy = requireEmployeeActor(req.user);
    await workScheduleService.deleteWorkSchedule(req.params.id, deletedBy);

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
