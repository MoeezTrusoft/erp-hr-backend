// src/mcp/controllers/benefitMcpController.js — HR-BENEFITS-04 (MCP facade)
//
// Thin MCP wrappers over the EXISTING benefits HTTP controller
// (src/controllers/benefit.controller.js), dispatched through the shared
// runController so the tools reuse the same service path, tenant scoping
// (req.user.tenantId — T-P2.1) and {SVC}-nnnn error mapping as the REST routes.
// No net-new behaviour: each function mirrors a benefit.routes.js endpoint.
import { runController } from "./_runner.js";
import {
  createPlan,
  listPlans,
  getPlan,
  updatePlan,
  deletePlan,
  enrollEmployee,
  unenrollEmployee,
  listEmployeeBenefits,
} from "../../controllers/benefit.controller.js";

export const mcpListBenefitPlans = (user, query = {}) =>
  runController(listPlans, { user, query });
export const mcpGetBenefitPlan = (user, id) =>
  runController(getPlan, { user, params: { id: String(id) } });
export const mcpCreateBenefitPlan = (user, data) =>
  runController(createPlan, { user, body: data });
export const mcpUpdateBenefitPlan = (user, id, data) =>
  runController(updatePlan, { user, params: { id: String(id) }, body: data });
export const mcpDeleteBenefitPlan = (user, id) =>
  runController(deletePlan, { user, params: { id: String(id) } });

export const mcpEnrollBenefit = (user, employeeId, data) =>
  runController(enrollEmployee, { user, params: { employeeId: String(employeeId) }, body: data });
export const mcpUnenrollBenefit = (user, employeeId, benefitPlanId) =>
  runController(unenrollEmployee, {
    user,
    params: { employeeId: String(employeeId), benefitPlanId: String(benefitPlanId) },
  });
export const mcpListEmployeeBenefits = (user, employeeId, query = {}) =>
  runController(listEmployeeBenefits, { user, params: { employeeId: String(employeeId) }, query });
