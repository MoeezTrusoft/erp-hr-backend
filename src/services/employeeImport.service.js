// src/services/employeeImport.service.js
//
// Bulk EMPLOYEE IMPORT — the validate → auto-fix → annotate → commit engine
// behind hr_employees_import / hr_employees_import_template.
//
// Built for a NON-TECHNICAL HR user filling the sheet once:
//  • friendly column titles + hover help + an Instructions tab
//  • every enum / manager / grade / currency column is an Excel DROPDOWN
//    (data validation), dates are date-typed cells, so bad values are hard to
//    enter in the first place
//  • total salary is entered once and auto-segregated into a standard component
//    structure (Basic 45 / House 20 / Transport 15 / Medical 12.5 / Utilities 7.5)
//  • one emergency contact captured inline; biometric device ID captured
//    separately from the ERP employee code
//  • logins are provisioned with an auto-assigned role + an auto-generated
//    password that is stored C4-encrypted for later read-back
// Every cell is trimmed and, where possible, AUTO-FIXED; anything unfixable is
// FLAGGED on a returned copy of the sheet (red cell + plain-English comment +
// __row_status / __issues + a Summary tab). Nothing is written unless
// dryRun=false, and even then only OK/FIXED rows commit (reds are skipped).
// Idempotent: an existing employee_code UPDATES that employee (no duplicates).

import ExcelJS from "exceljs";
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedEmployeeWhere, scopedWhere, scopedData } from "../lib/tenancy.js";
import { encryptString } from "../lib/crypto.js";
import { listDepartments, listRoles } from "./rbac.client.js";
import { mcpCreateEmployee, mcpUpdateEmployee } from "../mcp/controllers/employeeMcpController.js";
import { createSalaryComponent } from "./salaryComponent.service.js";
import { createEmploymentTerms } from "./payrollService.js";
import {
  IMPORT_COLUMNS,
  IMPORT_HEADERS,
  COLUMN_BY_KEY,
  headerLabel,
  headerToKey,
  cleanCell,
  isBlank,
  titleCase,
  normalizeEmail,
  normalizePhone,
  normalizeEnum,
  parseDate,
  parseFte,
  parseMoney,
  nearest,
  SALARY_SPLIT,
  BASIC_PCT_OF_TOTAL,
  componentPctOfBasic,
} from "../lib/employeeImportTaxonomy.js";

const MAXROWS = 600;
const VALIDATION_ROWS = 400; // rows that get dropdowns / date pickers / prompts
const DEFAULT_LOGIN_ROLE = process.env.DEFAULT_IMPORT_LOGIN_ROLE || "Employee";
const FILL = { req: "FFC00000", key: "FF1F6FEB", opt: "FF44546A" };
const HEADER_FONT = { color: { argb: "FFFFFFFF" }, bold: true, size: 11 };
const STATUS_FILL = { OK: "FFDDF3DD", FIXED: "FFFFF3CD", ERROR: "FFF8D2D2" };
const CELL_FIX = "FFFFF3CD"; // yellow — auto-fixed
const CELL_ERR = "FFF8D2D2"; // red — needs attention

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ── Template header styling (shared by template + annotated output) ──────────
function writeHeader(ws, withStatusCols) {
  IMPORT_COLUMNS.forEach((c, i) => {
    const cell = ws.getRow(1).getCell(i + 1);
    cell.value = headerLabel(c) + (c.kind === "req" ? " *" : c.kind === "key" ? " ★" : "");
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[c.kind] } };
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.note = c.note;
    const w = Math.max(headerLabel(c).length + 2, 16);
    ws.getColumn(i + 1).width = Math.min(w, 30);
    if (c.date) ws.getColumn(i + 1).numFmt = "yyyy-mm-dd";
  });
  if (withStatusCols) {
    const base = IMPORT_COLUMNS.length;
    [{ t: "Status", w: 16 }, { t: "Issues found (fix these)", w: 70 }].forEach((c, k) => {
      const cell = ws.getRow(1).getCell(base + 1 + k);
      cell.value = c.t;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF222222" } };
      cell.font = HEADER_FONT;
      ws.getColumn(base + 1 + k).width = c.w;
    });
  }
  ws.getRow(1).height = 30;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: IMPORT_COLUMNS.length + (withStatusCols ? 2 : 0) } };
}

// Apply dropdowns (enum inline + dynamic Lists-sheet range), date pickers, and
// hover input-prompts. dynamicRanges maps a col.dynamic key → a Lists!$X$2:$X$n
// formula string; omitted for the annotated output (no Lists sheet there).
function applyValidations(ws, { dynamicRanges = {}, rows = VALIDATION_ROWS } = {}) {
  IMPORT_COLUMNS.forEach((c, i) => {
    const letter = ws.getColumn(i + 1).letter;
    let dv = null;
    if (c.enum) {
      dv = {
        type: "list", allowBlank: true, formulae: [`"${c.enum.join(",")}"`],
        showErrorMessage: true, errorStyle: "warning", errorTitle: "Pick from the list",
        error: `Suggested: ${c.enum.join(", ")}. Close values are auto-corrected; anything else is flagged.`,
      };
    } else if (c.dynamic && dynamicRanges[c.dynamic]) {
      dv = {
        type: "list", allowBlank: true, formulae: [dynamicRanges[c.dynamic]],
        showErrorMessage: true, errorStyle: "warning", errorTitle: "Pick from the list",
        error: "Pick an existing value from the dropdown, or leave blank.",
      };
    } else if (c.date) {
      dv = {
        type: "date", operator: "greaterThan", allowBlank: true, formulae: [new Date(Date.UTC(1900, 0, 1))],
        showErrorMessage: true, errorStyle: "warning", errorTitle: "Enter a date",
        error: "Type a date like 2026-07-01 (YYYY-MM-DD).",
      };
    }
    if (!dv) return;
    if (c.note) { dv.showInputMessage = true; dv.promptTitle = headerLabel(c); dv.prompt = c.note; }
    for (let r = 2; r <= rows; r++) ws.getCell(`${letter}${r}`).dataValidation = { ...dv };
  });
}

