import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Leave Policy Services
export const getLeavePolicies = async (filters = {}) => {
  const { active, search } = filters;

  const where = {};

  if (active !== undefined) {
    where.active = active === 'true';
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  return await prisma.leavePolicy.findMany({
    where,
    include: {
      approvalWorkflow: true
    }
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
      }
    }
  });
};

export const createLeavePolicy = async (data) => {
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
    approvalWorkflowId
  } = data;

  // Validate accrual period
  const validAccrualPeriods = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUAL'];
  if (!validAccrualPeriods.includes(accrualPeriod)) {
    throw new Error('Invalid accrual period');
  }

  return await prisma.leavePolicy.create({
    data: {
      name,
      description,
      leaveTypeCode,
      accrualRate: parseFloat(accrualRate),
      accrualPeriod,
      carryForwardAllowed: Boolean(carryForwardAllowed),
      maxCarryForward: parseFloat(maxCarryForward),
      minServiceMonths: parseInt(minServiceMonths),
      active: Boolean(active),
      approvalWorkflowId: approvalWorkflowId ? parseInt(approvalWorkflowId) : null
    }
  });
};

export const updateLeavePolicy = async (id, data) => {
  return await prisma.leavePolicy.update({
    where: { id },
    data
  });
};

export const deleteLeavePolicy = async (id) => {
  // Check if policy is being used by any leave requests
  const existingRequests = await prisma.leaveRequest.count({
    where: { leavePolicyId: id }
  });

  if (existingRequests > 0) {
    throw new Error('Cannot delete leave policy that has associated leave requests');
  }

  return await prisma.leavePolicy.delete({
    where: { id }
  });
};

// Leave Request Services
export const getLeaveRequests = async (filters = {}) => {
  const { employeeId, status, leavePolicyId, startDate, endDate } = filters;

  const where = {};

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
    orderBy: { created_at: 'desc' }
  });
};

export const getLeaveRequestById = async (id) => {
  return await prisma.leaveRequest.findUnique({
    where: { id },
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
        },
        orderBy: { decision_date: 'asc' }
      }
    }
  });
};

export const createLeaveRequest = async (data) => {
  const {
    employeeId,
    leavePolicyId,
    startDate,
    endDate,
    reason,
    notes
  } = data;

  // Validate dates
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (start > end) {
    throw new Error('Start date cannot be after end date');
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
    throw new Error('Overlapping leave request exists');
  }

  // Calculate duration (excluding weekends - basic implementation)
  const durationDays = calculateWorkingDays(start, end);

  // Check leave balance
  const balance = await prisma.leaveBalance.findFirst({
    where: {
      employeeId: parseInt(employeeId),
      leavePolicyId: parseInt(leavePolicyId)
    }
  });

  if (!balance || balance.balance < durationDays) {
    throw new Error('Insufficient leave balance');
  }

  return await prisma.leaveRequest.create({
    data: {
      employeeId: parseInt(employeeId),
      leavePolicyId: parseInt(leavePolicyId),
      startDate: start,
      endDate: end,
      totalDays: durationDays,
      reason,
      notes,
      status: 'PENDING'
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

export const updateLeaveRequest = async (id, data) => {
  // Prevent updates to approved/rejected requests unless specific conditions
  const existingRequest = await prisma.leaveRequest.findUnique({
    where: { id }
  });

  if (existingRequest.status !== 'PENDING') {
    throw new Error('Cannot modify non-pending leave requests');
  }

  return await prisma.leaveRequest.update({
    where: { id },
    data,
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

export const deleteLeaveRequest = async (id) => {
  const existingRequest = await prisma.leaveRequest.findUnique({
    where: { id }
  });

  if (existingRequest.status !== 'PENDING') {
    throw new Error('Cannot delete non-pending leave requests');
  }

  return await prisma.leaveRequest.delete({
    where: { id }
  });
};

// Leave Approval Services
export const getLeaveRequestApprovals = async (leaveRequestId) => {
  return await prisma.leaveRequestApproval.findMany({
    where: { leaveRequestId },
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
  });
};

export const approveLeaveRequest = async (leaveRequestId, data) => {
  const { approverId, approverRole, comments } = data;

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
      }
    }
  });

  if (!leaveRequest) {
    throw new Error('Leave request not found');
  }

  if (leaveRequest.status !== 'PENDING') {
    throw new Error('Leave request is not pending approval');
  }

  // Record approval
  await prisma.leaveRequestApproval.create({
    data: {
      leaveRequestId,
      approverId: parseInt(approverId),
      approverRole,
      decision: 'APPROVED',
      comments,
      decision_date: new Date()
    }
  });

  // Check if this was the final approval
  const workflow = leaveRequest.leavePolicy.approvalWorkflow;
  const totalSteps = workflow ? workflow.steps.length : 1;
  const approvalsCount = await prisma.leaveRequestApproval.count({
    where: { leaveRequestId, decision: 'APPROVED' }
  });

  let newStatus = leaveRequest.status;

  if (approvalsCount >= totalSteps) {
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
        }
      }
    });
  }

  return await prisma.leaveRequest.update({
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
};

export const rejectLeaveRequest = async (leaveRequestId, data) => {
  const { approverId, approverRole, comments } = data;

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
      decision_date: new Date()
    }
  });

  return await prisma.leaveRequest.update({
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
};

// Leave Balance Services
export const getLeaveBalances = async (filters = {}) => {
  const { employeeId, leavePolicyId } = filters;

  const where = {};

  if (employeeId) {
    where.employeeId = parseInt(employeeId);
  }

  if (leavePolicyId) {
    where.leavePolicyId = parseInt(leavePolicyId);
  }

  return await prisma.leaveBalance.findMany({
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
      leavePolicy: true
    }
  });
};

