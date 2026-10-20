import { runController } from "./_runner.js";
import {
  createChecklist,
  updateChecklist,
  addTask,
  updateTask,
  deleteTask,
  signDocument,
  assignBuddy,
  submitSurvey,
  getSurveys,
} from "../../controllers/onboarding.controller.js";
import { requireEmployeeActor } from "../../lib/employeeActor.js";
import { listChecklists as listChecklistsService } from "../../services/onboarding.service.js";

// Recruitment Phase 6 — the checklist list reads the service directly: the
// controller runner cannot carry the caller's permission set, and the home
// address depends on it (the resource passes includeHomeAddress from
// hr:employee VIEW). Same envelope as the controller; scoped to the verified
// tenant.
export const mcpListOnboardingChecklists = async (user, { includeHomeAddress = false } = {}) => ({
  success: true,
  message: "Success",
  data: await listChecklistsService({
    page: 1,
    limit: 20,
    ...(user?.tenantId != null ? { tenantId: user.tenantId } : {}),
    includeHomeAddress: includeHomeAddress === true,
  }),
});
export const mcpListOnboardingSurveys = async (user, employeeId) =>
  runController(getSurveys, {
    user,
    params: { employeeId: String(employeeId || await requireEmployeeActor(user)) },
  });

export const mcpCreateOnboardingChecklist = (user, data) => runController(createChecklist, { user, body: data });
export const mcpUpdateOnboardingChecklist = (user, id, data) => runController(updateChecklist, { user, params: { id: String(id) }, body: data });
export const mcpAddOnboardingTask = (user, checklistId, data) =>
  runController(addTask, { user, params: { id: String(checklistId) }, body: data });
export const mcpUpdateOnboardingTask = (user, taskId, data) =>
  runController(updateTask, { user, params: { taskId: String(taskId) }, body: data });
export const mcpDeleteOnboardingTask = (user, taskId) => runController(deleteTask, { user, params: { taskId: String(taskId) } });
export const mcpSignOnboardingDocument = (user, docId, data) =>
  runController(signDocument, { user, params: { docId: String(docId) }, body: data });
export const mcpAssignOnboardingBuddy = (user, checklistId, data) =>
  runController(assignBuddy, { user, params: { id: String(checklistId) }, body: data });
export const mcpSubmitOnboardingSurvey = (user, data) => runController(submitSurvey, { user, body: data });