// ── Tenant lists that back the dynamic dropdowns (grade/dept/position) ─────────
// NB: Manager is intentionally NOT sourced here — its dropdown points at the
// Employee Code column of the sheet being filled (see generateImportTemplate),
// so the managers are the employees being registered in this same sheet.
async function buildTemplateLists(tenantId) {
  const [departments, positions, grades] = await Promise.all([
    listDepartments().catch(() => []),
    prisma.position.findMany({ where: scopedWhere(tenantId, {}), select: { title: true }, orderBy: { title: "asc" } }).catch(() => []),
    prisma.gradeLevel.findMany({ where: scopedWhere(tenantId, {}), select: { name: true }, orderBy: { name: "asc" } }).catch(() => []),
  ]);
  return {
    grade: grades.map((g) => g.name).filter(Boolean),
    department: departments.map((d) => d.name).filter(Boolean),
    position: positions.map((p) => p.title).filter(Boolean),
  };
}

// ── Downloadable empty template ──────────────────────────────────────────────
export async function generateImportTemplate({ tenantId } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TruSoft ERP — HR";

  const lists = await buildTemplateLists(tenantId);

  // Hidden Lists sheet backing the manager/grade/department/position dropdowns.
  const listSheet = wb.addWorksheet("Lists");
  const dynCols = [
    { key: "grade", col: "A", title: "Grades" },
    { key: "department", col: "B", title: "Departments" },
    { key: "position", col: "C", title: "Positions" },
  ];
  const dynamicRanges = {};
  dynCols.forEach((d, idx) => {
    listSheet.getCell(`${d.col}1`).value = d.title;
    const vals = lists[d.key] || [];
    vals.forEach((v, r) => { listSheet.getCell(`${d.col}${r + 2}`).value = v; });
    listSheet.getColumn(idx + 1).width = 32;
    if (vals.length) dynamicRanges[d.key] = `Lists!$${d.col}$2:$${d.col}$${vals.length + 1}`;
  });
  listSheet.state = "veryHidden";

  const ws = wb.addWorksheet("Employees");
  writeHeader(ws, false);
  // Manager dropdown = the Employee Code column of THIS sheet, so any code the
  // HR user types above becomes a selectable manager. The link is resolved to
  // the newly-created employee on commit (second pass in runEmployeeImport).
  const codeColIdx = IMPORT_COLUMNS.findIndex((c) => c.key === "employee_code") + 1;
  const codeLetter = ws.getColumn(codeColIdx).letter;
  dynamicRanges.manager = `$${codeLetter}$2:$${codeLetter}$${VALIDATION_ROWS}`;
  applyValidations(ws, { dynamicRanges });

  const ex = wb.addWorksheet("Example (do not import)");
  writeHeader(ex, false);
  const rowFrom = (o) => IMPORT_HEADERS.map((h) => (o[h] !== undefined ? o[h] : ""));
  ex.addRow(rowFrom({
    first_name: "Ayesha", last_name: "Khan", employee_code: "EMP-1042", biometric_id: "1042",
    gender: "Female", date_of_birth: "1996-04-12", marital_status: "Single", nationality: "Pakistani",
    national_id_type: "CNIC", national_id_number: "35202-1234567-8",
    personal_email: "ayesha.khan@gmail.com", work_email: "ayesha.khan@bookcraft.pk",
    mobile_phone: "+92 300 1234567", city: "Karachi", country: "Pakistan",
    job_title: "Software Engineer", department: "Engineering", position: "Software Engineer",
    grade: lists.grade?.[0] || "M3", manager: "",
    employment_type: "Full-time", employment_status: "Active",
    hire_date: "2026-07-01", joining_date: "2026-07-01", work_mode: "On-site", fte: 1,
    emergency_contact_name: "Sara Khan", emergency_contact_relationship: "Sibling",
    emergency_contact_phone: "+92 300 7654321", emergency_contact_email: "sara.khan@gmail.com",
    total_salary: 250000, salary_currency: "PKR",
    create_login: "yes", login_email: "ayesha.khan@bookcraft.pk",
  }));
  ex.addRow(rowFrom({
    first_name: "Bilal", last_name: "Ahmed", employee_code: "EMP-1043", biometric_id: "1043",
    gender: "Male", work_email: "bilal.ahmed@bookcraft.pk", mobile_phone: "03011234567",
    job_title: "Accountant", department: "Finance", employment_type: "Full-time",
    manager: "EMP-1042", // reports to Ayesha (row above) — an in-sheet manager
    hire_date: "2026-06-15", work_mode: "Hybrid", total_salary: 150000, salary_currency: "PKR",
    create_login: "no",
  }));

  const ins = wb.addWorksheet("Instructions");
  ins.getColumn(1).width = 3; ins.getColumn(2).width = 120;
  [
    ["", "HR EMPLOYEE BULK IMPORT — how to fill this sheet"], ["", ""],
    ["1", "Fill one employee per row in the 'Employees' tab. The 'Example' tab is only a guide and is IGNORED on import."],
    ["2", "Columns marked * are REQUIRED (First Name, Last Name). Everything else is optional but recommended."],
    ["3", "Wherever you see a small arrow in a cell, click it and PICK from the dropdown (Gender, Marital Status, Department, Grade, Manager, Employment Type/Status, Work Mode, Currency, Create Login, Emergency Contact Relationship). Dates open a simple date entry — type them as YYYY-MM-DD (e.g. 2026-07-01)."],
    ["4", "Employee Code (ERP) is your internal code. The Biometric / Device ID (★) is SEPARATE — set it to the exact user-ID enrolled on the attendance device so punches auto-map. Keep both UNIQUE."],
    ["5", "Manager: pick from the dropdown, which lists the Employee Codes you enter in THIS sheet — so a manager and their reports can all be added together (the manager just needs to be a row here too, or already exist by their Employee Code). Department / Position / Grade are matched to existing records — unknown values are flagged with the closest suggestion."],
    ["6", "Total Monthly Salary: enter ONE number (gross). The system automatically splits it into Basic 45%, House Rent 20%, Transport 15%, Medical 12.5%, Utilities 7.5%."],
    ["7", "Create Login = Yes gives the employee an ERP login. The role and a secure password are assigned AUTOMATICALLY — you do not enter them. Retrieve passwords later with the 'read login password' action."],
    ["8", "Emergency Contact: fill the one contact's name, relationship, phone and (optional) email."],
    ["9", "Import runs a PREVIEW first: you get this sheet back with a colour-coded Status (GREEN = ok, YELLOW = auto-fixed, RED = needs your attention) and a plain-English 'Issues found' column. Fix the RED cells and re-upload."],
    ["10", "Nothing is saved until you confirm. Re-importing an existing Employee Code UPDATES that person (no duplicates)."],
  ].forEach((l, idx) => {
    const row = ins.addRow(l);
    if (idx === 0) row.getCell(2).font = { bold: true, size: 14, color: { argb: "FF1F6FEB" } };
    else { row.getCell(2).alignment = { wrapText: true, vertical: "top" }; row.getCell(1).font = { bold: true }; }
  });
  ins.views = [{ showGridLines: false }];

  const buf = await wb.xlsx.writeBuffer();
  return {
    fileName: "HR_Employee_Import_Template.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: Buffer.from(buf).toString("base64"),
    columns: IMPORT_HEADERS,
  };
}

