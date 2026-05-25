import * as hrContract from "../services/hrContract.service.js";
import { sendContractError, sendContractSuccess } from "../utils/apiContract.js";

const actorId = (req) => req.user?.employeeId || req.user?.userId;

const handle = (fn, successMessage, statusCode = 200) => async (req, res) => {
  try {
    const data = await fn(req);
    return sendContractSuccess(res, data, successMessage, statusCode);
  } catch (error) {
    const status = error?.message?.toLowerCase().includes("not found") ? 404 : 400;
    return sendContractError(res, error, status, status === 404 ? "NOT_FOUND" : "BAD_REQUEST");
  }
};

const firstFile = (req) => req.files?.[0] || req.file || null;

export const getDashboardWidgets = handle(
  () => hrContract.getDashboardWidgetCatalog(),
  "Dashboard widget catalog loaded"
);

export const getDashboardSummary = handle(
  () => hrContract.getDashboardSummary(),
  "Dashboard summary loaded"
);

export const getDashboardLayout = handle(
  (req) => hrContract.getDashboardLayout(actorId(req)),
  "Dashboard layout loaded"
);

export const saveDashboardLayout = handle(
  (req) => hrContract.saveDashboardLayout(actorId(req), req.body),
  "Dashboard layout saved"
);

export const resetDashboardLayout = handle(
  (req) => hrContract.saveDashboardLayout(actorId(req), { widgets: [] }),
  "Dashboard layout reset"
);

export const listEmployees = handle(
  (req) => hrContract.listEmployees(req.query),
  "Employees loaded"
);

export const createEmployee = handle(
  (req) => hrContract.createEmployee(req.body, actorId(req)),
  "Employee created",
  201
);

export const getEmployeeQuickView = handle(
  (req) => hrContract.getEmployeeQuickView(req.params.id),
  "Employee quick view loaded"
);

export const getEmployeeProfile = handle(
  (req) => hrContract.getEmployeeProfile(req.params.id),
  "Employee profile loaded"
);

export const getEmployeeProfileOverview = handle(
  (req) => hrContract.getEmployeeProfile(req.params.id).then((profile) => profile.overview),
  "Employee profile overview loaded"
);

export const getEmployeeDocuments = handle(
  (req) => hrContract.getEmployeeDocuments(req.params.id),
  "Employee documents loaded"
);

export const updateEmployee = handle(
  (req) => hrContract.updateEmployee(req.params.id, req.body, actorId(req)),
  "Employee updated"
);

export const updateEmployeeStatus = handle(
  (req) => hrContract.updateEmployeeStatus(req.params.id, req.body.status, actorId(req)),
  "Employee status updated"
);

export const uploadEmployeeProfilePhoto = handle(
  (req) => hrContract.uploadEmployeeProfilePhoto(req.params.id, req.body, firstFile(req), actorId(req)),
  "Employee profile photo uploaded"
);

export const uploadEmployeeCoverPhoto = handle(
  (req) => hrContract.uploadEmployeeCoverPhoto(req.params.id, req.body, firstFile(req), actorId(req)),
  "Employee cover photo uploaded"
);

export const createEmployeeDocument = handle(
  (req) => hrContract.createEmployeeDocument(req.params.id, req.body, firstFile(req), actorId(req)),
  "Employee document created",
  201
);

export const updateEmployeeDocument = handle(
  (req) => hrContract.updateEmployeeDocument(req.params.id, req.params.documentId, req.body, firstFile(req), actorId(req)),
  "Employee document updated"
);

export const deleteEmployeeDocument = handle(
  (req) => hrContract.deleteEmployeeDocument(req.params.id, req.params.documentId),
  "Employee document deleted"
);

export const listEmployeeEmergencyContacts = handle(
  (req) => hrContract.listEmployeeEmergencyContacts(req.params.id),
  "Employee emergency contacts loaded"
);

export const createEmployeeEmergencyContact = handle(
  (req) => hrContract.createEmployeeEmergencyContact(req.params.id, req.body),
  "Employee emergency contact created",
  201
);

export const updateEmployeeEmergencyContact = handle(
  (req) => hrContract.updateEmployeeEmergencyContact(req.params.id, req.params.contactId, req.body),
  "Employee emergency contact updated"
);

export const deleteEmployeeEmergencyContact = handle(
  (req) => hrContract.deleteEmployeeEmergencyContact(req.params.id, req.params.contactId),
  "Employee emergency contact deleted"
);

export const listPositions = handle(
  (req) => hrContract.listPositions(req.query),
  "Positions loaded"
);

export const getPosition = handle(
  (req) => hrContract.getPosition(req.params.id),
  "Position loaded"
);

export const createPosition = handle(
  (req) => hrContract.createPosition(req.body, actorId(req)),
  "Position created",
  201
);

export const updatePosition = handle(
  (req) => hrContract.updatePosition(req.params.id, req.body),
  "Position updated"
);

export const updatePositionStatus = handle(
  (req) => {
    if (typeof req.body.isActive !== "boolean") {
      throw new Error("isActive boolean is required");
    }

    return hrContract.updatePositionStatus(req.params.id, req.body.isActive);
  },
  "Position status updated"
);

export const listRequisitions = handle(
  (req) => hrContract.listRequisitions(req.query),
  "Requisitions loaded"
);

export const getRequisition = handle(
  (req) => hrContract.getRequisition(req.params.id),
  "Requisition loaded"
);

export const createRequisition = handle(
  (req) => hrContract.createRequisition(req.body, actorId(req)),
  "Requisition created",
  201
);

export const updateRequisition = handle(
  (req) => hrContract.updateRequisition(req.params.id, req.body),
  "Requisition updated"
);

export const submitRequisition = handle(
  (req) => hrContract.submitRequisition(req.params.id, actorId(req), req.body.comments),
  "Requisition submitted"
);

export const approveRequisition = handle(
  (req) => hrContract.approveRequisition(req.params.id, actorId(req), req.body.comments),
  "Requisition approved"
);

export const rejectRequisition = handle(
  (req) => hrContract.rejectRequisition(req.params.id, actorId(req), req.body.comments),
  "Requisition rejected"
);

export const closeRequisition = handle(
  (req) => hrContract.closeRequisition(req.params.id, actorId(req), req.body.comments),
  "Requisition closed"
);

export const reopenRequisition = handle(
  (req) => hrContract.reopenRequisition(req.params.id, actorId(req), req.body.comments),
  "Requisition reopened"
);
