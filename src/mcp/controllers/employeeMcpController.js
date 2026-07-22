import { deleteEmployee } from "../../controllers/hr.controller.js";
import {
  deletePositionController,
  getPositionByIdController,
} from "../../controllers/position.controller.js";
import { getOrgChart as getOrgChartController } from "../../controllers/orgChart.controller.js";
import { logLifecycleEvent } from "../../controllers/employeeLifecycle.controller.js";
import {
  createOffboarding as createOffboardingController,
  updateOffboarding as updateOffboardingController,
} from "../../controllers/offboarding.controller.js";
import {
  create as createEmergencyContactController,
  update as updateEmergencyContactController,
  remove as deleteEmergencyContactController,
} from "../../controllers/emergencyContacts.controller.js";
import * as hrContractService from "../../services/hrContract.service.js";
import { getEmployeeConsolidatedProfile } from "../../services/employeeProfile.service.js";
import { getEmployeeProfileTab } from "../../services/employeeProfileTabs.service.js";
import logger from "../../lib/logger.js";

async function runController(controller, { user = {}, params = {}, query = {}, body = {} } = {}) {
  const req = {
    params,
    query,
    body,
    headers: {
      "user-id": user.userId ? String(user.userId) : "",
      "employee-id": user.employeeId ? String(user.employeeId) : "",
      "x-employee-id": user.employeeId ? String(user.employeeId) : "",
      "x-user-id": user.userId ? String(user.userId) : "",
      "x-internal": "true",
    },
    files: [],
  };

  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
  };

  try {
    await controller(req, res);
  } catch (error) {
    const err = Object.assign(new Error(error?.message || "Controller execution failed"), { status: 500 });
    throw err;
  }

  if (statusCode >= 400) {
    const message = payload?.message || payload?.error || "Request failed";
    throw Object.assign(new Error(message), { status: statusCode });
  }

  return payload;
}

// BLOCKER-1 / C.2 — thread the VERIFIED tenant (user.tenantId — the RBAC
// Company.uuid from the service-JWT claim, NEVER a request header) into every
// hrContract read so a tool can only ever see its own tenant's rows. `?? null`
// keeps it fail-closed: a missing tenant scopes to null-tenant, never widens.
export async function mcpGetEmployees(user, args = {}) {
  return hrContractService.listEmployees(args, user?.tenantId ?? null);
}

export async function mcpListEmployeesContract(query = {}, tenantId) {
  return hrContractService.listEmployees(query, tenantId ?? null);
}

export async function mcpExportEmployees(query = {}, tenantId, format = "csv") {
  return { success: true, data: await hrContractService.exportEmployees(query, tenantId ?? null, format) };
}

export async function mcpGetEmployeeById(user, id) {
  return { success: true, data: await hrContractService.getEmployeeProfile(id, user?.tenantId ?? null) };
}

// Consolidated employee profile (department/company from RBAC, bank block, ntn,
// tax slab, EOBI/PF, monthly/YTD tax, compensation history, skills/competencies,
// certifications, documents). Sensitive fields (raw salary/account/iban/ntn) are
// gated on `showSensitive` — set by the tool from the caller's hr:payroll VIEW.
export async function mcpGetEmployeeProfile(user, id, opts = {}) {
  return {
    success: true,
    data: await getEmployeeConsolidatedProfile(id, user?.tenantId ?? null, opts),
  };
}

// Tab-scoped profile: fetches ONE tab's data + the always-on identity header.
export async function mcpGetEmployeeProfileTab(user, id, opts = {}) {
  return {
    success: true,
    data: await getEmployeeProfileTab(id, user?.tenantId ?? null, opts),
  };
}


export async function mcpGetEmployeeQuickView(user, id) {
  return { success: true, data: await hrContractService.getEmployeeQuickView(id, user?.tenantId ?? null) };
}

export async function mcpGetEmployeeDocuments(user, id) {
  return { success: true, data: await hrContractService.getEmployeeDocuments(id, user?.tenantId ?? null) };
}