// ── Parse the uploaded file into { headers, rows[] } ─────────────────────────
async function parseUpload(buffer, format) {
  const wb = new ExcelJS.Workbook();
  const fmt = String(format || "").toLowerCase();
  if (fmt === "csv") {
    const { Readable } = await import("node:stream");
    await wb.csv.read(Readable.from(buffer.toString("utf8")));
  } else {
    await wb.xlsx.load(buffer);
  }
  let ws = wb.getWorksheet("Employees");
  if (!ws) ws = wb.worksheets.find((s) => !/example|instruction|lists/i.test(s.name)) || wb.worksheets[0];
  if (!ws) throw Object.assign(new Error("No worksheet found in the uploaded file"), { status: 400 });

  // Map header cells → column keys, accepting friendly labels OR snake_case keys.
  const headerRow = ws.getRow(1);
  const idxByKey = {};
  headerRow.eachCell((cell, col) => {
    const key = headerToKey(cleanCell(cell.value));
    if (key) idxByKey[key] = col;
  });
  if (!idxByKey.first_name || !idxByKey.last_name) {
    throw Object.assign(
      new Error("The sheet is missing the required 'First Name' / 'Last Name' columns. Use the template from hr_employees_import_template."),
      { status: 400 }
    );
  }

  const rows = [];
  const lastRow = Math.min(ws.rowCount, MAXROWS + 50);
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const rec = {};
    let any = false;
    for (const key of IMPORT_HEADERS) {
      const col = idxByKey[key];
      const val = col ? cleanCell(row.getCell(col).value) : "";
      rec[key] = val;
      if (!isBlank(val)) any = true;
    }
    if (any) rows.push({ rowNumber: r, rec });
  }
  return { rows, sheetName: ws.name };
}

