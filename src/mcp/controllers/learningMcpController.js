import {
  createCourse,
  getCourses,
  updateCourse,
  deleteCourse,
  createCategory,
  getCategories,
} from "../../controllers/trainingController.js";
import {
  enrollUser,
  bulkEnrollUsers,
  updateEnrollmentStatus,
  updateProgress,
  cancelEnrollment,
} from "../../controllers/enrollmentController.js";
import { createPath, listPaths } from "../../controllers/learningPath.controller.js";
import { createCertification, listCertifications, getCertification, updateCertification, deleteCertification } from "../../controllers/certification.controller.js";
import { listSkills } from "../../controllers/employeeSkill.controller.js";
import { listSessions } from "../../controllers/trainingSession.controller.js";

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
    user: {
      id: user.userId ? Number(user.userId) : undefined,
      userId: user.userId ? Number(user.userId) : undefined,
      employeeId: user.employeeId ? Number(user.employeeId) : undefined,
      email: user.email || undefined,
      role: Array.isArray(user.roles) && user.roles.length ? String(user.roles[0]) : user.isAdmin ? "HR_ADMIN" : "EMPLOYEE",
      roles: Array.isArray(user.roles) ? user.roles : [],
      isAdmin: !!user.isAdmin,
    },
    files: [],
    ip: "127.0.0.1",
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
    send(data) {
      payload = data;
      return this;
    },
    end(data) {
      if (data !== undefined) payload = data;
      return this;
    },
  };

  try {
    await controller(req, res);
  } catch (error) {
    throw Object.assign(new Error(error?.message || "Controller execution failed"), { status: 500 });
  }

  if (statusCode >= 400) {
    const message = payload?.message || payload?.error || "Request failed";
    throw Object.assign(new Error(message), { status: statusCode });
  }

  return payload;
}

export const mcpListTrainingCourses = (user) => runController(getCourses, { user });
export const mcpListTrainingCategories = (user) => runController(getCategories, { user });
export const mcpListLearningPaths = (user) => runController(listPaths, { user });
export const mcpListCertifications = (user, args = {}) => runController(listCertifications, { user, query: args });
export const mcpListSkills = (user) => runController(listSkills, { user });
export const mcpListTrainingSessions = (user) => runController(listSessions, { user });

export const mcpCreateTrainingCourse = (user, data) => runController(createCourse, { user, body: data });
export const mcpUpdateTrainingCourse = (user, id, data) =>
  runController(updateCourse, { user, params: { id: String(id) }, body: data });
export const mcpDeleteTrainingCourse = (user, id) => runController(deleteCourse, { user, params: { id: String(id) } });
export const mcpCreateTrainingCategory = (user, data) => runController(createCategory, { user, body: data });

export const mcpCreateTrainingEnrollment = (user, data) => runController(enrollUser, { user, body: data });
export const mcpBulkTrainingEnrollment = (user, data) => runController(bulkEnrollUsers, { user, body: data });
export const mcpUpdateTrainingEnrollmentStatus = (user, id, data) =>
  runController(updateEnrollmentStatus, { user, params: { id: String(id) }, body: data });
export const mcpUpdateTrainingEnrollmentProgress = (user, id, data) =>
  runController(updateProgress, { user, params: { id: String(id) }, body: data });
export const mcpCancelTrainingEnrollment = (user, id) =>
  runController(cancelEnrollment, { user, params: { id: String(id) } });

export const mcpCreateCertification = (user, data) => runController(createCertification, { user, body: data });
export const mcpGetCertification = (user, id) => runController(getCertification, { user, params: { id: String(id) } });
export const mcpUpdateCertification = (user, id, data) =>
  runController(updateCertification, { user, params: { id: String(id) }, body: data });
export const mcpDeleteCertification = (user, id) => runController(deleteCertification, { user, params: { id: String(id) } });
export const mcpCreateLearningPath = (user, data) => runController(createPath, { user, body: data });
