import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";


// Region Services
export const getRegions = async (filters = {}) => {
  const { search, includeInactive } = filters;

  const where = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  const regions = await prisma.region.findMany({
    where,
    include: {
      holidayCalendars: {
        include: {
          holidays: {
            orderBy: { date: 'asc' },
            take: 5 // Limit holidays in list view
          },
          _count: {
            select: {
              holidays: true,
              employeeHolidayCalendars: true
            }
          }
        }
      },
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    },
    orderBy: { name: 'asc' }
  });

  return regions;
};

export const getRegionById = async (id) => {
  return await prisma.region.findUnique({
    where: { id },
    include: {
      holidayCalendars: {
        include: {
          holidays: {
            orderBy: { date: 'asc' }
          },
          _count: {
            select: {
              holidays: true,
              employeeHolidayCalendars: true
            }
          }
        }
      },
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });
};

export const createRegion = async (data, createdBy) => {
  const { name, code, description, createdById } = data;

  // Check if region with same name or code already exists
  const existingRegion = await prisma.region.findFirst({
    where: {
      OR: [
        { name },
        { code }
      ]
    }
  });

  if (existingRegion) {
    throw new Error('Region with this name or code already exists');
  }

  const create = await prisma.region.create({
    data: {
      name,
      code,
      description,
      createdById: parseInt(createdById)
    },
    include: {
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Holiday Region",
    result: "SUCCESS",
    notes: `Holiday Region  "${create.id}" Created successfully`,
  });

  return create;
};

export const updateRegion = async (id, updatedById, data) => {
  const existingRegion = await prisma.region.findUnique({
    where: { id }
  });

  if (!existingRegion) {
    throw new Error('Region not found');
  }

  // Check for duplicate name/code
  if (data.name || data.code) {
    const duplicateRegion = await prisma.region.findFirst({
      where: {
        OR: [
          { name: data.name },
          { code: data.code }
        ],
        NOT: { id }
      }
    });

    if (duplicateRegion) {
      throw new Error('Another region with this name or code already exists');
    }
  }

  const update = await prisma.region.update({
    where: { id },
    data: {
      ...data,
      updatedById: updatedById,
      updated_at: new Date()
    },
    include: {
      holidayCalendars: {
        include: {
          holidays: {
            orderBy: { date: 'asc' }
          }
        }
      },
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });
await logAction({
    employeeId: Number(assignBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Holiday Region",
    result: "SUCCESS",
    notes: `Holiday Region "${id}" Updated successfully`,
  });

  return update;
};

export const deleteRegion = async (id, deletedBy) => {
  // Check if region has associated calendars
  const existingCalendars = await prisma.holidayCalendar.count({
    where: { regionId: id }
  });

  if (existingCalendars > 0) {
    throw new Error('Cannot delete region that has associated holiday calendars');
  }

  // Check if region has employees assigned
  const assignedEmployees = await prisma.employee.count({
    where: { regionId: id }
  });

  if (assignedEmployees > 0) {
    throw new Error('Cannot delete region that has assigned employees');
  }

  const deleted = await prisma.region.delete({
    where: { id }
  });

  await logAction({
    employeeId: Number(deletedBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Holiday Region",
    result: "SUCCESS",
    notes: `Holiday Assign "${id}" Deleted successfully`,
  });
  return deleted;
};

// Holiday Calendar Services
export const getHolidayCalendars = async (filters = {}) => {
  const { regionId, year, search, includeHolidays = false } = filters;

  const where = {};

  if (regionId) {
    where.regionId = parseInt(regionId);
  }

  if (year) {
    where.year = parseInt(year);
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  const include = {
    region: true,
    _count: {
      select: {
        holidays: true,
        employeeHolidayCalendars: true
      }
    },
    createdBy: {
      select: {
        id: true,
        first_name: true,
        last_name: true
      }
    },
    updatedBy: {
      select: {
        id: true,
        first_name: true,
        last_name: true
      }
    }
  };

  if (includeHolidays) {
    include.holidays = {
      orderBy: { date: 'asc' }
    };
  }

  return await prisma.holidayCalendar.findMany({
    where,
    include,
    orderBy: { name: 'asc' }
  });
};

export const getHolidayCalendarById = async (id) => {
  return await prisma.holidayCalendar.findUnique({
    where: { id },
    include: {
      region: true,
      holidays: {
        orderBy: { date: 'asc' }
      },
      employeeHolidayCalendars: {
        include: {
          employee: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              job_title: true
            }
          }
        }
      },
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });
};

export const createHolidayCalendar = async (data,createdById) => {
  const { regionId, name, description, year } = data;

  // Check if calendar already exists for this region and year
  const existingCalendar = await prisma.holidayCalendar.findFirst({
    where: {
      regionId: parseInt(regionId),
      year: year ? parseInt(year) : null,
      name
    }
  });

  if (existingCalendar) {
    throw new Error('Holiday calendar with this name already exists for the selected region and year');
  }

  const create = await prisma.holidayCalendar.create({
    data: {
      regionId: regionId ? parseInt(regionId) : null,
      name,
      description,
      year: year ? parseInt(year) : null,
      createdById: parseInt(createdById)
    },
    include: {
      region: true,
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });

await logAction({
    employeeId: Number(createdById),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Holiday Calender",
    result: "SUCCESS",
    notes: `Holiday Calender "${create.id}" Created successfully`,
  });

  return create;
};

export const updateHolidayCalendar = async (id, data, updatedById) => {
  const existingCalendar = await prisma.holidayCalendar.findUnique({
    where: { id }
  });

  if (!existingCalendar) {
    throw new Error('Holiday calendar not found');
  }

  const update = await prisma.holidayCalendar.update({
    where: { id },
    data: {
      ...data,
      updatedById: Number(updatedById),
      updated_at: new Date()
    },
    include: {
      region: true,
      holidays: {
        orderBy: { date: 'asc' }
      },
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });

await logAction({
    employeeId: Number(assignBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Holiday Calender",
    result: "SUCCESS",
    notes: `Holiday Calender "${id}" Updated successfully`,
  });

  return update;
};

export const deleteHolidayCalendar = async (id,deletedBy) => {
  // Check if calendar has associated holidays
  const holidayCount = await prisma.holiday.count({
    where: { holidayCalendarId: id }
  });

  if (holidayCount > 0) {
    throw new Error('Cannot delete holiday calendar that has associated holidays. Delete holidays first.');
  }

  // Check if calendar has employee assignments
  const assignmentCount = await prisma.employeeHolidayCalendar.count({
    where: { holidayCalendarId: id }
  });

  if (assignmentCount > 0) {
    throw new Error('Cannot delete holiday calendar that has employee assignments. Remove assignments first.');
  }

  const deleted =  await prisma.holidayCalendar.delete({
    where: { id }
  });

await logAction({
    employeeId: Number(deletedBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Holiday Calender",
    result: "SUCCESS",
    notes: `Holiday Calender "${id}" Deleted successfully`,
  });
  return deleted
};

// Holiday Services
export const getHolidays = async (filters = {}) => {
  const { calendarId, startDate, endDate, fullDay, year, regionId } = filters;

  const where = {};

  if (calendarId) {
    where.holidayCalendarId = parseInt(calendarId);
  }

  if (regionId) {
    where.holidayCalendar = {
      regionId: parseInt(regionId)
    };
  }

  if (startDate && endDate) {
    where.date = {
      gte: new Date(startDate),
      lte: new Date(endDate)
    };
  } else if (year) {
    const start = new Date(parseInt(year), 0, 1);
    const end = new Date(parseInt(year), 11, 31);
    where.date = {
      gte: start,
      lte: end
    };
  }

  if (fullDay !== undefined) {
    where.fullDay = fullDay === 'true';
  }

  const holidays = await prisma.holiday.findMany({
    where,
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      },
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    },
    orderBy: { date: 'asc' }
  });

  return holidays;
};

export const getHolidaysByCalendar = async (calendarId, filters = {}) => {
  const { year, month, startDate, endDate } = filters;

  const where = {
    holidayCalendarId: parseInt(calendarId)
  };

  if (year) {
    const startDate = new Date(parseInt(year), 0, 1);
    const endDate = new Date(parseInt(year), 11, 31);
    where.date = {
      gte: startDate,
      lte: endDate
    };
  }

  if (month) {
    const year = new Date().getFullYear();
    const startDate = new Date(year, parseInt(month) - 1, 1);
    const endDate = new Date(year, parseInt(month), 0);
    where.date = {
      gte: startDate,
      lte: endDate
    };
  }

  if (startDate && endDate) {
    where.date = {
      gte: new Date(startDate),
      lte: new Date(endDate)
    };
  }

  return await prisma.holiday.findMany({
    where,
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      },
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    },
    orderBy: { date: 'asc' }
  });
};

export const createHoliday = async (data,createdById) => {
  const {
    holidayCalendarId,
    name,
    date,
    description,
    fullDay = true,
    startTime,
    endTime,
  } = data;

  const holidayDate = new Date(date);

  // Validate date is not in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (holidayDate < today) {
    throw new Error('Cannot create holiday for past dates');
  }

  // Check for duplicate holiday on same date in same calendar
  const existingHoliday = await prisma.holiday.findFirst({
    where: {
      holidayCalendarId: parseInt(holidayCalendarId),
      date: holidayDate
    }
  });

  if (existingHoliday) {
    throw new Error('Holiday already exists on this date for the selected calendar');
  }

  // Validate time fields for partial day holidays
  if (!fullDay && (!startTime || !endTime)) {
    throw new Error('Start time and end time are required for partial day holidays');
  }

  const create = await prisma.holiday.create({
    data: {
      holidayCalendarId: parseInt(holidayCalendarId),
      name,
      date: holidayDate,
      description,
      fullDay: Boolean(fullDay),
      startTime: fullDay ? null : startTime,
      endTime: fullDay ? null : endTime,
      createdById: parseInt(createdById)
    },
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      },
      createdBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });

await logAction({
    employeeId: Number(assignBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Holiday ",
    result: "SUCCESS",
    notes: `Holiday "${create.id}" Created successfully`,
  });
return create;
};

export const updateHoliday = async (calendarId, date, data,updatedById) => {
  const holidayDate = new Date(date);

  const existingHoliday = await prisma.holiday.findUnique({
    where: {
      holidayCalendarId_date: {
        holidayCalendarId: parseInt(calendarId),
        date: holidayDate
      }
    }
  });

  if (!existingHoliday) {
    throw new Error('Holiday not found');
  }

  // Check for duplicate if date is being changed
  if (data.date && new Date(data.date).getTime() !== holidayDate.getTime()) {
    const duplicateHoliday = await prisma.holiday.findFirst({
      where: {
        holidayCalendarId: parseInt(calendarId),
        date: new Date(data.date),
        NOT: {
          holidayCalendarId_date: {
            holidayCalendarId: parseInt(calendarId),
            date: holidayDate
          }
        }
      }
    });

    if (duplicateHoliday) {
      throw new Error('Another holiday already exists on this date for the selected calendar');
    }
  }

  const update = await prisma.holiday.update({
    where: {
      holidayCalendarId_date: {
        holidayCalendarId: parseInt(calendarId),
        date: holidayDate
      }
    },
    data: {
      ...data,
      updatedById: Number(updatedById),
      updated_at: new Date()
    },
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      },
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    }
  });

  await logAction({
    employeeId: Number(assignBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Holiday",
    result: "SUCCESS",
    notes: `Holiday  "${calendarId}" updated successfully`,
  });
  return update;
};

export const deleteHoliday = async (calendarId, date, deletedBy) => {
  const holidayDate = new Date(date);

  const existingHoliday = await prisma.holiday.findUnique({
    where: {
      holidayCalendarId_date: {
        holidayCalendarId: parseInt(calendarId),
        date: holidayDate
      }
    }
  });

  if (!existingHoliday) {
    throw new Error('Holiday not found');
  }

  // Check if holiday is in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (holidayDate < today) {
    throw new Error('Cannot delete past holidays');
  }

  const deleted = await prisma.holiday.delete({
    where: {
      holidayCalendarId_date: {
        holidayCalendarId: parseInt(calendarId),
        date: holidayDate
      }
    }
  });
await logAction({
    employeeId: Number(assignBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Holiday",
    result: "SUCCESS",
    notes: `Holiday  "${calendarId}" Deleted successfully`,
  });

  return deleted;
};

export const getEmployeeHolidays = async (employeeId, filters = {}) => {
  const { startDate, endDate, year, upcoming = false } = filters;

  // Get employee's holiday calendar assignments
  const employeeCalendars = await prisma.employeeHolidayCalendar.findMany({
    where: {
      employeeId: parseInt(employeeId),
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: new Date() } }
      ]
    },
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      }
    }
  });

  if (employeeCalendars.length === 0) {
    // If no specific calendar assigned, get region-based calendar
    const employee = await prisma.employee.findUnique({
      where: { id: parseInt(employeeId) },
      include: {
        region: {
          include: {
            holidayCalendars: {
              where: {
                OR: [
                  { year: new Date().getFullYear() },
                  { year: null }
                ]
              }
            }
          }
        }
      }
    });

    if (!employee) {
      throw new Error('Employee not found');
    }

    if (!employee.region) {
      return []; // No region assigned, no holidays
    }

    // Use region's calendars
    employeeCalendars.push(...employee.region.holidayCalendars.map(calendar => ({
      holidayCalendar: calendar
    })));
  }

  const calendarIds = employeeCalendars.map(ec => ec.holidayCalendar.id);

  const where = {
    holidayCalendarId: { in: calendarIds }
  };

  if (upcoming === 'true') {
    where.date = {
      gte: new Date()
    };
  } else if (startDate && endDate) {
    where.date = {
      gte: new Date(startDate),
      lte: new Date(endDate)
    };
  } else if (year) {
    const start = new Date(parseInt(year), 0, 1);
    const end = new Date(parseInt(year), 11, 31);
    where.date = {
      gte: start,
      lte: end
    };
  }

  const holidays = await prisma.holiday.findMany({
    where,
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      }
    },
    orderBy: { date: 'asc' }
  });

  return holidays;
};