// ── Lookup maps (tenant-scoped) ──────────────────────────────────────────────
async function buildLookups(tenantId, needsRoles) {
  const [departments, positions, grades, employees, roles] = await Promise.all([
    listDepartments().catch(() => []),
    prisma.position.findMany({ where: scopedWhere(tenantId, {}), select: { id: true, title: true } }).catch(() => []),
    prisma.gradeLevel.findMany({ where: scopedWhere(tenantId, {}), select: { id: true, name: true } }).catch(() => []),
    prisma.employee.findMany({ where: scopedEmployeeWhere(tenantId, {}), select: { id: true, employee_code: true, biometric_id: true, employee_name: true, first_name: true, last_name: true, work_email: true, email: true } }).catch(() => []),
    needsRoles ? listRoles().catch(() => []) : Promise.resolve([]),
  ]);
  const ciMap = (arr, nameKey, idKey = "id") => {
    const m = new Map();
    for (const x of arr) { const n = x?.[nameKey]; if (n) m.set(String(n).trim().toLowerCase(), x[idKey]); }
    return m;
  };
  const deptMap = ciMap(departments, "name");
  const posMap = ciMap(positions, "title");
  const gradeMap = ciMap(grades, "name");
  const roleMap = ciMap(roles, "name");
  const empByCode = new Map();
  const empByName = new Map();
  const codeToId = new Map();
  const emailExisting = new Set();
  const biometricExisting = new Set();
  for (const e of employees) {
    const nm = e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ");
    if (e.employee_code) { empByCode.set(String(e.employee_code).trim().toLowerCase(), e.id); codeToId.set(String(e.employee_code).trim().toLowerCase(), e.id); }
    if (nm) empByName.set(nm.trim().toLowerCase(), e.id);
    if (e.work_email) emailExisting.add(e.work_email.trim().toLowerCase());
    if (e.email) emailExisting.add(e.email.trim().toLowerCase());
    if (e.biometric_id) biometricExisting.add(String(e.biometric_id).trim().toLowerCase());
  }
  // Default role for auto-provisioned logins (HR no longer picks a role).
  let defaultRoleId = roleMap.get(DEFAULT_LOGIN_ROLE.toLowerCase());
  if (defaultRoleId == null && roles.length) defaultRoleId = roles[0].id;
  return {
    deptMap, posMap, gradeMap, roleMap, empByCode, empByName, codeToId, emailExisting, biometricExisting,
    defaultRoleId, defaultRoleName: DEFAULT_LOGIN_ROLE,
    deptNames: departments.map((d) => d.name),
    posNames: positions.map((p) => p.title),
    gradeNames: grades.map((g) => g.name),
  };
}

// Resolve a manager cell: accepts "Name (EMP-CODE)", a bare employee_code, or a
// full name (all case-insensitive).
function resolveManager(raw, lk) {
  const mv = cleanCell(raw);
  const low = mv.toLowerCase();
  const paren = mv.match(/\(([^)]+)\)\s*$/);
  if (paren) {
    const code = paren[1].trim().toLowerCase();
    const name = mv.slice(0, mv.lastIndexOf("(")).trim().toLowerCase();
    return lk.empByCode.get(code) ?? lk.empByName.get(name) ?? null;
  }
  return lk.empByCode.get(low) ?? lk.empByName.get(low) ?? null;
}

