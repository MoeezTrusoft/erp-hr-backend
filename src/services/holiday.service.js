import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Region Services
export const getRegions = async (filters = {}) => {
  const { search } = filters;

  const where = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } }
    ];
  }

  return await prisma.region.findMany({
    where,
    include: {
      holidayCalendars: {
        include: {
          holidays: {
            orderBy: { date: 'asc' }
          }
        }
      }
    }
  });
};

export const getRegionById = async (id) => {
  return await prisma.region.findUnique({
    where: { id },
    include: {
      holidayCalendars: {
        include: {
          holidays: {
            orderBy: { date: 'asc' }
          }
        }
      }
    }
  });
};

export const createRegion = async (data) => {
  const { name, code } = data;

  return await prisma.region.create({
    data: {
      name,
      code
    }
  });
};

export const updateRegion = async (id, data) => {
  return await prisma.region.update({
    where: { id },
    data
  });
};

export const deleteRegion = async (id) => {
  // Check if region has associated calendars
  const existingCalendars = await prisma.holidayCalendar.count({
    where: { regionId: id }
  });

  if (existingCalendars > 0) {
    throw new Error('Cannot delete region that has associated holiday calendars');
  }

  return await prisma.region.delete({
    where: { id }
  });
};

// Holiday Calendar Services
export const getHolidayCalendars = async (filters = {}) => {
  const { regionId, year, search } = filters;

  const where = {};

  if (regionId) {
    where.regionId = parseInt(regionId);
  }

  if (year) {
    where.year = parseInt(year);
  }

  if (search) {
    where.name = { contains: search, mode: 'insensitive' };
  }

  return await prisma.holidayCalendar.findMany({
    where,
    include: {
      region: true,
      holidays: {
        orderBy: { date: 'asc' }
      }
    }
  });
};

export const getHolidayCalendarById = async (id) => {
  return await prisma.holidayCalendar.findUnique({
    where: { id },
    include: {
      region: true,
      holidays: {
        orderBy: { date: 'asc' }
      }
    }
  });
};

export const createHolidayCalendar = async (data) => {
  const { regionId, name, year } = data;

  // Check if calendar already exists for this region and year
  const existingCalendar = await prisma.holidayCalendar.findFirst({
    where: {
      regionId: parseInt(regionId),
      year: year ? parseInt(year) : null
    }
  });

  if (existingCalendar) {
    throw new Error('Holiday calendar already exists for this region and year');
  }

  return await prisma.holidayCalendar.create({
    data: {
      regionId: parseInt(regionId),
      name,
      year: year ? parseInt(year) : null
    },
    include: {
      region: true
    }
  });
};

export const updateHolidayCalendar = async (id, data) => {
  return await prisma.holidayCalendar.update({
    where: { id },
    data,
    include: {
      region: true,
      holidays: {
        orderBy: { date: 'asc' }
      }
    }
  });
};

export const deleteHolidayCalendar = async (id) => {
  return await prisma.holidayCalendar.delete({
    where: { id }
  });
};

// Holiday Services
export const getHolidays = async (filters = {}) => {
  const { calendarId, startDate, endDate, fullDay } = filters;

  const where = {};

  if (calendarId) {
    where.holidayCalendarId = parseInt(calendarId);
  }

  if (startDate && endDate) {
    where.date = {
      gte: new Date(startDate),
      lte: new Date(endDate)
    };
  }

  if (fullDay !== undefined) {
    where.fullDay = fullDay === 'true';
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

export const getHolidaysByCalendar = async (calendarId, filters = {}) => {
  const { year, month } = filters;

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

export const createHoliday = async (data) => {
  const {
    holidayCalendarId,
    name,
    date,
    description,
    fullDay = true,
    startTime,
    endTime
  } = data;

  const holidayDate = new Date(date);

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

  return await prisma.holiday.create({
    data: {
      holidayCalendarId: parseInt(holidayCalendarId),
      name,
      date: holidayDate,
      description,
      fullDay: Boolean(fullDay),
      startTime: fullDay ? null : startTime,
      endTime: fullDay ? null : endTime
    },
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      }
    }
  });
};

export const updateHoliday = async (calendarId, date, data) => {
  const holidayDate = new Date(date);

  return await prisma.holiday.update({
    where: {
      holidayCalendarId_date: {
        holidayCalendarId: parseInt(calendarId),
        date: holidayDate
      }
    },
    data,
    include: {
      holidayCalendar: {
        include: {
          region: true
        }
      }
    }
  });
};

export const deleteHoliday = async (calendarId, date) => {
  const holidayDate = new Date(date);

  return await prisma.holiday.delete({
    where: {
      holidayCalendarId_date: {
        holidayCalendarId: parseInt(calendarId),
        date: holidayDate
      }
    }
  });
};

export const getEmployeeHolidays = async (employeeId, filters = {}) => {
  const { startDate, endDate } = filters;

  // Get employee's region/calendar assignment
  const employee = await prisma.employee.findUnique({
    where: { id: parseInt(employeeId) },
    select: {
      regionId: true
    }
  });

  if (!employee) {
    throw new Error('Employee not found');
  }

  const where = {
    holidayCalendar: {
      regionId: employee.regionId
    }
  };

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
      }
    },
    orderBy: { date: 'asc' }
  });
};

// Additional Helper Functions
export const getUpcomingHolidays = async (days = 30) => {
  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + days);

  return await prisma.holiday.findMany({
    where: {
      date: {
        gte: startDate,
        lte: endDate
      }
    },
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