export async function mcpUpdateEmployeeStatus(user, id, status, actorId) {
  return {
    success: true,
    data: await hrContractService.updateEmployeeStatus(id, status, actorId),
  };
}

export async function mcpCreateEmployee(user, data, ctx = {}) {
  // T-P2.2/T-P2.6 + A.4: thread the VERIFIED tenant (user.tenantId, from the
  // service-JWT claim — never the request body) and the request correlationId so
  // createEmployee writes tenant_id and emits the hr.employee.lifecycle.v1 event
  // in-tx. actorId stays the acting principal.
  return hrContractService.createEmployee(data, user?.employeeId || user?.userId, {
    tenantId: user?.tenantId ?? null,
    correlationId: ctx.correlationId,
    actorId: user?.employeeId || user?.userId,
  });
}

export async function mcpUpdateEmployee(user, id, data) {
  return hrContractService.updateEmployee(id, data, user?.employeeId || user?.userId);
}

export async function mcpDeleteEmployee(user, id) {
  return runController(deleteEmployee, { user, params: { id: String(id) } });
}

export async function mcpUploadEmployeeProfilePhoto(user, id, data) {
  return hrContractService.uploadEmployeeProfilePhoto(id, data, null, user?.employeeId || user?.userId);
}

export async function mcpUploadEmployeeCoverPhoto(user, id, data) {
  return hrContractService.uploadEmployeeCoverPhoto(id, data, null, user?.employeeId || user?.userId);
}

export async function mcpCreateEmployeeDocument(user, employeeId, data) {
  return hrContractService.createEmployeeDocument(employeeId, data, null, user?.employeeId || user?.userId);
}

export async function mcpGetPositions(user) {
  return hrContractService.listPositions({ page: 1, pageSize: 10 }, user?.tenantId ?? null);
}

export async function mcpListPositionsContract(query = {}, tenantId) {
  return hrContractService.listPositions(query, tenantId ?? null);
}

export async function mcpCreatePosition(user, data) {
  // T-P2.6: thread the verified tenant (RBAC Company.uuid, resolved by
  // buildContextFromHeaders from the gateway-forwarded X-Tenant-Id header)
  // so the created Position row is correctly tenant-scoped.
  const tenantId = user?.tenantId ?? null;
  const actorId = user?.employeeId || user?.userId;
  return hrContractService.createPosition(data, actorId, tenantId);
}

export async function mcpUpdatePosition(user, id, data) {
  return hrContractService.updatePosition(id, data);
}

export const mcpGetPositionByPositionId = (user, id) => runController(getPositionByIdController, { user, params: { id: String(id) } });

export async function mcpUpdatePositionStatus(user, id, isActive) {
  return hrContractService.updatePositionStatus(id, isActive);
}

export async function mcpDeletePosition(user, id) {
  return runController(deletePositionController, { user, params: { id: String(id) } });
}


export async function mcpGetOrgChart(user) {
  return runController(getOrgChartController, { user });
}

export async function mcpCreateEmployeeLifecycle(user, data) {
  return runController(logLifecycleEvent, { user, body: data });
}

export async function mcpCreateOffboarding(user, data) {
  return runController(createOffboardingController, { user, body: data });
}

export async function mcpUpdateOffboarding(user, id, data) {
  return runController(updateOffboardingController, { user, params: { id: String(id) }, body: data });
}

export async function mcpCreateEmergencyContact(user, data) {
  // LOG-1: NEVER log the raw `data` — emergency-contact fields (name, phone,
  // relationship) are PII and console.* bypasses the pino redact surface. Trace
  // at debug with the tool name only.
  logger.debug({ toolName: "mcpCreateEmergencyContact" }, "MCP tool called");
  return runController(createEmergencyContactController, { user, body: data });
}

export async function mcpUpdateEmergencyContact(user, id, data) {
  return runController(updateEmergencyContactController, { user, params: { id: String(id) }, body: data });
}

export async function mcpDeleteEmergencyContact(user, id) {
  return runController(deleteEmergencyContactController, { user, params: { id: String(id) } });
}