// ── Validate + auto-fix ONE row ──────────────────────────────────────────────
function validateRow(rec, lk, { dayFirst, upsert }, seen) {
  const fixes = []; // { key, from, to }
  const issues = []; // { key, msg, severity:'error'|'warn' }
  const out = {}; // create arg name → value
  const direct = {}; // Employee columns the create contract cannot set → post-write patch
  const emergency = {}; // one EmergencyContacts row
  const salary = {}; // { total, currency }
  let pendingManagerCode = null; // manager is another row in this sheet → link post-create
  const set = (key, value) => {
    const col = COLUMN_BY_KEY[key];
    if (value === "" || value == null) return;
    if (col?.create) out[col.create] = value;
    else if (col?.direct) direct[col.direct] = value;
  };

  for (const col of IMPORT_COLUMNS) {
    const key = col.key;
    const raw = rec[key];

    if (col.required && isBlank(raw)) { issues.push({ key, msg: `Missing required field '${headerLabel(col)}'.`, severity: "error" }); continue; }
    if (isBlank(raw)) continue;

    if (key === "first_name" || key === "last_name" || key === "middle_name" || key === "preferred_name" || key === "emergency_contact_name") {
      const tc = titleCase(cleanCell(raw));
      if (tc !== cleanCell(raw)) fixes.push({ key, from: cleanCell(raw), to: tc });
      if (col.group === "emergency") emergency.name = tc; else set(key, tc);
    } else if (col.enum) {
      const n = normalizeEnum(key, raw);
      if (!n.matched) { issues.push({ key, msg: `'${cleanCell(raw)}' is not a valid ${headerLabel(col)}${n.suggestion ? ` — did you mean '${n.suggestion}'?` : ` (allowed: ${col.enum.join(", ")})`}.`, severity: "error" }); continue; }
      if (n.fixed) fixes.push({ key, from: cleanCell(raw), to: n.value });
      if (key === "salary_currency") salary.currency = n.value;
      else if (key === "emergency_contact_relationship") emergency.relationship = n.value;
      else if (key !== "create_login") set(key, n.value);
    } else if (col.date) {
      const d = parseDate(raw, { dayFirst });
      if (!d.valid) { issues.push({ key, msg: `'${cleanCell(raw)}' is not a recognizable date — use YYYY-MM-DD.`, severity: "error" }); continue; }
      if (d.fixed) fixes.push({ key, from: cleanCell(raw), to: d.value });
      set(key, d.value);
    } else if (col.email) {
      const e = normalizeEmail(raw);
      if (!e.valid) { issues.push({ key, msg: `'${cleanCell(raw)}' is not a valid email address.`, severity: "error" }); continue; }
      if (e.fixed) fixes.push({ key, from: cleanCell(raw), to: e.value });
      if (col.group === "emergency") emergency.email = e.value; else set(key, e.value);
    } else if (col.phone) {
      const p = normalizePhone(raw);
      if (!p.valid) issues.push({ key, msg: `Phone '${cleanCell(raw)}' looks unusual (kept as-is) — verify the number.`, severity: "warn" });
      if (p.fixed) fixes.push({ key, from: cleanCell(raw), to: p.value });
      if (col.group === "emergency") emergency.phone = p.value; else set(key, p.value);
    } else if (col.money) {
      const m = parseMoney(raw);
      if (!m.valid) { issues.push({ key, msg: `'${cleanCell(raw)}' is not a valid amount — enter a number like 250000.`, severity: "error" }); continue; }
      if (!m.blank) { salary.total = m.value; if (String(m.value) !== cleanCell(raw)) fixes.push({ key, from: cleanCell(raw), to: String(m.value) }); }
    } else if (key === "fte") {
      const f = parseFte(raw);
      if (!f.valid) { issues.push({ key, msg: `FTE '${cleanCell(raw)}' is not a number 0–1.`, severity: "error" }); continue; }
      if (f.clamped) issues.push({ key, msg: `FTE adjusted to ${f.value} (valid range 0–1).`, severity: "warn" });
      if (f.fixed) fixes.push({ key, from: cleanCell(raw), to: String(f.value) });
      set(key, f.value);
    } else if (col.lookup === "department") {
      const id = lk.deptMap.get(cleanCell(raw).toLowerCase());
      if (id == null) { const s = nearest(cleanCell(raw), lk.deptNames); issues.push({ key, msg: `Department '${cleanCell(raw)}' not found${s ? ` — did you mean '${s}'?` : ""}.`, severity: "error" }); continue; }
      set(key, id);
    } else if (col.lookup === "position") {
      const id = lk.posMap.get(cleanCell(raw).toLowerCase());
      if (id == null) { const s = nearest(cleanCell(raw), lk.posNames); issues.push({ key, msg: `Position '${cleanCell(raw)}' not found${s ? ` — did you mean '${s}'?` : ""}.`, severity: "error" }); continue; }
      set(key, id);
    } else if (col.lookup === "grade") {
      const id = lk.gradeMap.get(cleanCell(raw).toLowerCase());
      if (id == null) { const s = nearest(cleanCell(raw), lk.gradeNames); issues.push({ key, msg: `Grade '${cleanCell(raw)}' not found${s ? ` — did you mean '${s}'?` : ""}.`, severity: "error" }); continue; }
      set(key, id); // direct → gradeLevelId
    } else if (col.lookup === "manager") {
      const id = resolveManager(raw, lk);
      if (id != null) { set(key, id); }
      else {
        // Not an existing employee — maybe the manager is another person being
        // registered in THIS sheet. Defer the link until every row is created.
        const mv = cleanCell(raw);
        const paren = mv.match(/\(([^)]+)\)\s*$/);
        const mcode = (paren ? paren[1] : mv).trim().toLowerCase();
        if (mcode && mcode === cleanCell(rec.employee_code).toLowerCase()) {
          issues.push({ key, msg: `An employee cannot be their own manager.`, severity: "error" });
        } else if (mcode && lk.sheetCodes?.has(mcode)) {
          pendingManagerCode = mcode;
          issues.push({ key, msg: `Manager is another employee in this sheet (${paren ? paren[1] : mv}) — will be linked after import.`, severity: "warn" });
        } else {
          issues.push({ key, msg: `Manager '${mv}' not found — pick from the dropdown (an Employee Code entered in this sheet, or an existing employee's code).`, severity: "error" });
        }
      }
    } else if (key === "biometric_id") {
      set(key, cleanCell(raw)); // direct → biometric_id (uniqueness checked below)
    } else {
      set(key, cleanCell(raw));
    }
  }

  // ── biometric_id uniqueness (within sheet + vs existing) ─────────────────────
  const bio = cleanCell(rec.biometric_id).toLowerCase();
  if (bio) {
    if (seen.biometrics.has(bio)) issues.push({ key: "biometric_id", msg: `Duplicate Biometric ID '${cleanCell(rec.biometric_id)}' also on row ${seen.biometrics.get(bio)}.`, severity: "error" });
    else seen.biometrics.set(bio, rec.__rowNumber);
    if (lk.biometricExisting.has(bio)) issues.push({ key: "biometric_id", msg: `Biometric ID '${cleanCell(rec.biometric_id)}' is already used by another employee.`, severity: "error" });
  }

  // ── employee_code: uniqueness (within sheet) + existing → update ────────────
  const code = cleanCell(rec.employee_code).toLowerCase();
  let action = "create";
  if (code) {
    if (seen.codes.has(code)) issues.push({ key: "employee_code", msg: `Duplicate Employee Code '${cleanCell(rec.employee_code)}' also on row ${seen.codes.get(code)}.`, severity: "error" });
    else seen.codes.set(code, rec.__rowNumber);
    if (lk.codeToId.has(code)) {
      if (upsert) { action = "update"; out.__updateId = lk.codeToId.get(code); issues.push({ key: "employee_code", msg: `Existing Employee Code — this row will UPDATE employee #${lk.codeToId.get(code)}.`, severity: "warn" }); }
      else issues.push({ key: "employee_code", msg: `Employee Code already exists (turn on upsert to update).`, severity: "error" });
    }
  } else {
    issues.push({ key: "employee_code", msg: `No Employee Code — one will be auto-generated.`, severity: "warn" });
  }

  // ── work_email uniqueness (within sheet + vs existing) ──────────────────────
  const we = cleanCell(rec.work_email).toLowerCase();
  if (we) {
    if (seen.emails.has(we)) issues.push({ key: "work_email", msg: `Duplicate Work Email '${cleanCell(rec.work_email)}' also on row ${seen.emails.get(we)}.`, severity: "error" });
    else seen.emails.set(we, rec.__rowNumber);
    if (action === "create" && lk.emailExisting.has(we)) issues.push({ key: "work_email", msg: `Work Email '${cleanCell(rec.work_email)}' already belongs to another employee.`, severity: "error" });
  }

  // ── emergency contact coherence ─────────────────────────────────────────────
  if ((emergency.phone || emergency.email || emergency.relationship) && !emergency.name) {
    issues.push({ key: "emergency_contact_name", msg: `Emergency contact details were entered without a name — add the contact's name.`, severity: "warn" });
  }

  // ── salary sanity ───────────────────────────────────────────────────────────
  if (salary.total != null && salary.total <= 0) {
    issues.push({ key: "total_salary", msg: `Total Monthly Salary must be greater than 0.`, severity: "error" });
    delete salary.total;
  }

  // ── login provisioning gate (role + password are automatic now) ─────────────
  const login = normalizeEnum("create_login", cleanCell(rec.create_login)).value; // yes|no|''
  if (login === "yes") {
    out.createSystemAccount = true;
    if (lk.defaultRoleId == null) issues.push({ key: "create_login", msg: `Cannot create a login — no default role '${lk.defaultRoleName}' exists. Ask an admin to create it, then re-import.`, severity: "error" });
    else out.roleId = lk.defaultRoleId;
    if (!out.systemEmail) out.systemEmail = out.workEmail || out.personalEmail;
    if (!out.systemEmail) issues.push({ key: "login_email", msg: `Create Login = Yes needs a Login Email (or a Work Email to fall back to).`, severity: "error" });
  } else {
    delete out.createSystemAccount;
    delete out.roleId;
  }
  if (typeof out.roleId !== "number") delete out.roleId;

  const hasError = issues.some((i) => i.severity === "error");
  const status = hasError ? "ERROR" : fixes.length || issues.length ? "FIXED" : "OK";
  return {
    status, fixes, issues, action, pendingManagerCode,
    createArgs: out, directColumns: direct,
    emergency: emergency.name ? emergency : null,
    salary: salary.total != null ? { total: salary.total, currency: salary.currency || "PKR" } : null,
  };
}

