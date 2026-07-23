import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { runMcpIdempotent } from "../../middlewares/idempotency.middleware.js";
import logger from "../../lib/logger.js";
import { getEmployeeCompensation } from "../../services/employeeCompensation.service.js";
import { listEmployeeActivity } from "../../services/employeeActivity.service.js";
import {
  mcpCreateEmergencyContact,
  mcpCreateEmployee,
  mcpCreateEmployeeDocument,
  mcpCreateEmployeeLifecycle,
  mcpCreateOffboarding,
  mcpCreatePosition,
  mcpDeleteEmergencyContact,
  mcpDeleteEmployee,
  mcpDeletePosition,
  mcpGetEmployeeById,
  mcpGetEmployeeProfile,
  mcpGetEmployeeProfileTab,
  mcpGetEmployeeDocuments,
  mcpGetEmployeeQuickView,
  mcpGetEmployees,
  mcpGetOrgChart,
  mcpGetPositions,
  mcpListEmployeesContract,
  mcpExportEmployees,
  mcpListPositionsContract,
  mcpUpdateEmergencyContact,
  mcpUpdateEmployee,
  mcpUpdateEmployeeStatus,
  mcpUpdateOffboarding,
  mcpUpdatePosition,
  mcpGetPositionByPositionId,
  mcpUpdatePositionStatus,
  mcpUploadEmployeeCoverPhoto,
  mcpUploadEmployeeProfilePhoto,
} from "../controllers/employeeMcpController.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Per-column search params (directory per-column search boxes). Each restricts
// the query to its own column(s); ANDed together and with the generic `q`.
const columnSearchShape = {
  nameQ: z.string().optional().describe("Column search: employee name"),
  codeQ: z.string().optional().describe("Column search: employee code"),
  departmentQ: z.string().optional().describe("Column search: department (business unit name)"),
  roleQ: z.string().optional().describe("Column search: role / job title"),
  emailQ: z.string().optional().describe("Column search: email"),
  statusQ: z.string().optional().describe("Column search: status"),
  managerQ: z.string().optional().describe("Column search: manager name"),
};

const listToolShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  q: z.string().optional(),
  status: z.string().optional(),
  positionId: z.union([z.string(), z.number()]).optional(),
  companyId: z.union([z.string(), z.number()]).optional(),
  departmentId: z.union([z.string(), z.number()]).optional(),
  joinedFrom: z.string().optional().describe("Filter: joining date >= this ISO date (YYYY-MM-DD)"),
  joinedTo: z.string().optional().describe("Filter: joining date <= this ISO date (YYYY-MM-DD)"),
  sort: z
    .string()
    .optional()
    .describe(
      "Sort key: employee_name | employee_code | department | role | status | manager | hire_date | created_at | updated_at"
    ),
  order: z.enum(["asc", "desc"]).optional(),
  ...columnSearchShape,
};

const mediaPayloadShape = {
  id: z.string().min(1),
  fileBase64: z.string().optional().describe("Raw base64 or data: URI of the image. BE uploads to DAM and derives mediaId/url/size."),
  mediaId: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
  downloadUrl: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  fileSize: z.union([z.string(), z.number()]).optional(),
};

