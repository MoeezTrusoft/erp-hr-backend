// src/mcp/tools/employeeImportTools.js
//
// Employee directory BULK IMPORT — two tools:
//   hr_employees_import_template  → download the empty .xlsx template
//   hr_employees_import           → upload a filled .csv/.xlsx; validate,
//                                   auto-fix, annotate, and (optionally) commit.
// Both return the file as base64 (same delivery pattern as hr_employees_export).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission, hasPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { generateImportTemplate, runEmployeeImport } from "../../services/employeeImport.service.js";
import { getLoginPasswords } from "../../services/loginCredential.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerEmployeeImportTools(server) {
  // ── Download the empty template (gate: hr:employee VIEW) ────────────────────
  server.tool(
    "hr_employees_import_template",
    "Download the empty employee bulk-import spreadsheet (.xlsx) — friendly headers, dropdowns (gender/marital status/department/grade/manager/employment type/status/work mode/currency/create-login/emergency relationship), date pickers, an Example tab and an Instructions tab. Manager/department/position/grade dropdowns are pre-filled from THIS tenant's records. Returns the file as base64. Fill the 'Employees' tab and upload it to hr_employees_import.",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await generateImportTemplate({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employees_import_template")
  );

  // ── Import a filled sheet (gate: hr:employee CREATE) ────────────────────────
  server.tool(
    "hr_employees_import",
    "Bulk-import employees from an uploaded .csv/.xlsx (base64). Validates and AUTO-FIXES every row (enum synonyms, many date formats, email/phone normalization, name→id lookups); anything unfixable is FLAGGED on a returned annotated .xlsx (red cell + plain-English __issues, colour-coded __row_status). Runs a PREVIEW by default (dryRun=true, nothing saved). Set dryRun=false to commit OK/auto-fixed rows (skips reds); upsert on employee_code, optional RBAC login provisioning per the create_login/role columns.",
    {
      fileBase64: z
        .string()
        .min(1)
        .describe("The uploaded spreadsheet as base64 (raw or data: URI). Use the template from hr_employees_import_template."),
      format: z
        .enum(["xlsx", "csv"])
        .optional()
        .describe("Uploaded file format. Defaults to xlsx."),
      dryRun: z
        .coerce.boolean()
        .optional()
        .describe("true (DEFAULT) = validate + return the annotated preview WITHOUT saving. false = commit OK/auto-fixed rows."),
      upsert: z
        .coerce.boolean()
        .optional()
        .describe("true (DEFAULT) = a row whose employee_code already exists UPDATES that employee. false = flag existing codes as errors."),
      dayFirst: z
        .coerce.boolean()
        .optional()
        .describe("How to read ambiguous DD/MM vs MM/DD dates. true (DEFAULT) = day-first (DD/MM/YYYY)."),
    },
    withToolError(async ({ fileBase64, format, dryRun, upsert, dayFirst }) => {
      const { user, permissions, correlationId } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await runEmployeeImport({
        user,
        tenantId: user.tenantId,
        fileBase64,
        format: format ?? "xlsx",
        dryRun: dryRun === undefined ? true : dryRun,
        upsert: upsert === undefined ? true : upsert,
        dayFirst: dayFirst === undefined ? true : dayFirst,
        correlationId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employees_import")
  );

  // ── Read back auto-generated login passwords (gate: hr:employee EXPORT) ──────
  server.tool(
    "hr_employee_login_password_get",
    "Read the auto-generated login password(s) stored for imported employees (decrypted from the C4-encrypted copy). Pass employeeId for one, employeeIds for several, or all:true for every employee that has a stored password. SENSITIVE — gated on hr:employee EXPORT. Returns [{ employeeId, employeeCode, name, workEmail, loginEmail, password }].",
    {
      employeeId: z.coerce.number().int().optional().describe("Single Employee.id to read the password for."),
      employeeIds: z.array(z.coerce.number().int()).optional().describe("Several Employee.id values to read passwords for."),
      all: z.coerce.boolean().optional().describe("true = return every employee in the tenant that has a stored login password. Ignored if employeeId/employeeIds is given."),
    },
    withToolError(async ({ employeeId, employeeIds, all }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      // Reading credentials is elevated — require the EXPORT action on top of VIEW.
      if (!hasPermission(permissions, "hr:employee", "EXPORT")) {
        throw Object.assign(new Error("Insufficient permissions: hr:employee:EXPORT"), { status: 403 });
      }
      const data = await getLoginPasswords({ tenantId: user.tenantId, employeeId, employeeIds, all });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_login_password_get")
  );
}