// ── Build the annotated workbook (base64) ────────────────────────────────────
async function buildAnnotated(results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TruSoft ERP — HR";
  const ws = wb.addWorksheet("Employees");
  writeHeader(ws, true);
  const statusCol = IMPORT_COLUMNS.length + 1;
  const issuesCol = IMPORT_COLUMNS.length + 2;

  for (const res of results) {
    const excelRow = ws.addRow(IMPORT_HEADERS.map((h) => res.rec[h] ?? ""));
    const fixByKey = new Map(res.fixes.map((f) => [f.key, f]));
    const issuesByKey = new Map();
    for (const is of res.issues) { if (!issuesByKey.has(is.key)) issuesByKey.set(is.key, []); issuesByKey.get(is.key).push(is); }

    IMPORT_COLUMNS.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      const iss = issuesByKey.get(col.key);
      const fix = fixByKey.get(col.key);
      if (iss && iss.some((x) => x.severity === "error")) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CELL_ERR } };
        cell.note = iss.map((x) => x.msg).join(" ");
      } else if (fix) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CELL_FIX } };
        cell.value = fix.to;
        cell.note = `Auto-fixed: was "${fix.from}" → "${fix.to}".${iss ? " " + iss.map((x) => x.msg).join(" ") : ""}`;
      } else if (iss) {
        cell.note = iss.map((x) => x.msg).join(" ");
      }
    });

    const st = excelRow.getCell(statusCol);
    st.value = res.status + (res.action === "update" && res.status !== "ERROR" ? " (update)" : "");
    st.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_FILL[res.status] } };
    st.font = { bold: true };
    const issueCell = excelRow.getCell(issuesCol);
    issueCell.value = res.issues.map((x) => `• ${x.msg}`).join("\n") + (res.commit?.error ? `\n✗ ${res.commit.error}` : res.commit?.ok ? `\n✓ ${res.commit.summary}` : "");
    issueCell.alignment = { wrapText: true, vertical: "top" };
  }
  applyValidations(ws, { rows: Math.max(2, results.length + 1) });

  // Summary sheet
  const sum = wb.addWorksheet("Summary");
  sum.getColumn(1).width = 34; sum.getColumn(2).width = 12;
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; if (r.action === "update" && r.status !== "ERROR") a.update++; if (r.action === "create" && r.status !== "ERROR") a.create++; if (r.createArgs?.createSystemAccount) a.logins++; return a; }, { OK: 0, FIXED: 0, ERROR: 0, update: 0, create: 0, logins: 0 });
  [
    ["Total rows", results.length],
    ["OK (no changes)", counts.OK],
    ["Auto-fixed", counts.FIXED],
    ["Flagged (needs attention)", counts.ERROR],
    ["→ will create", counts.create],
    ["→ will update (existing code)", counts.update],
    ["→ logins to provision", counts.logins],
  ].forEach(([k, v], idx) => {
    const row = sum.addRow([k, v]);
    if (idx === 0) row.font = { bold: true };
  });
  sum.views = [{ showGridLines: false }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString("base64");
}

