import { runController } from "./_runner.js";
import {
  createChecklist,
  listChecklists,
  updateChecklist,
  addTask,
  updateTask,
  deleteTask,
  signDocument,
  assignBuddy,
  submitSurvey,
  getSurveys,
} from "../../controllers/onboarding.controller.js";

export const mcpListOnboardingChecklists = (user) => runController(listChecklists, { user });
export const mcpListOnboardingSurveys = (user, employeeId) =>
  runController(getSurveys, { user, params: { employeeId: String(employeeId || user.employeeId || user.userId || "") } });

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
