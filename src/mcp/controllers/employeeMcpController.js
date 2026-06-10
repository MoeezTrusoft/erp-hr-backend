import { deleteEmployee } from "../../controllers/hr.controller.js";
import {
  deletePositionController,
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

export async function mcpGetEmployees(user, args = {}) {
  return hrContractService.listEmployees(args);
}

export async function mcpListEmployeesContract(query = {}) {
  return hrContractService.listEmployees(query);
}

export async function mcpGetEmployeeById(user, id) {
  return { success: true, data: await hrContractService.getEmployeeProfile(id) };
}

export async function mcpGetEmployeeQuickView(user, id) {
  return { success: true, data: await hrContractService.getEmployeeQuickView(id) };
}

export async function mcpGetEmployeeDocuments(user, id) {
  return { success: true, data: await hrContractService.getEmployeeDocuments(id) };
}

export async function mcpUpdateEmployeeStatus(user, id, status, actorId) {
  return {
    success: true,
    data: await hrContractService.updateEmployeeStatus(id, status, actorId),
  };
}

export async function mcpCreateEmployee(user, data) {
  return hrContractService.createEmployee(data, user?.employeeId || user?.userId);
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
  return hrContractService.listPositions({ page: 1, pageSize: 10 });
}

export async function mcpListPositionsContract(query = {}) {
  return hrContractService.listPositions(query);
}

export async function mcpCreatePosition(user, data) {
  return hrContractService.createPosition(data, user?.employeeId || user?.userId);
}

export async function mcpUpdatePosition(user, id, data) {
  return hrContractService.updatePosition(id, data);
}

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
  return runController(createEmergencyContactController, { user, body: data });
}

export async function mcpUpdateEmergencyContact(user, id, data) {
  return runController(updateEmergencyContactController, { user, params: { id: String(id) }, body: data });
}

export async function mcpDeleteEmergencyContact(user, id) {
  return runController(deleteEmergencyContactController, { user, params: { id: String(id) } });
}