// ── Ensure the standard allowance SalaryComponents exist + are authoritative ──
// The total-salary segregation only "works perfect" if these components carry
// the exact PERCENTAGE-of-BASIC values, so we create missing ones AND correct
// any pre-existing component that shares a standard code (e.g. a stale HRA left
// over from earlier config) to the standard EARNING/PERCENTAGE definition.
async function ensureSalaryComponents(tenantId) {
  const codes = SALARY_SPLIT.map((s) => s.code);
  const existing = await prisma.salaryComponent.findMany({
    where: scopedWhere(tenantId, { code: { in: codes } }),
    select: { code: true },
  }).catch(() => []);
  const have = new Set(existing.map((c) => String(c.code)));
  let sort = 10;
  for (const s of SALARY_SPLIT) {
    sort += 10;
    const value = round2(componentPctOfBasic(s.pctOfTotal));
    if (have.has(s.code)) {
      // Correct a pre-existing component to the standard segregation config.
      await prisma.salaryComponent.updateMany({
        where: scopedWhere(tenantId, { code: s.code }),
        data: { name: s.name, type: "EARNING", computation: "PERCENTAGE", value, taxable: true, active: true },
      }).catch((e) => logger.warn({ code: s.code, err: e?.message }, "employee import: salary component correct failed"));
      continue;
    }
    await createSalaryComponent({
      tenantId, code: s.code, name: s.name, type: "EARNING", computation: "PERCENTAGE",
      value, taxable: true, active: true, sortOrder: sort,
    }).catch((e) => logger.warn({ code: s.code, err: e?.message }, "employee import: salary component ensure failed"));
  }
}

