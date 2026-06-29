import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { withTenant, tenantData } from "../lib/tenancy.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { leaveApprovedEvent, leaveRejectedEvent } from "./hrEvents.js";
import { assertIfMatch } from "../lib/optimisticConcurrency.js";

// C.2 / T-P2.2 / T-P2.6 — leave is a representative newly-scoped HR family. The
// verified tenant (RBAC Company.uuid; T-P2.1) is threaded in from the controller
// as `tenantId` and folded into the per-query predicate via withTenant. The
// param is optional so legacy callers/tests keep working; when a tenant IS
// supplied the read/write is fail-closed to that tenant — tenant B can never
// read or mutate tenant A's leave request for the SAME id (resolves not-found).
// `undefined` means "no tenant scoping requested" (legacy path); a present value
// (incl. null) applies the fail-closed predicate.
const scopedWhere = (tenantId, where) =>
  tenantId === undefined ? where : withTenant(tenantId, where);

// Helper Functions
const calculateWorkingDays = async (employeeId, startDate, endDate) => {
  let count = 0;
  const current = new Date(startDate);
  const end = new Date(endDate);

  // Get employee's holiday calendar
  const employeeCalendar = await prisma.employeeHolidayCalendar.findFirst({
    where: {
      employeeId,
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: current } }
      ]
    },
    include: {
      holidayCalendar: {
        include: {
          holidays: {
            where: {
              date: {
                gte: current,
                lte: end
              }
            }
          }
        }
      }
    }
  });

  const holidays = employeeCalendar?.holidayCalendar?.holidays || [];

  while (current <= end) {
    const dayOfWeek = current.getDay();
    // Skip weekends (Sunday = 0, Saturday = 6)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Check if it's a holiday
      const isHoliday = holidays.some(holiday =>
        holiday.date.toDateString() === current.toDateString()
      );
      if (!isHoliday) {
        count++;
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
};

const calculateAccrualAmount = async (policy, employee, date) => {
  const hireDate = new Date(employee.hire_date);
  const accrualDate = new Date(date);

  // Check if employee meets minimum service requirement
  const monthsOfService = (accrualDate.getFullYear() - hireDate.getFullYear()) * 12 +
    (accrualDate.getMonth() - hireDate.getMonth());

  if (monthsOfService < policy.minServiceMonths) {
    return 0;
  }

  switch (policy.accrualPeriod) {
    case 'MONTHLY':
      return policy.accrualRate;
    case 'QUARTERLY':
      // Only accrue on quarter boundaries
      const currentQuarter = Math.floor(accrualDate.getMonth() / 3);
      const lastAccrualQuarter = await getLastAccrualQuarter(employee.id, policy.id);
      if (currentQuarter !== lastAccrualQuarter) {
        return policy.accrualRate * 3;
      }
      return 0;
    case 'ANNUAL':
      // Only accrue on anniversary
      if (accrualDate.getMonth() === hireDate.getMonth() &&
        accrualDate.getDate() === hireDate.getDate()) {
        return policy.accrualRate;
      }
      return 0;
    default:
      return 0;
  }
};

const getLastAccrualQuarter = async (employeeId, policyId) => {
  // This would typically query an accrual history table
  // For now, return null to always accrue
  return null;
};

const getEmployeeManager = async (employeeId) => {
  // This should be implemented based on your organization structure
  // For now, return a default manager or HR user
  const manager = await prisma.employee.findFirst({
    where: {
      job_title: {
        contains: 'Manager',
        mode: 'insensitive'
      }
    }
  });
  return manager;
};

// Leave Policy Services
export const getLeavePolicies = async (filters = {}) => {
  const { active, search, includeInactive } = filters;

  const where = {};

  if (active !== undefined && active !== 'false') {
    where.active = active === 'true';
  }

  if (includeInactive !== 'true') {
    where.active = true;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { leaveTypeCode: { contains: search, mode: 'insensitive' } }
    ];
  }

  return await prisma.leavePolicy.findMany({
    where,
    include: {
      approvalWorkflow: {
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' }
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
};

export const getLeavePolicyById = async (id) => {
  return await prisma.leavePolicy.findUnique({
    where: { id },
    include: {
      approvalWorkflow: {
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' }
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
      },
      leaveRequests: {
        include: {
          employee: {
            select: {
              id: true,
              first_name: true,
              last_name: true
            }
          }
        },
        take: 10,
        orderBy: { created_at: 'desc' }
      }
    }
  });
};

export const createLeavePolicy = async (data,createdById) => {
  const {
    name,
    description,
    leaveTypeCode,
    accrualRate,
    accrualPeriod,
    carryForwardAllowed,
    maxCarryForward,
    minServiceMonths,
    active = true,
    approvalWorkflowId,
    
  } = data;

  // Validate accrual period
  const validAccrualPeriods = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUAL'];
  if (!validAccrualPeriods.includes(accrualPeriod)) {
    throw new Error('Invalid accrual period. Must be one of: NONE, MONTHLY, QUARTERLY, ANNUAL');
  }

  // Validate carry forward settings
  if (carryForwardAllowed && (!maxCarryForward || maxCarryForward <= 0)) {
    throw new Error('Max carry forward must be greater than 0 when carry forward is allowed');
  }

  if (!carryForwardAllowed && maxCarryForward > 0) {
    throw new Error('Max carry forward must be 0 when carry forward is not allowed');
  }

  const create = await prisma.leavePolicy.create({
    data: {
      name,
      description,
      leaveTypeCode,
      accrualRate: parseFloat(accrualRate),
      accrualPeriod,
      carryForwardAllowed: Boolean(carryForwardAllowed),
      maxCarryForward: parseFloat(maxCarryForward || 0),
      minServiceMonths: parseInt(minServiceMonths || 0),
      active: Boolean(active),
      approvalWorkflowId: approvalWorkflowId ? parseInt(approvalWorkflowId) : null,
      createdById: parseInt(createdById)
    },
    include: {
      approvalWorkflow: {
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' }
          }
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
    employeeId: Number(createdById),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Leave Policy",
    result: "SUCCESS",
    notes: `Leave Policy "${create.id}" Created successfully`,
  });

  return create;

};

export const updateLeavePolicy = async (id, data,updatedById) => {
  const existingPolicy = await prisma.leavePolicy.findUnique({
    where: { id }
  });

  if (!existingPolicy) {
    throw new Error('Leave policy not found');
  }

  const update = await prisma.leavePolicy.update({
    where: { id },
    data: {
      ...data,
      updatedById: updatedById,
      updated_at: new Date()
    },
    include: {
      approvalWorkflow: {
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' }
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
    employeeId: Number(updatedById),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Leave Policy",
    result: "SUCCESS",
    notes: `Leave Policy "${id}" Updated successfully`,
  });
  return update
};

export const deleteLeavePolicy = async (id, deletedBy) => {
  // Check if policy is being used by any leave requests
  const existingRequests = await prisma.leaveRequest.count({
    where: { leavePolicyId: id }
  });

  if (existingRequests > 0) {
    throw new Error('Cannot delete leave policy that has associated leave requests');
  }

  // Check if policy is being used by any leave balances
  const existingBalances = await prisma.leaveBalance.count({
    where: { leavePolicyId: id }
  });

  if (existingBalances > 0) {
    throw new Error('Cannot delete leave policy that has associated leave balances');
  }

  const deleted =  await prisma.leavePolicy.delete({
    where: { id }
  });
 await logAction({
    employeeId: Number(deletedBy),
    type: "Delete", // 👈 changed from CREATE to UPDATE
    module: "Leave Policy",
    result: "SUCCESS",
    notes: `Leave Policy "${id}" Deleted successfully`,
  });

  return deleted
};

// Leave Request Services
export const getLeaveRequests = async (filters = {}) => {
  const {
    employeeId,
    status,
    leavePolicyId,
    startDate,
    endDate,
    department,
    page = 1,
    limit = 20,
    tenantId
  } = filters;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  // C.2: fold the verified tenant into the predicate (fail-closed when present).
  const where = scopedWhere(tenantId, {});

  if (employeeId) {
    where.employeeId = parseInt(employeeId);
  }

  if (status) {
    where.status = status;
  }

  if (leavePolicyId) {
    where.leavePolicyId = parseInt(leavePolicyId);
  }

  if (startDate && endDate) {
    where.OR = [
      {
        startDate: { lte: new Date(endDate) },
        endDate: { gte: new Date(startDate) }
      }
    ];
  }

  const [requests, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            job_title: true,
            // C.2 bugfix: the Employee→Position relation is `Position` (schema
            // l.246), not `position`; Position has no `department` relation, so
            // a plain include is the correct, working read.
            Position: true
          }
        },
        leavePolicy: true,
        approvals: {
          include: {
            approver: {
              select: {
                id: true,
                first_name: true,
                last_name: true
              }
            }
          },
          orderBy: { decision_date: 'asc' }
        },
        createdBy: {
          select: {
            id: true,
            first_name: true,
            last_name: true
          }
        }
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.leaveRequest.count({ where })
  ]);

  return {
    data: requests,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  };
};

export const getLeaveRequestById = async (id, tenantId) => {
  // C.2: when a tenant is supplied, scope by [id, tenantId] so a cross-tenant
  // id resolves to not-found (null) — never another tenant's leave row. We use
  // findFirst (findUnique cannot carry the non-unique tenantId predicate).
  return await prisma.leaveRequest.findFirst({
    where: scopedWhere(tenantId, { id }),
    include: {
      employee: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          job_title: true,
          // C.2 bugfix: the Employee→Position relation is `Position` (schema
          // l.246), not `position`; Position has no `department` relation, so
          // a plain include is the correct, working read.
          Position: true
        }
      },
      leavePolicy: {
        include: {
          approvalWorkflow: {
            include: {
              steps: {
                orderBy: { stepOrder: 'asc' }
              }
            }
          }
        }
      },
      approvals: {
        include: {
          approver: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              job_title: true
            }
          }
        },
        orderBy: { decision_date: 'asc' }
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

export const createLeaveRequest = async (data,createdById, tenantId) => {
  const {
    employeeId,
    leavePolicyId,
    startDate,
    endDate,
    reason,
    notes,
  } = data;

  // Validate dates
  const start = new Date(startDate);
  const end = new Date(endDate);
  const today = new Date();

  if (start > end) {
    throw new Error('Start date cannot be after end date');
  }

  if (start < today) {
    throw new Error('Cannot request leave for past dates');
  }

  // Check for overlapping leave requests
  const overlappingLeaves = await prisma.leaveRequest.count({
    where: {
      employeeId: parseInt(employeeId),
      status: { in: ['PENDING', 'APPROVED'] },
      OR: [
        {
          startDate: { lte: end },
          endDate: { gte: start }
        }
      ]
    }
  });

  if (overlappingLeaves > 0) {
    throw new Error('You have an overlapping leave request during this period');
  }

  // Calculate duration (excluding weekends and holidays)
  const durationDays = await calculateWorkingDays(parseInt(employeeId), start, end);

  if (durationDays <= 0) {
    throw new Error('No working days in the selected date range');
  }

  // Check leave balance
  const balance = await prisma.leaveBalance.findUnique({
    where: {
      employeeId_leavePolicyId: {
        employeeId: parseInt(employeeId),
        leavePolicyId: parseInt(leavePolicyId)
      }
    }
  });

  if (!balance || balance.balance < durationDays) {
    throw new Error(`Insufficient leave balance. Available: ${balance?.balance || 0} days, Requested: ${durationDays} days`);
  }

  // Get leave policy to check approval workflow
  const leavePolicy = await prisma.leavePolicy.findUnique({
    where: { id: parseInt(leavePolicyId) },
    include: {
      approvalWorkflow: {
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' }
          }
        }
      }
    }
  });

  const create = await prisma.leaveRequest.create({
    // C.2: stamp the verified tenant on the new row (omitted → unchanged legacy
    // behavior; present → fail-closed via tenantData).
    data: (tenantId === undefined ? (d) => d : (d) => tenantData(tenantId, d))({
      employeeId: parseInt(employeeId),
      leavePolicyId: parseInt(leavePolicyId),
      startDate: start,
      endDate: end,
      totalDays: durationDays,
      reason,
      notes,
      status: 'PENDING',
      createdById: parseInt(createdById)
    }),
    include: {
      employee: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      leavePolicy: {
        include: {
          approvalWorkflow: {
            include: {
              steps: {
                orderBy: { stepOrder: 'asc' }
              }
            }
          }
        }
      },
      approvals: true
    }
  });
   await logAction({
    employeeId: Number(createdById),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Leave Request",
    result: "SUCCESS",
    notes: `Leave Request "${create.id}" Created successfully`,
  });

  return create;
};

export const cancelLeaveRequest = async (id, employeeId) => {
  const existingRequest = await prisma.leaveRequest.findUnique({
    where: { id }
  });

  if (!existingRequest) {
    throw new Error('Leave request not found');
  }

  if (existingRequest.employeeId !== employeeId) {
    throw new Error('You can only cancel your own leave requests');
  }

  if (existingRequest.status !== 'PENDING') {
    throw new Error('Cannot cancel non-pending leave requests');
  }

  const update = await prisma.leaveRequest.update({
    where: { id },
    data: { status: 'CANCELLED' },
    include: {
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      leavePolicy: true
    }
  });

    await logAction({
    employeeId: Number(employeeId),
    type: "Updated", // 👈 changed from CREATE to UPDATE
    module: "Leave Request",
    result: "SUCCESS",
    notes: `Leave Request "${id}" Cancelled successfully`,
  });
  return update;
};

export const updateLeaveRequest = async (id, data) => {
  const existingRequest = await prisma.leaveRequest.findUnique({
    where: { id }
  });

  if (!existingRequest) {
    throw new Error('Leave request not found');
  }

  if (existingRequest.status !== 'PENDING') {
    throw new Error('Cannot modify non-pending leave requests');
  }

  return await prisma.leaveRequest.update({
    where: { id },
    data: {
      ...data,
      updated_at: new Date()
    },
    include: {
      employee: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      },
      leavePolicy: true
    }
  });
};

// Leave Approval Services
export const getPendingApprovals = async (userId, userRole) => {
  const where = {
    status: 'PENDING'
  };

  // If user is a manager, show their team's requests
  if (userRole === 'MANAGER') {
    // Get manager's team members
    const teamMembers = await prisma.employee.findMany({
      where: {
        // This would depend on your organization structure
        // For now, return all employees for managers
      },
      select: { id: true }
    });

    const teamMemberIds = teamMembers.map(member => member.id);
    where.employeeId = { in: teamMemberIds };
  }

  return await prisma.leaveRequest.findMany({
    where,
    include: {
      employee: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          job_title: true
        }
      },
      leavePolicy: true,
      approvals: {
        include: {
          approver: {
            select: {
              id: true,
              first_name: true,
              last_name: true
            }
          }
        }
      }
    },
    orderBy: { created_at: 'asc' }
  });
};

