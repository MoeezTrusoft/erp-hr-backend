export function publishedSetup({
  tenantId,
  employeeId = 1,
  schedules = [],
  policy = {},
}) {
  return [
    {
      id: 1,
      tenantId,
      version: 1,
      effectiveFrom: new Date("2020-01-01"),
      coverageThrough: new Date("2030-12-31"),
      config: {
        version: 1,
        settings: {
          timeZone: "Asia/Karachi",
          defaultCalendarId: 1,
          profiles: [],
          assignments: [],
          staffingTargets: [],
        },
        policy,
        employees: [
          { id: employeeId, payroll_included: true, hire_date: "2020-01-01" },
        ],
        periods: [],
        schedules: schedules.map((s) => ({ ...s, employeeId })),
        calendars: [{ id: 1, year: 2026 }],
        holidays: [],
        calendarAssignments: [],
      },
    },
  ];
}
