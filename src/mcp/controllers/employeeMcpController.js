import {
  createEmployee,
  getAllEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
} from "../../controllers/hr.controller.js";
import {
  createPositionController,
  getPositionsController,
  updatePositionController,
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

export async function mcpGetEmployees(user) {
  return runController(getAllEmployees, { user });
}

export async function mcpGetEmployeeById(user, id) {
  return runController(getEmployeeById, { user, params: { id: String(id) } });
}

export async function mcpCreateEmployee(user, data) {
  return runController(createEmployee, { user, body: data });
}

export async function mcpUpdateEmployee(user, id, data) {
  return runController(updateEmployee, { user, params: { id: String(id) }, body: data });
}

export async function mcpDeleteEmployee(user, id) {
  return runController(deleteEmployee, { user, params: { id: String(id) } });
}

export async function mcpGetPositions(user) {
  return runController(getPositionsController, { user });
}

export async function mcpCreatePosition(user, data) {
  return runController(createPositionController, { user, body: data });
}

export async function mcpUpdatePosition(user, id, data) {
  return runController(updatePositionController, { user, params: { id: String(id) }, body: data });
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
