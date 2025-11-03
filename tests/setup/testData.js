const testData = {
    // Employee data
    employees: [
        {
            id: 1,
            first_name: 'John',
            last_name: 'Doe',
            job_title: 'Software Developer',
            hire_date: new Date('2023-01-01'),
            status: 'ACTIVE'
        },
        {
            id: 2,
            first_name: 'Jane',
            last_name: 'Smith',
            job_title: 'Engineering Manager',
            hire_date: new Date('2022-01-01'),
            status: 'ACTIVE'
        }
    ],

    // Leave policies
    leavePolicies: [
        {
            id: 1,
            name: 'Annual Leave',
            description: 'Paid time off for vacation',
            accrualRate: 1.67,
            accrualPeriod: 'MONTHLY',
            carryForwardAllowed: true,
            maxCarryForward: 5.0,
            minServiceMonths: 0,
            active: true
        },
        {
            id: 2,
            name: 'Sick Leave',
            description: 'Paid sick leave',
            accrualRate: 1.0,
            accrualPeriod: 'MONTHLY',
            carryForwardAllowed: false,
            maxCarryForward: 0,
            minServiceMonths: 3,
            active: true
        }
    ],

    // Leave requests
    leaveRequests: [
        {
            id: 1,
            employeeId: 1,
            leavePolicyId: 1,
            startDate: new Date('2024-03-01'),
            endDate: new Date('2024-03-05'),
            totalDays: 5,
            reason: 'Family vacation',
            status: 'PENDING'
        }
    ],

    // Leave balances
    leaveBalances: [
        {
            employeeId: 1,
            leavePolicyId: 1,
            balance: 15.0,
            carryOverBalance: 0
        }
    ],

    // Holiday data
    regions: [
        {
            id: 1,
            name: 'United States',
            code: 'US'
        }
    ],

    holidayCalendars: [
        {
            id: 1,
            regionId: 1,
            name: 'US Holidays 2024',
            year: 2024
        }
    ],

    holidays: [
        {
            holidayCalendarId: 1,
            date: new Date('2024-01-01'),
            name: 'New Year Day',
            fullDay: true
        }
    ]
};

// Mock service functions
const mockLeaveService = {
    getLeavePolicies: jest.fn(),
    getLeavePolicyById: jest.fn(),
    createLeavePolicy: jest.fn(),
    updateLeavePolicy: jest.fn(),
    deleteLeavePolicy: jest.fn(),
    getLeaveRequests: jest.fn(),
    getLeaveRequestById: jest.fn(),
    createLeaveRequest: jest.fn(),
    updateLeaveRequest: jest.fn(),
    deleteLeaveRequest: jest.fn(),
    approveLeaveRequest: jest.fn(),
    rejectLeaveRequest: jest.fn(),
    getLeaveBalances: jest.fn(),
    updateLeaveBalance: jest.fn()
};

const mockHolidayService = {
    getRegions: jest.fn(),
    createRegion: jest.fn(),
    getHolidayCalendars: jest.fn(),
    createHolidayCalendar: jest.fn(),
    getHolidays: jest.fn(),
    createHoliday: jest.fn()
};

module.exports = {
    testData,
    mockLeaveService,
    mockHolidayService
};