export const getLeaveRequestApprovals = async (leaveRequestId) => {
  return await prisma.leaveRequestApproval.findMany({
    where: { leaveRequestId },
    include: {
      approver: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          job_title: true
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
    orderBy: { decision_date: 'asc' }
  });
};

export const approveLeaveRequest = async (leaveRequestId, data,) => {
  const { approverId, approverRole, comments, createdById } = data;
  // M1-HR fan-out: the acting context for the outbox event (A.5 correlation +
  // acting principal). Threaded from the controller via `data.ctx`; absent in
  // legacy/test callers (the builder/enqueue then fail-soft).
  const ctx = data?.ctx || { actorId: createdById, correlationId: data?.correlationId };

  const leaveRequest = await prisma.leaveRequest.findUnique({
    where: { id: leaveRequestId },
    include: {
      leavePolicy: {
        include: {
          approvalWorkflow: {
            include: {
              steps: {
                orderBy: { stepOrder: 'asc' }
              }
            }
          }
        }
      },
      approvals: true
    }
  });

  if (!leaveRequest) {
    throw new Error('Leave request not found');
  }

  // X-07 — If-Match / 412 optimistic concurrency (opt-in via data.ifMatch).
  assertIfMatch(data?.ifMatch, leaveRequest);

  if (leaveRequest.status !== 'PENDING') {
    throw new Error('Leave request is not pending approval');
  }

  // Check if approver has already approved this request
  const existingApproval = await prisma.leaveRequestApproval.findFirst({
    where: {
      leaveRequestId,
      approverId: parseInt(approverId)
    }
  });

  if (existingApproval) {
    throw new Error('You have already acted on this leave request');
  }

  // Record approval
  await prisma.leaveRequestApproval.create({
    data: {
      leaveRequestId,
      approverId: parseInt(approverId),
      approverRole,
      decision: 'APPROVED',
      comments,
      decision_date: new Date(),
      createdById: parseInt(createdById)
    }
  });

  // Check if this was the final approval
  const workflow = leaveRequest.leavePolicy.approvalWorkflow;
  const totalSteps = workflow ? workflow.steps.length : 1;
  const approvalsCount = await prisma.leaveRequestApproval.count({
    where: { leaveRequestId, decision: 'APPROVED' }
  });

  let newStatus = leaveRequest.status;

  if (approvalsCount >= totalSteps || !workflow) {
    // Final approval - update status and deduct leave balance
    newStatus = 'APPROVED';

    await prisma.leaveBalance.update({
      where: {
        employeeId_leavePolicyId: {
          employeeId: leaveRequest.employeeId,
          leavePolicyId: leaveRequest.leavePolicyId
        }
      },
      data: {
        balance: {
          decrement: leaveRequest.totalDays
        },
        lastUpdated: new Date()
      }
    });

    // Create attendance records for the leave period
    await createLeaveAttendanceRecords(leaveRequest);
  }

  // M1-HR: the status flip and — on FINAL approval — the
  // hr.leave.approved.v1 outbox event commit or roll back together (outbox-on-
  // write, validate-before-write). The event is ids-only + tenant-scoped from
  // the leave request's verified tenant; a non-conformant event throws and
  // rolls back the status update (a bad event never escapes).
  const update = await prisma.$transaction(async (tx) => {
    const row = await tx.leaveRequest.update({
      where: { id: leaveRequestId },
      data: { status: newStatus },
      include: {
        employee: {
          select: {
            id: true,
            first_name: true,
            last_name: true
          }
        },
        leavePolicy: true,
        approvals: {
          include: {
            approver: {
              select: {
                id: true,
                first_name: true,
                last_name: true
              }
            }
          }
        }
      }
    });

    if (newStatus === 'APPROVED') {
      const event = leaveApprovedEvent(
        { id: row.id, employeeId: row.employeeId, leavePolicyId: row.leavePolicyId, totalDays: leaveRequest.totalDays, tenantId: row.tenantId },
        ctx
      );
      if (event) await enqueueHrDomainEvent(tx, event);
    }

    return row;
  });
    await logAction({
      employeeId: Number(createdById),
      type: 'Update',
      module: 'Leave Request',
      result: 'SUCCESS',
      notes: `Leave request ID ${leaveRequestId} approved successfully by employee ID ${createdById}.`,
    });

  return update;
};

export const rejectLeaveRequest = async (leaveRequestId, data) => {
  const { approverId, approverRole, comments, createdById } = data;
  const ctx = data?.ctx || { actorId: createdById, correlationId: data?.correlationId };

  const leaveRequest = await prisma.leaveRequest.findUnique({
    where: { id: leaveRequestId }
  });

  if (!leaveRequest) {
    throw new Error('Leave request not found');
  }

  if (leaveRequest.status !== 'PENDING') {
    throw new Error('Leave request is not pending approval');
  }

  // Record rejection
  await prisma.leaveRequestApproval.create({
    data: {
      leaveRequestId,
      approverId: parseInt(approverId),
      approverRole,
      decision: 'REJECTED',
      comments,
      decision_date: new Date(),
      createdById: parseInt(createdById)
    }
  });

  // M1-HR: the status flip + hr.leave.rejected.v1 outbox event are atomic.
  const update = await prisma.$transaction(async (tx) => {
    const row = await tx.leaveRequest.update({
      where: { id: leaveRequestId },
      data: { status: 'REJECTED' },
      include: {
        employee: {
          select: {
            id: true,
            first_name: true,
            last_name: true
          }
        },
        leavePolicy: true,
        approvals: {
          include: {
            approver: {
              select: {
                id: true,
                first_name: true,
                last_name: true
              }
            }
          }
        }
      }
    });

    const event = leaveRejectedEvent(
      { id: row.id, employeeId: row.employeeId, tenantId: row.tenantId },
      ctx,
      { reason: comments ?? null }
    );
    if (event) await enqueueHrDomainEvent(tx, event);

    return row;
  });
  await logAction({
    employeeId: Number(createdById),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Leave Request",
    result: "SUCCESS",
    notes: `Leave Request "${leaveRequestId}" Rejected successfully`,
  });
  return update;
};

// Leave Balance Services
export const getLeaveBalances = async (filters = {}) => {
  const { employeeId, leavePolicyId, department, lowBalance } = filters;

  const where = {};

  if (employeeId) {
    where.employeeId = parseInt(employeeId);
  }

  if (leavePolicyId) {
    where.leavePolicyId = parseInt(leavePolicyId);
  }

  if (lowBalance === 'true') {
    where.balance = { lte: 5 }; // Show balances with 5 days or less
  }

  const balances = await prisma.leaveBalance.findMany({
    where,
    include: {
      employee: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          job_title: true,
          // C.2 bugfix: the Employee→Position relation is `Position` (schema
          // l.246), not `position`; Position has no `department` relation, so
          // a plain include is the correct, working read.
          Position: true
        }
      },
      leavePolicy: true,
      updatedBy: {
        select: {
          id: true,
          first_name: true,
          last_name: true
        }
      }
    },
    orderBy: [
      { employee: { first_name: 'asc' } },
      { leavePolicy: { name: 'asc' } }
    ]
  });

  return balances;
};