// Additional Helper Functions
export const getUpcomingHolidays = async (days = 30, regionId = null) => {
  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + parseInt(days));

  const where = {
    date: {
      gte: startDate,
      lte: endDate
    }
  };

  if (regionId) {
    where.holidayCalendar = {
      regionId: parseInt(regionId)
    };
  }

  return await prisma.holiday.findMany({
    where,
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      }
    },
    orderBy: { date: 'asc' }
  });
};

export const isHoliday = async (date, regionId = null) => {
  const checkDate = new Date(date);
  checkDate.setHours(0, 0, 0, 0);

  const where = {
    date: checkDate
  };

  if (regionId) {
    where.holidayCalendar = {
      regionId: parseInt(regionId)
    };
  }

  const holiday = await prisma.holiday.findFirst({
    where
  });

  return !!holiday;
};

// Employee Calendar Assignment Services
export const assignEmployeeToCalendar = async (employeeId, calendarId, effectiveFrom = new Date(), effectiveTo = null, assignBy) => {
  const assignment =  await prisma.employeeHolidayCalendar.upsert({
    where: {
      employeeId_holidayCalendarId_effectiveFrom: {
        employeeId: parseInt(employeeId),
        holidayCalendarId: parseInt(calendarId),
        effectiveFrom: new Date(effectiveFrom)
      }
    },
    update: {
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null
    },
    create: {
      employeeId: parseInt(employeeId),
      holidayCalendarId: parseInt(calendarId),
      effectiveFrom: new Date(effectiveFrom),
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null
    },
    include: {
      employee: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      holidayCalendar: {
        include: {
          region: true
        }
      }
    }
  });
 await logAction({
    employeeId: Number(assignBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Holiday",
    result: "SUCCESS",
    notes: `Holiday Assign "${employeeId}""${calendarId}" Created successfully`,
  });


  return assignment
};

export const getEmployeeCalendarAssignments = async (employeeId) => {
  return await prisma.employeeHolidayCalendar.findMany({
    where: {
      employeeId: parseInt(employeeId)
    },
    include: {
      holidayCalendar: {
        include: {
          region: true,
          holidays: {
            where: {
              date: { gte: new Date() }
            },
            orderBy: { date: 'asc' },
            take: 10
          }
        }
      }
    },
    orderBy: { effectiveFrom: 'desc' }
  });
};

// Bulk Operations
export const importHolidays = async (calendarId, holidays, createdById) => {
  const results = {
    success: 0,
    errors: [],
    duplicates: 0
  };

  for (const holidayData of holidays) {
    try {
      await createHoliday({
        ...holidayData,
        holidayCalendarId: parseInt(calendarId),
        createdById: parseInt(createdById)
      });
      results.success++;
    } catch (error) {
      if (error.message.includes('already exists')) {
        results.duplicates++;
      } else {
        results.errors.push(`Date ${holidayData.date}: ${error.message}`);
      }
    }
  }

  return results;
};

export default {
  getRegions,
  getRegionById,
  createRegion,
  updateRegion,
  deleteRegion,
  getHolidayCalendars,
  getHolidayCalendarById,
  createHolidayCalendar,
  updateHolidayCalendar,
  deleteHolidayCalendar,
  getHolidays,
  getHolidaysByCalendar,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  getEmployeeHolidays,
  getUpcomingHolidays,
  isHoliday,
  assignEmployeeToCalendar,
  getEmployeeCalendarAssignments,
  importHolidays
};