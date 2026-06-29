// src/mcp/controllers/taxFormMcpController.js — HR-PAY-07 / HR-SEC-05 (MCP facade)
//
// Thin MCP wrappers over the EXISTING year-end tax-form HTTP controller
// (src/controllers/taxFormController.js) mounted on the C4 payroll surface in
// payrollRoutes.js. Dispatched through runController so the tools reuse the same
// service path, tenant scoping (req.user.tenantId — the VERIFIED claim) and C4
// audit-read as the REST routes. No net-new behaviour.
import { runController } from "./_runner.js";
import {
  getYearEndTaxForms,
  exportYearEndTaxForms,
} from "../../controllers/taxFormController.js";

export const mcpListYearEndTaxForms = (user, taxYear) =>
  runController(getYearEndTaxForms, { user, params: { taxYear: String(taxYear) } });

export const mcpExportYearEndTaxForms = (user, taxYear, query = {}) =>
  runController(exportYearEndTaxForms, { user, params: { taxYear: String(taxYear) }, query });
