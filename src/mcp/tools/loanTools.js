// src/mcp/tools/loanTools.js — Loan & salary advance MCP facade
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import * as loanService from "../../services/loan.service.js";

const LOANS_KEY = "hr:loans";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLoanTools(server) {
  // ── KPI ───────────────────────────────────────────────────────────────────
  server.tool(
    "hr_loan_kpis",
    "Get loan management KPIs (active loans, total disbursed, outstanding, paid off, plus salary advances counted separately)",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", LOANS_KEY, user.isAdmin);
      const data = await loanService.getLoanKpis(user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_loan_kpis")
  );

  // ── LIST ──────────────────────────────────────────────────────────────────
  server.tool(
    "hr_loan_list",
    "List loans and salary advances with optional employee/status/kind filter and pagination",
    {
      employeeId: z.union([z.string(), z.number()]).optional().describe("Filter by employee ID"),
      status: z.enum(["ACTIVE", "PAID_OFF", "WRITTEN_OFF", "DEFAULTED"]).optional().describe("Filter by loan status"),
      kind: z.enum(["LOAN", "ADVANCE"]).optional().describe("Filter by kind: LOAN or ADVANCE (salary advance). Omit for both"),
      page: z.coerce.number().int().positive().optional().describe("Page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 20)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", LOANS_KEY, user.isAdmin);
      const data = await loanService.listLoans({
        employeeId: args.employeeId,
        status: args.status,
        kind: args.kind,
        page: args.page || 1,
        limit: args.pageSize || 20,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_loan_list")
  );

  // ── GET ───────────────────────────────────────────────────────────────────
  server.tool(
    "hr_loan_get",
    "Get a single loan by ID with repayment history",
    { id: z.string().min(1).describe("Loan ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", LOANS_KEY, user.isAdmin);
      const data = await loanService.getLoan(id, user.tenantId);
      if (!data) throw Object.assign(new Error("Loan not found"), { status: 404 });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_loan_get")
  );

  // ── CREATE ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_loan_create",
    "Create a new loan/salary advance for an employee",
    {
      employeeId: z.string().min(1).describe("Employee ID to create loan for"),
      principalMinor: z.number().int().positive().describe("Loan amount in minor units (cents). E.g., 500000 = $5,000.00"),
      interestRatePct: z.number().nonnegative().optional().describe("Annual interest rate % (default 0 = interest-free). Must be 0 for an ADVANCE"),
      tenureMonths: z.number().int().positive().describe("Number of monthly installments. A salary advance uses 1"),
      kind: z.enum(["LOAN", "ADVANCE"]).optional().describe("LOAN (default) or ADVANCE for a salary advance — recovered next payroll, interest-free"),
      disbursementDate: z.string().optional().describe("Disbursement date (ISO 8601). Defaults to today"),
      reason: z.string().optional().describe("Reason for the loan"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", LOANS_KEY, user.isAdmin);
      const data = await loanService.createLoan({
        ...args,
        createdById: user.employeeId,
        tenantId: user.tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_loan_create")
  );

  // ── APPROVE ───────────────────────────────────────────────────────────────
  server.tool(
    "hr_loan_approve",
    "Approve a pending loan",
    { id: z.string().min(1).describe("Loan ID to approve") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", LOANS_KEY, user.isAdmin);
      const data = await loanService.approveLoan(id, user.employeeId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_loan_approve")
  );

  // ── WRITE OFF ─────────────────────────────────────────────────────────────
  server.tool(
    "hr_loan_write_off",
    "Write off (forgive) an active loan",
    { id: z.string().min(1).describe("Loan ID to write off") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", LOANS_KEY, user.isAdmin);
      const data = await loanService.writeOffLoan(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_loan_write_off")
  );
}