export const getEmployeeLeaveBalances = async (employeeId) => {
  return await prisma.leaveBalance.findMany({
    where: { employeeId },
    include: {
      leavePolicy: true
    }
  });
};

export const updateLeaveBalance = async (employeeId, data) => {
  const { leavePolicyId, balance, carryOverBalance } = data;

  return await prisma.leaveBalance.upsert({
    where: {
      employeeId_leavePolicyId: {
        employeeId: parseInt(employeeId),
        leavePolicyId: parseInt(leavePolicyId)
      }
    },
    update: {
      balance: parseFloat(balance),
      carryOverBalance: parseFloat(carryOverBalance),
      lastUpdated: new Date()
    },
    create: {
      employeeId: parseInt(employeeId),
      leavePolicyId: parseInt(leavePolicyId),
      balance: parseFloat(balance),
      carryOverBalance: parseFloat(carryOverBalance),
      lastUpdated: new Date()
    },
    include: {
      leavePolicy: true
    }
  });
};

// Accrual Services
export const runLeaveAccruals = async (data) => {
  const { accrualDate = new Date() } = data;
  const date = new Date(accrualDate);

  // Get all active leave policies with accrual
  const policies = await prisma.leavePolicy.findMany({
    where: {
      active: true,
      accrualPeriod: { not: 'NONE' }
    }
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
          status: 'ACTIVE', // Assuming active employees
          hire_date: { lte: date } // Hired before accrual date
        }
      });

      for (const employee of eligibleEmployees) {
        try {
          // Calculate accrual based on policy
          const accrualAmount = calculateAccrualAmount(policy, employee, date);

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
              policyId: policy.id,
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

  return results;
};

export const getAccrualHistory = async (filters = {}) => {
  // This would typically query an accrual history table
  // For now, return empty array as placeholder
  return [];
};

// Helper Functions
const calculateWorkingDays = (start, end) => {
  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip Sunday (0) and Saturday (6)
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
};

const calculateAccrualAmount = (policy, employee, date) => {
  // Basic accrual calculation - extend based on your business rules
  switch (policy.accrualPeriod) {
    case 'MONTHLY':
      return policy.accrualRate;
    case 'QUARTERLY':
      return policy.accrualRate * 3;
    case 'ANNUAL':
      return policy.accrualRate;
    default:
      return 0;
  }
};