export function registerEmployeeTools(server) {
  server.resource(
    "hr_employees_resource",
    "hr://employees",
    { description: "List all employees with optional filters (page, limit, department, status)" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpGetEmployees(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.tool(
    "hr_employees_list",
    "List employees for the HR frontend directory",
    listToolShape,
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const query = { page: 1, pageSize: 10, ...args };
      logger.debug({ page: query.page, pageSize: query.pageSize }, "MCP hr_employees_list pagination resolved");
      // BLOCKER-1: thread the verified tenant so the directory is tenant-scoped.
      const data = await mcpListEmployeesContract(query, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employees_list")
  );

  server.tool(
    "hr_employees_export",
    "Export the employee directory (all rows matching the filters) as CSV or PDF. Returns { format, fileName, mimeType, count, base64 }.",
    {
      format: z.enum(["csv", "pdf"]).default("csv"),
      q: z.string().optional(),
      status: z.string().optional(),
      positionId: z.union([z.string(), z.number()]).optional(),
      departmentId: z.union([z.string(), z.number()]).optional(),
      joinedFrom: z.string().optional().describe("Filter: joining date >= this ISO date (YYYY-MM-DD)"),
      joinedTo: z.string().optional().describe("Filter: joining date <= this ISO date (YYYY-MM-DD)"),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
      ...columnSearchShape,
    },
    withToolError(async ({ format, ...query }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await mcpExportEmployees(query, user.tenantId, format);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employees_export")
  );

  server.resource(
    "hr_positions_resource",
    "hr://positions",
    { description: "List all job positions" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpGetPositions(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.tool(
    "hr_positions_list",
    "List positions for HR frontend selectors and management screens",
    {
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(10),
      q: z.string().optional(),
      status: z.string().optional(),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const query = { page: 1, pageSize: 10, ...args };
      logger.debug({ page: query.page, pageSize: query.pageSize }, "MCP hr_positions_list pagination resolved");
      // BLOCKER-1: thread the verified tenant so positions are tenant-scoped.
      const data = await mcpListPositionsContract(query, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_positions_list")
  );

  server.resource(
    "hr_org_chart",
    "hr://org-chart",
    { description: "Get the full organizational hierarchy chart" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpGetOrgChart(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  const registerEmployeeProfileTool = (toolName, handler) => {
    server.tool(
      toolName,
      "Get a specific employee profile by ID for edit/detail screens",
      { id: z.string().min(1).describe("Employee ID") },
      withToolError(async ({ id }) => {
        const { user, permissions } = getCtx();
        assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
        const data = await handler(user, id);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }, toolName)
    );
  };

  registerEmployeeProfileTool("hr_employee_get", mcpGetEmployeeById);

  // Consolidated profile: company/department (RBAC), pay grade, middle name,
  // bank block (A/C title, bank, account #, IBAN, branch, disbursement), NTN,
  // tax slab (PK FY), EOBI/PF, monthly + YTD tax, compensation history,
  // skills/competencies, certifications, and documents. Raw salary/account/iban/
  // ntn are surfaced only to callers with hr:payroll VIEW (else masked).
  // Tab-scoped profile: returns an always-on identity header + ONE tab's data.
  //   overview     — personal info, employment details, contact, quick stats, skills/competencies, certifications
  //   job_and_comp — company/dept, pay grade, bank block, NTN, tax slab, EOBI/PF, monthly &
  //                  YTD tax, compensation history, CTC/basic/allowances/variable bonus/equity
  //   documents    — verified/pending/expiring-90d/missing counts + employee documents list
  //   performance  — goals, performance potential, recognition
  //   leaves       — balances (annual/casual/sick), history, upcoming + team coverage, holidays, hours
  //   training     — hours completed, courses done, avg score, certificates, recommended, enrolled & completed
  //   activity     — last login, device, 2FA, sessions (30d), failed attempts, permissions & roles (from RBAC)
  // Sensitive fields (raw salary/account/iban/ntn/national-id/CTC) surface only for hr:payroll VIEW callers.
  server.tool(
    "hr_employee_profile_get",
    "Get a tab-scoped employee profile (identity header + one tab's data). tab = overview | job_and_comp | documents | performance | leaves | training | activity",
    {
      id: z.string().min(1).describe("Employee ID"),
      tab: z.enum(["overview", "job_and_comp", "documents", "performance", "leaves", "training", "activity"]).optional().default("overview").describe("Which tab's data to fetch (default overview)"),
      taxFiscalYear: z.string().optional().describe("Override the Pakistan fiscal year for the job_and_comp tax slab, e.g. 'FY26'."),
      page: z.coerce.number().int().min(1).optional().describe("Page for the paginated sections (documents/comp history/review history/leave history/training)"),
      pageSize: z.coerce.number().int().min(1).max(100).optional().describe("Page size for paginated sections"),
    },
    withToolError(async ({ id, tab, taxFiscalYear, page, pageSize }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      // Raw salary / account / iban / ntn / CTC only for payroll-authorized callers.
      const showSensitive = user.isAdmin ||
        (Array.isArray(permissions?.["hr:payroll"]) && permissions["hr:payroll"].includes("VIEW"));
      const data = await mcpGetEmployeeProfileTab(user, id, { tab, showSensitive, taxFiscalYear, page, pageSize });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_profile_get")
  );

  // Back-compat: the previous all-at-once consolidated profile (job_and_comp core).
  server.tool(
    "hr_employee_profile_full_get",
    "Get the full consolidated employee compensation profile in one call (company/dept, pay grade, bank, NTN, tax, EOBI/PF, comp history, skills, certifications, documents). Prefer hr_employee_profile_get with a tab for UI use.",
    {
      id: z.string().min(1).describe("Employee ID"),
      taxFiscalYear: z.string().optional(),
    },
    withToolError(async ({ id, taxFiscalYear }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const showSensitive = user.isAdmin ||
        (Array.isArray(permissions?.["hr:payroll"]) && permissions["hr:payroll"].includes("VIEW"));
      const data = await mcpGetEmployeeProfile(user, id, { showSensitive, taxFiscalYear });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_profile_full_get")
  );

  server.tool(
    "hr_employee_quick_view_get",
    "Get a compact employee quick-view card by ID",
    { id: z.string().min(1).describe("Employee ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await mcpGetEmployeeQuickView(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_quick_view_get")
  );

  server.tool(
    "hr_employee_documents_list",
    "List documents attached to an employee",
    { employeeId: z.string().min(1).describe("Employee ID") },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await mcpGetEmployeeDocuments(user, employeeId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_documents_list")
  );

  // Phase 3 — Job & Compensation tab
  server.tool(
    "hr_employee_compensation_get",
    "Get compensation (salary, bonus, banking) for an employee — payroll-sensitive fields masked unless caller holds hr:payroll VIEW",
    {
      id: z.string().min(1).describe("Employee ID"),
      includeBanking: z.coerce.boolean().optional().default(false)
        .describe("Set true only if your role has hr:payroll VIEW permission"),
    },
    withToolError(async ({ id, includeBanking }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      // Banking / raw salary only for payroll-authorized callers.
      const hasPayroll = user.isAdmin ||
        (Array.isArray(permissions?.["hr:payroll"]) && permissions["hr:payroll"].includes("VIEW"));
      const showBanking = Boolean(includeBanking && hasPayroll);
      const data = await getEmployeeCompensation(id, user.tenantId, { showBanking });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_employee_compensation_get")
  );

  // Phase 3 — Activity tab
  server.tool(
    "hr_employee_activity_list",
    "List HR audit activity log entries for an employee (who changed what and when)",
    {
      id: z.string().min(1).describe("Employee ID"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    },
    withToolError(async ({ id, page, pageSize }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await listEmployeeActivity(id, user.tenantId, { page, pageSize });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_employee_activity_list")
  );

  server.tool(
    "hr_employee_emergency_contacts_list",
    "List emergency contacts for an employee",
    { employeeId: z.string().min(1).describe("Employee ID") },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const profile = await mcpGetEmployeeById(user, employeeId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              data: { items: profile?.data?.emergencyContacts || [] },
            }),
          },
        ],
      };
    }, "hr_employee_emergency_contacts_list")
  );

  server.tool(
    "hr_employee_create",
    "Create a new employee record",
    {
      firstName: z.string().min(1),
      middleName: z.string().optional(),
      lastName: z.string().min(1),
      preferredName: z.string().optional(),
      dateOfBirth: z.string().optional(),
      gender: z.string().optional(),
      maritalStatus: z.string().optional(),
      nationality: z.string().optional(),
      nationalIdType: z.string().optional(),
      nationalIdNumber: z.string().optional(),
      personalEmail: z.string().optional(),
      workEmail: z.string().optional(),
      email: z.string().optional(),
      mobilePhone: z.string().optional(),
      phone: z.string().optional(),
      workPhone: z.string().optional(),
      residentialAddress: z.string().optional(),
      mailingAddress: z.string().optional(),
      city: z.string().optional(),
      stateProvince: z.string().optional(),
      country: z.string().optional(),
      postalCode: z.string().optional(),
      employeeCode: z.string().optional(),
      jobTitle: z.string().optional(),
      companyId: z.union([z.string(), z.number()]).optional(),
      departmentId: z.union([z.string(), z.number()]).optional(),
      positionId: z.union([z.string(), z.number()]).optional(),
      managerId: z.union([z.string(), z.number()]).optional(),
      hireDate: z.string().optional().describe("ISO 8601 date"),
      joiningDate: z.string().optional(),
      probationEndDate: z.string().optional(),
      employmentType: z.string().optional(),
      employmentStatus: z.string().optional(),
      status: z.string().optional(),
      profilePhotoBase64: z.string().optional().describe("Raw base64 / data: URI. BE uploads to DAM and sets the profile photo."),
      profilePhotoFileName: z.string().optional(),
      coverPhotoBase64: z.string().optional().describe("Raw base64 / data: URI. BE uploads to DAM and sets the cover photo."),
      coverPhotoFileName: z.string().optional(),
      emergencyContacts: z.array(z.any()).optional(),
      documents: z.array(z.any()).optional().describe("Each item may carry fileBase64 (+fileName) for the BE to upload, OR an existing mediaId."),
      // Free-form JSON blob stored on the employee. FE-compat: banking may be nested
      // here (keys bank/accountNumber/iban/…) — the BE also reads it as a fallback to
      // create the primary bank row. MUST be declared or the MCP SDK strips it.
      additionalFields: z.record(z.string(), z.any()).optional().describe("Free-form extras (taxSlab, eobi, payDate, onboardingStartDate, location, and FE-nested banking)."),
      // Tax + banking (consolidated profile). ntn + iban are encrypted at rest.
      ntn: z.string().optional().describe("Pakistan National Tax Number (encrypted at rest)"),
      bankName: z.string().optional(),
      accountTitle: z.string().optional().describe("A/C Title"),
      accountNumber: z.string().optional().describe("Provide with bankName to create the primary bank row"),
      iban: z.string().optional(),
      branch: z.string().optional(),
      disbursementMethod: z.string().optional().describe("Bank Transfer | Cheque | Cash"),
      routingNumber: z.string().optional(),
      accountType: z.string().optional(),
      // Opt-in AI resume parsing: only runs when BOTH are set.
      resumeMediaId: z.union([z.string(), z.number()]).optional().describe("DAM asset id of the resume to parse"),
      parseResume: z.coerce.boolean().optional().describe("Set true (with resumeMediaId) to AI-extract skills/competencies/certifications on create"),
      // Single-call login provisioning: when createSystemAccount is true, HR also
      // creates the RBAC login User (needs roleId). password is OPTIONAL — if
      // omitted HR generates a one-time password and returns it in
      // response.data.systemAccount.temporaryPassword. Caller needs rbac:employee:CREATE.
      createSystemAccount: z.coerce.boolean().optional().describe("Also provision the RBAC login User for this employee (requires roleId)."),
      systemEmail: z.string().optional().describe("Login email for the system account (falls back to workEmail/personalEmail)."),
      password: z.string().min(8).optional().describe("Login password. Omit → HR auto-generates a one-time password and returns it in systemAccount.temporaryPassword."),
      roleId: z.union([z.string(), z.number()]).optional().describe("RBAC role id (integer) for the login. Required when createSystemAccount is true."),
      permissions: z.array(z.object({ permissionId: z.union([z.string(), z.number()]), granted: z.boolean().optional() })).optional().describe("Optional per-permission overrides for the login: [{permissionId, granted}]."),
      // FE-compat: accept the canonical array OR the FE's legacy map form; a map is tolerated (not applied).
      permissionMap: z.any().optional().describe("FE-compat alias for permissions. Prefer the array form [{permissionId, granted}]; a legacy map is accepted but ignored."),
      // FE-compat aliases (some callers send these instead of the canonical fields).
      email: z.string().optional().describe("FE-compat alias — login email; prefer systemEmail. Falls back to workEmail/personalEmail."),
      company: z.union([z.string(), z.number()]).optional().describe("FE-compat alias for companyId."),
      // API-3: optional idempotency key. When supplied, a retried create replays
      // the first result instead of inserting a duplicate employee.
      idempotencyKey: z.string().optional().describe("Optional idempotency key. Repeat the same value to safely retry this create without producing a duplicate."),
    },
    withToolError(async ({ idempotencyKey, ...args }) => {
      const ctx = getCtx();
      const { user, permissions, correlationId } = ctx;
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      // A.4/A.5: pass the request correlationId so the in-tx
      // hr.employee.lifecycle.v1 envelope chains HTTP → event end-to-end. The
      // verified tenant rides on user.tenantId (set by buildContextFromHeaders).
      const { value: data } = await runMcpIdempotent({
        toolName: "hr_employee_create",
        idempotencyKey,
        ctx,
        run: () => mcpCreateEmployee(user, args, { correlationId }),
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_employee_create")
  );

  server.tool(
    "hr_employee_update",
    "Update an existing employee record",
    {
      id: z.string().min(1).describe("Employee ID"),
      firstName: z.string().optional(),
      middleName: z.string().optional(),
      lastName: z.string().optional(),
      preferredName: z.string().optional(),
      dateOfBirth: z.string().optional(),
      gender: z.string().optional(),
      maritalStatus: z.string().optional(),
      nationality: z.string().optional(),
      nationalIdType: z.string().optional(),
      nationalIdNumber: z.string().optional(),
      personalEmail: z.string().optional(),
      workEmail: z.string().optional(),
      email: z.string().optional(),
      mobilePhone: z.string().optional(),
      phone: z.string().optional(),
      workPhone: z.string().optional(),
      residentialAddress: z.string().optional(),
      mailingAddress: z.string().optional(),
      city: z.string().optional(),
      stateProvince: z.string().optional(),
      country: z.string().optional(),
      postalCode: z.string().optional(),
      employeeCode: z.string().optional(),
      jobTitle: z.string().optional(),
      companyId: z.union([z.string(), z.number()]).optional(),
      departmentId: z.union([z.string(), z.number()]).optional(),
      positionId: z.union([z.string(), z.number()]).optional(),
      managerId: z.union([z.string(), z.number()]).optional(),
      hireDate: z.string().optional(),
      joiningDate: z.string().optional(),
      probationEndDate: z.string().optional(),
      employmentType: z.string().optional(),
      employmentStatus: z.string().optional(),
      status: z.string().optional(),
      profilePhotoBase64: z.string().optional().describe("Raw base64 / data: URI. BE uploads to DAM and sets the profile photo."),
      profilePhotoFileName: z.string().optional(),
      coverPhotoBase64: z.string().optional().describe("Raw base64 / data: URI. BE uploads to DAM and sets the cover photo."),
      coverPhotoFileName: z.string().optional(),
      emergencyContacts: z.array(z.any()).optional(),
      // Tax + banking — patches the primary bank row (or creates it when bankName
      // + accountNumber are supplied). ntn + iban are encrypted at rest.
      ntn: z.string().optional(),
      bankName: z.string().optional(),
      accountTitle: z.string().optional().describe("A/C Title"),
      accountNumber: z.string().optional(),
      iban: z.string().optional(),
      branch: z.string().optional(),
      disbursementMethod: z.string().optional().describe("Bank Transfer | Cheque | Cash"),
      routingNumber: z.string().optional(),
      accountType: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUpdateEmployee(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_employee_update")
  );

  server.tool(
    "hr_employee_status_update",
    "Update an employee employment status",
    {
      id: z.string().min(1).describe("Employee ID"),
      status: z.string().min(1).describe("Active, Inactive, Disabled, etc."),
    },
    withToolError(async ({ id, status }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUpdateEmployeeStatus(
        user,
        id,
        status,
        user?.employeeId || user?.userId
      );
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_status_update")
  );

  server.tool(
    "hr_employee_delete",
    "Delete an employee record",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:employee", user.isAdmin);
      const data = await mcpDeleteEmployee(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_employee_profile_photo_attach",
    "Attach or update an employee profile photo",
    mediaPayloadShape,
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUploadEmployeeProfilePhoto(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_profile_photo_attach")
  );

  server.tool(
    "hr_employee_cover_photo_attach",
    "Attach or update an employee cover photo",
    mediaPayloadShape,
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUploadEmployeeCoverPhoto(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_cover_photo_attach")
  );

  server.tool(
    "hr_employee_document_create",
    "Create an employee document record",
    {
      employeeId: z.string().min(1),
      fileBase64: z.string().optional().describe("Raw base64 or data: URI of the document. BE uploads to DAM and derives mediaId/fileName/mimeType/size."),
      title: z.string().optional(),
      category: z.string().optional(),
      version: z.string().optional(),
      visibility: z.string().optional(),
      expiryDate: z.string().optional(),
      notes: z.string().optional(),
      mediaId: z.union([z.string(), z.number()]).optional(),
      downloadUrl: z.string().optional(),
      fileName: z.string().optional(),
      mimeType: z.string().optional(),
      fileSize: z.union([z.string(), z.number()]).optional(),
    },
    withToolError(async ({ employeeId, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await mcpCreateEmployeeDocument(user, employeeId, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_document_create")
  );

  server.tool(
    "hr_position_create",
    "Create a new job position",
    {
      title: z.string().min(1),
      companyId: z.union([z.string(), z.number()]).optional(),
      departmentId: z.union([z.string(), z.number()]).optional(),
      description: z.string().optional(),
      band: z.string().optional(),
      responsibilities: z.string().optional(),
      requirements: z.string().optional(),
      jobCode: z.string().optional(),
      isActive: z.coerce.boolean().optional(),
      gradeLevelId: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await mcpCreatePosition(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_position_update",
    "Update a job position",
    {
      id: z.string().min(1),
      title: z.string().optional(),
      companyId: z.union([z.string(), z.number()]).optional(),
      departmentId: z.union([z.string(), z.number()]).optional(),
      description: z.string().optional(),
      band: z.string().optional(),
      responsibilities: z.string().optional(),
      requirements: z.string().optional(),
      jobCode: z.string().optional(),
      isActive: z.coerce.boolean().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUpdatePosition(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_position_status_update",
    "Update a job position status",
    {
      id: z.string().min(1),
      isActive: z.coerce.boolean(),
    },
    withToolError(async ({ id, isActive }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUpdatePositionStatus(user, id, isActive);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_position_status_update")
  );

  server.tool(
    "hr_position_delete",
    "Delete a job position",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:employee", user.isAdmin);
      const data = await mcpDeletePosition(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
   server.tool(
      "hr_position_get",
      "Get a specific postion record by position ID",
      { id: z.string().min(1) },
      withToolError(async ({ id }) => {
        const { user, permissions } = getCtx();
        assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
        const data = await mcpGetPositionByPositionId(user, id);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      })
    );

  server.tool(
    "hr_employee_lifecycle_create",
    "Record an employee lifecycle event (promotion, transfer, termination, etc.)",
    {
      employeeId: z.string().min(1),
      eventType: z.string().min(1).describe("e.g. PROMOTION, TRANSFER, TERMINATION"),
      effectiveDate: z.string().describe("ISO 8601 date"),
      notes: z.string().optional(),
    },
    withToolError(async ({ eventType, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await mcpCreateEmployeeLifecycle(user, {
        ...rest,
        type: eventType,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_offboarding_create",
    "Create an offboarding checklist for an employee",
    {
      employeeId: z.string().min(1),
      lastWorkingDate: z.string().describe("ISO 8601 date"),
      reason: z.string().optional(),
    },
    withToolError(async ({ lastWorkingDate, reason, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await mcpCreateOffboarding(user, {
        ...rest,
        exitDate: lastWorkingDate,
        exitReason: reason,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_offboarding_update",
    "Update offboarding details",
    {
      id: z.string().min(1),
      status: z.string().optional(),
      lastWorkingDate: z.string().optional(),
      notes: z.string().optional(),
    },
    withToolError(async ({ id, lastWorkingDate, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUpdateOffboarding(user, id, {
        ...rest,
        ...(lastWorkingDate ? { exitDate: lastWorkingDate } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // Phase 1 alias — FE calls hr_employee_emergency_contact_create; backend
  // registers hr_emergency_contact_create. Both now work. The alias also
  // normalises contactName → name so both key conventions are handled.
  server.tool(
    "hr_employee_emergency_contact_create",
    "Add an emergency contact for an employee (FE-compatible alias)",
    {
      employeeId: z.string().min(1),
      contactName: z.string().optional(),
      name: z.string().optional(),
      relationship: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email().optional(),
      is_primary: z.boolean().optional(),
    },
    withToolError(async ({ employeeId, contactName, name, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/emergency-contacts", user.isAdmin);
      const resolvedName = name || contactName;  // accept either key
      const data = await mcpCreateEmergencyContact(user, {
        ...rest,
        employee_Id: employeeId,
        Contact_name: resolvedName,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_emergency_contact_create",
    "Add an emergency contact for an employee",
    {
      employeeId: z.string().min(1),
      name: z.string().min(1),
      relationship: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email().optional(),
      is_primary: z.boolean().optional(),
    },
    withToolError(async ({ employeeId, name, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await mcpCreateEmergencyContact(user, {
        ...rest,
        employee_Id: employeeId,
        Contact_name: name,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_emergency_contact_update",
    "Update an emergency contact",
    {
      id: z.string().min(1),
      name: z.string().optional(),
      relationship: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
    },
    withToolError(async ({ id, name, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:employee", user.isAdmin);
      const data = await mcpUpdateEmergencyContact(user, id, {
        ...rest,
        ...(name ? { Contact_name: name } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_emergency_contact_delete",
    "Delete an emergency contact",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:employee", user.isAdmin);
      const data = await mcpDeleteEmergencyContact(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