export const getEmployeeLeaveBalances = async (employeeId) => {
  return await prisma.leaveBalance.findMany({
    where: { employeeId: parseInt(employeeId) },
    include: {
      leavePolicy: true
    },
    orderBy: { leavePolicy: { name: 'asc' } }
  });
};

export const updateLeaveBalance = async (employeeId, data) => {
  const { leavePolicyId, balance, carryOverBalance, updatedById, notes } = data;

  const existingBalance = await prisma.leaveBalance.findUnique({
    where: {
      employeeId_leavePolicyId: {
        employeeId: parseInt(employeeId),
        leavePolicyId: parseInt(leavePolicyId)
      }
    }
  });

  const result = await prisma.leaveBalance.upsert({
    where: {
      employeeId_leavePolicyId: {
        employeeId: parseInt(employeeId),
        leavePolicyId: parseInt(leavePolicyId)
      }
    },
    update: {
      balance: parseFloat(balance),
      carryOverBalance: parseFloat(carryOverBalance || 0),
      lastUpdated: new Date(),
      updatedById: updatedById ? parseInt(updatedById) : null
    },
    create: {
      employeeId: parseInt(employeeId),
      leavePolicyId: parseInt(leavePolicyId),
      balance: parseFloat(balance),
      carryOverBalance: parseFloat(carryOverBalance || 0),
      lastUpdated: new Date(),
      updatedById: updatedById ? parseInt(updatedById) : null
    },
    include: {
      leavePolicy: true,
      employee: {
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

  // Log the balance adjustment
  await logAction({
    employeeId: Number(updatedById),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Leave Balance",
    result: "SUCCESS",
    notes: `Leave Balance "${employeeId}" Updated successfully`,
  });

  return result;
};

// Accrual Services
export const runLeaveAccruals = async (data) => {
  const { accrualDate = new Date(), policyIds = [] } = data;
  const date = new Date(accrualDate);

  // Build where clause for policies
  const policyWhere = {
    active: true,
    accrualPeriod: { not: 'NONE' }
  };

  if (policyIds.length > 0) {
    policyWhere.id = { in: policyIds.map(id => parseInt(id)) };
  }

  // Get all active leave policies with accrual
  const policies = await prisma.leavePolicy.findMany({
    where: policyWhere
  });

  const results = {
    processed: 0,
    errors: [],
    details: []
  };

  for (const policy of policies) {
    try {
      // Find eligible employees for this policy
      const eligibleEmployees = await prisma.employee.findMany({
        where: {
          status: 'ACTIVE',
          hire_date: { lte: date }
        }
      });

      for (const employee of eligibleEmployees) {
        try {
          // Calculate accrual based on policy
          const accrualAmount = await calculateAccrualAmount(policy, employee, date);

          if (accrualAmount > 0) {
            await prisma.leaveBalance.upsert({
              where: {
                employeeId_leavePolicyId: {
                  employeeId: employee.id,
                  leavePolicyId: policy.id
                }
              },
              update: {
                balance: {
                  increment: accrualAmount
                },
                lastUpdated: new Date()
              },
              create: {
                employeeId: employee.id,
                leavePolicyId: policy.id,
                balance: accrualAmount,
                carryOverBalance: 0,
                lastUpdated: new Date()
              }
            });

            results.details.push({
              employeeId: employee.id,
              employeeName: `${employee.first_name} ${employee.last_name}`,
              policyId: policy.id,
              policyName: policy.name,
              accrualAmount,
              status: 'SUCCESS'
            });
          }
        } catch (error) {
          results.errors.push(`Employee ${employee.id}: ${error.message}`);
        }
      }

      results.processed += eligibleEmployees.length;
    } catch (error) {
      results.errors.push(`Policy ${policy.id}: ${error.message}`);
    }
  }

  // Log the accrual run
  await prisma.log.create({
    data: {
      type: 'LEAVE_ACCRUAL_RUN',
      action_type: 'SYSTEM',
      module: 'Leave Management',
      ip: 'SYSTEM',
      os: 'SYSTEM',
      result: results.errors.length === 0 ? 'SUCCESS' : 'PARTIAL_SUCCESS',
      notes: `Leave accrual run completed. Processed: ${results.processed}, Errors: ${results.errors.length}`,
      actionById: null
    }
  });

  return results;
};

export const getAccrualHistory = async (filters = {}) => {
  // This would typically query an accrual history table
  // For now, return logs related to accruals
  const { startDate, endDate, page = 1, limit = 20 } = filters;

  const where = {
    type: 'LEAVE_ACCRUAL_RUN'
  };

  if (startDate && endDate) {
    where.created_at = {
      gte: new Date(startDate),
      lte: new Date(endDate)
    };
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [logs, total] = await Promise.all([
    prisma.log.findMany({
      where,
      include: {
        action_by: {
          select: {
            id: true,
            first_name: true,
            last_name: true
          }
        }
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.log.count({ where })
  ]);

  return {
    data: logs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  };
};

// Holiday Services
export const getHolidays = async (filters = {}) => {
  const { year, holidayCalendarId, startDate, endDate } = filters;

  const where = {};

  if (year) {
    const start = new Date(`${year}-01-01`);
    const end = new Date(`${year}-12-31`);
    where.date = {
      gte: start,
      lte: end
    };
  }

  if (startDate && endDate) {
    where.date = {
      gte: new Date(startDate),
      lte: new Date(endDate)
    };
  }

  if (holidayCalendarId) {
    where.holidayCalendarId = parseInt(holidayCalendarId);
  }

  return await prisma.holiday.findMany({
    where,
    include: {
      holidayCalendar: true,
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
};

export const getHolidayCalendar = async (employeeId) => {
  // Get employee's assigned holiday calendar
  const employeeCalendar = await prisma.employeeHolidayCalendar.findFirst({
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
          holidays: {
            where: {
              date: { gte: new Date() }
            },
            orderBy: { date: 'asc' }
          }
        }
      }
    }
  });

  return employeeCalendar?.holidayCalendar || null;
};

export const createHoliday = async (data) => {
  const {
    holidayCalendarId,
    date,
    name,
    description,
    fullDay = true,
    createdById
  } = data;

  // Check if holiday already exists for this date in the calendar
  const existingHoliday = await prisma.holiday.findFirst({
    where: {
      holidayCalendarId: parseInt(holidayCalendarId),
      date: new Date(date)
    }
  });

  if (existingHoliday) {
    throw new Error('Holiday already exists for this date in the selected calendar');
  }

  const create =  await prisma.holiday.create({
    data: {
      holidayCalendarId: parseInt(holidayCalendarId),
      date: new Date(date),
      name,
      description,
      fullDay: Boolean(fullDay),
      createdById: parseInt(createdById)
    },
    include: {
      holidayCalendar: true,
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
    module: "Leave (Holiday)",
    result: "SUCCESS",
    notes: `Leave Holiday "${create.id}" Created successfully`,
  });

  return create;
};

// Additional Helper Functions
const createLeaveAttendanceRecords = async (leaveRequest) => {
  const { employeeId, startDate, endDate, leavePolicyId } = leaveRequest;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const current = new Date(start);

  while (current <= end) {
    const dayOfWeek = current.getDay();
    // Only create records for weekdays
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      await prisma.attendance.upsert({
        where: {
          employeeId_date: {
            employeeId,
            date: new Date(current)
          }
        },
        update: {
          status: 'ABSENT',
          remarks: `On ${(await prisma.leavePolicy.findUnique({ where: { id: leavePolicyId } }))?.name || 'Leave'}`
        },
        create: {
          employeeId,
          date: new Date(current),
          status: 'ABSENT',
          remarks: `On ${(await prisma.leavePolicy.findUnique({ where: { id: leavePolicyId } }))?.name || 'Leave'}`
        }
      });
    }
    current.setDate(current.getDate() + 1);
  }
};

// Carry Over Processing
export const processCarryOver = async (data) => {
  const { effectiveDate = new Date(), policyIds = [] } = data;
  const date = new Date(effectiveDate);

  const policyWhere = {
    active: true,
    carryForwardAllowed: true
  };

  if (policyIds.length > 0) {
    policyWhere.id = { in: policyIds.map(id => parseInt(id)) };
  }

  const policies = await prisma.leavePolicy.findMany({
    where: policyWhere
  });

  const results = {
    processed: 0,
    errors: [],
    details: []
  };

  for (const policy of policies) {
    try {
      const balances = await prisma.leaveBalance.findMany({
        where: { leavePolicyId: policy.id },
        include: {
          employee: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              status: true
            }
          }
        }
      });

      for (const balance of balances) {
        try {
          if (balance.employee.status !== 'ACTIVE') {
            continue;
          }

          const carryOverAmount = Math.min(balance.balance, policy.maxCarryForward);

          if (carryOverAmount > 0) {
            await prisma.leaveBalance.update({
              where: {
                employeeId_leavePolicyId: {
                  employeeId: balance.employeeId,
                  leavePolicyId: policy.id
                }
              },
              data: {
                carryOverBalance: carryOverAmount,
                balance: 0, // Reset balance, carry over will be added in next accrual
                lastUpdated: new Date()
              }
            });

            results.details.push({
              employeeId: balance.employeeId,
              employeeName: `${balance.employee.first_name} ${balance.employee.last_name}`,
              policyId: policy.id,
              policyName: policy.name,
              carryOverAmount,
              status: 'SUCCESS'
            });
          }
        } catch (error) {
          results.errors.push(`Employee ${balance.employeeId}: ${error.message}`);
        }
      }

      results.processed += balances.length;
    } catch (error) {
      results.errors.push(`Policy ${policy.id}: ${error.message}`);
    }
  }

  return results;
};

// Export for use in other modules
export default {
  getLeavePolicies,
  getLeavePolicyById,
  createLeavePolicy,
  updateLeavePolicy,
  deleteLeavePolicy,
  getLeaveRequests,
  getLeaveRequestById,
  createLeaveRequest,
  cancelLeaveRequest,
  updateLeaveRequest,
  getPendingApprovals,
  getLeaveRequestApprovals,
  approveLeaveRequest,
  rejectLeaveRequest,
  getLeaveBalances,
  getEmployeeLeaveBalances,
  updateLeaveBalance,
  runLeaveAccruals,
  getAccrualHistory,
  getHolidays,
  getHolidayCalendar,
  createHoliday,
  processCarryOver
};