// ── Public: run the import ───────────────────────────────────────────────────
export async function runEmployeeImport({ user, tenantId, fileBase64, format, dryRun = true, dayFirst = true, upsert = true, correlationId } = {}) {
  if (!fileBase64) throw Object.assign(new Error("fileBase64 is required"), { status: 400 });
  const buffer = Buffer.from(String(fileBase64).replace(/^data:[^,]+,/, ""), "base64");
  const { rows } = await parseUpload(buffer, format);
  if (!rows.length) throw Object.assign(new Error("The sheet has no data rows to import."), { status: 400 });

  const needsRoles = rows.some((r) => normalizeEnum("create_login", r.rec.create_login).value === "yes");
  const lk = await buildLookups(tenantId, needsRoles);
  // Employee Codes present in this upload — a manager cell may reference one of
  // these (an employee being registered alongside its reports in the same sheet).
  lk.sheetCodes = new Set(rows.map(({ rec }) => cleanCell(rec.employee_code).toLowerCase()).filter(Boolean));

  const seen = { codes: new Map(), emails: new Map(), biometrics: new Map() };
  const results = [];
  for (const { rowNumber, rec } of rows) {
    rec.__rowNumber = rowNumber;
    const v = validateRow(rec, lk, { dayFirst, upsert }, seen);
    results.push({ rowNumber, rec, ...v });
  }

  const committed = { created: 0, updated: 0, failed: 0, logins: 0, emergencyContacts: 0, salaries: 0, managersLinked: 0 };
  if (!dryRun) {
    // Create the standard salary components once, up-front, if any row has salary.
    if (results.some((r) => r.status !== "ERROR" && r.salary)) await ensureSalaryComponents(tenantId);

    // employee_code → id, seeded with existing employees; grows as we create the
    // sheet's rows so a later row can name an earlier one as its manager.
    const codeToNewId = new Map(lk.codeToId);

    for (const res of results) {
      if (res.status === "ERROR") continue;
      try {
        let empId;
        let tmpPassword = null;
        if (res.action === "update") {
          const id = res.createArgs.__updateId;
          const args = { ...res.createArgs }; delete args.__updateId;
          await mcpUpdateEmployee(user, String(id), args);
          committed.updated++;
          empId = id;
          res.commit = { ok: true, summary: `Updated employee #${id}` };
        } else {
          const args = { ...res.createArgs }; delete args.__updateId;
          const data = await mcpCreateEmployee(user, args, { correlationId });
          const emp = data?.employee ?? data?.data ?? data;
          empId = emp?.id ?? emp?.employee?.id ?? emp?.summary?.id ?? emp?.summary?.employeeId ?? data?.summary?.id;
          if (empId == null && args.employeeCode) {
            const found = await prisma.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { employee_code: args.employeeCode }), select: { id: true } }).catch(() => null);
            empId = found?.id;
          }
          committed.created++;
          tmpPassword = data?.systemAccount?.temporaryPassword || null;
          if (data?.systemAccount) committed.logins++;
          res.commit = { ok: true, summary: `Created employee #${empId ?? "?"}${data?.systemAccount ? " · login provisioned" : ""}` };
        }

        // Record this row's id so a later row can name it as a manager.
        res.__empId = empId != null ? Number(empId) : null;
        const rcode = cleanCell(res.rec.employee_code).toLowerCase();
        if (rcode && res.__empId != null) codeToNewId.set(rcode, res.__empId);

        // Direct Employee columns the create contract can't set (work_mode,
        // biometric_id, gradeLevelId) + the C4-encrypted login password.
        const patch = { ...(res.directColumns || {}) };
        if (tmpPassword) patch.login_password = encryptString(tmpPassword);
        if (empId != null && Object.keys(patch).length) {
          await prisma.employee.update({ where: { id: Number(empId) }, data: patch }).catch((e) =>
            logger.warn({ empId, err: e?.message }, "employee import: direct-column patch failed")
          );
        }

        // Person is owned by RBAC, not HR: Employee.personId is a cross-database
        // anchor (schema.prisma), so there is no local `person` model and
        // `prisma.person` is undefined. The upsert that used to sit here threw on
        // every single import and was swallowed by a bare catch, so personId was
        // never actually set and nobody noticed. Removed rather than left to fail
        // quietly. biometric_id is already applied above via directColumns;
        // linking to an RBAC Person would have to go through RBAC_SERVICE_URL.

        // Emergency contact + salary segregation — new records, create-only to
        // avoid duplicates when an existing employee_code is re-imported.
        if (empId != null && res.action === "create") {
          if (res.emergency) {
            await prisma.emergencyContacts.create({
              data: scopedData(tenantId, {
                Contact_name: res.emergency.name,
                relationship: res.emergency.relationship || null,
                phone: res.emergency.phone || null,
                email: res.emergency.email || null,
                is_primary: true,
                employee_Id: Number(empId),
              }),
            }).then(() => { committed.emergencyContacts++; }).catch((e) => logger.warn({ empId, err: e?.message }, "employee import: emergency contact create failed"));
          }
          if (res.salary?.total) {
            const basic = round2(res.salary.total * (BASIC_PCT_OF_TOTAL / 100));
            const eff = res.createArgs.hireDate || res.createArgs.joiningDate;
            await createEmploymentTerms({
              employeeId: Number(empId),
              baseSalary: String(basic),
              currency: res.salary.currency || "PKR",
              payFrequency: "MONTHLY",
              effectiveFrom: eff ? new Date(eff) : new Date(),
            }, Number(empId), tenantId).then(() => { committed.salaries++; }).catch((e) => logger.warn({ empId, err: e?.message }, "employee import: employment terms create failed"));
          }
        }
      } catch (err) {
        committed.failed++;
        res.status = "ERROR";
        res.commit = { error: err?.message || "create failed" };
        logger.warn({ rowNumber: res.rowNumber, err: err?.message }, "employee import: row commit failed");
      }
    }

    // Second pass: link managers that referenced another employee in THIS sheet
    // (that manager's Employee row didn't exist until the pass above created it).
    for (const res of results) {
      if (res.status === "ERROR" || !res.pendingManagerCode || res.__empId == null) continue;
      const mgrId = codeToNewId.get(res.pendingManagerCode);
      if (mgrId == null) {
        logger.warn({ rowNumber: res.rowNumber, code: res.pendingManagerCode }, "employee import: in-sheet manager code did not resolve (that row may have been skipped)");
        continue;
      }
      if (mgrId === res.__empId) continue; // self — already guarded in validation
      try {
        await mcpUpdateEmployee(user, String(res.__empId), { managerId: mgrId });
        committed.managersLinked++;
      } catch (e) {
        logger.warn({ rowNumber: res.rowNumber, empId: res.__empId, mgrId, err: e?.message }, "employee import: manager link failed");
      }
    }
  }

  const annotatedBase64 = await buildAnnotated(results);
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "OK").length,
    fixed: results.filter((r) => r.status === "FIXED").length,
    flagged: results.filter((r) => r.status === "ERROR").length,
    willCreate: results.filter((r) => r.status !== "ERROR" && r.action === "create").length,
    willUpdate: results.filter((r) => r.status !== "ERROR" && r.action === "update").length,
    dryRun: !!dryRun,
    committed: dryRun ? null : committed,
  };

  return {
    summary,
    fileName: `employee-import-${dryRun ? "preview" : "result"}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    annotatedBase64,
    rows: results.map((r) => ({
      row: r.rowNumber, status: r.status, action: r.action,
      issues: r.issues.map((i) => ({ field: i.key, severity: i.severity, message: i.msg })),
      result: r.commit || null,
    })),
  };
}
