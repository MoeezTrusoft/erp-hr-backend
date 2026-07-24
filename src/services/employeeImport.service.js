// src/services/employeeImport.service.js
//
// Bulk EMPLOYEE IMPORT — the validate → auto-fix → annotate → commit engine
// behind hr_employees_import / hr_employees_import_template.
//
// Design goals (per product ask): robust and forgiving. Every cell is trimmed
// and, where possible, AUTO-FIXED (enum synonyms, many date formats, email/phone
// normalization, name-title-casing, name→id lookups). Anything that cannot be
// safely fixed is FLAGGED on a returned copy of the sheet: the offending cell is
// coloured red with a plain-English comment, and two summary columns
// (__row_status, __issues) are appended. Nothing is written unless dryRun=false,
// and even then only OK/FIXED rows are committed (reds are skipped). Idempotent:
// a row whose employee_code already exists UPDATES that employee (no duplicates).

import ExcelJS from "exceljs";
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedEmployeeWhere, scopedWhere } from "../lib/tenancy.js";
import { listDepartments, listRoles } from "./rbac.client.js";
import { mcpCreateEmployee, mcpUpdateEmployee } from "../mcp/controllers/employeeMcpController.js";
import {
  IMPORT_COLUMNS,
  IMPORT_HEADERS,
  COLUMN_BY_KEY,
  cleanCell,
  isBlank,
  titleCase,
  normalizeEmail,
  normalizePhone,
  normalizeEnum,
  parseDate,
  parseFte,
  nearest,
} from "../lib/employeeImportTaxonomy.js";

const MAXROWS = 600;
const FILL = { req: "FFC00000", key: "FF1F6FEB", opt: "FF44546A" };
const HEADER_FONT = { color: { argb: "FFFFFFFF" }, bold: true, size: 11 };
const STATUS_FILL = { OK: "FFDDF3DD", FIXED: "FFFFF3CD", ERROR: "FFF8D2D2" };
const CELL_FIX = "FFFFF3CD"; // yellow — auto-fixed
const CELL_ERR = "FFF8D2D2"; // red — needs attention

// ── Template header styling (shared by template + annotated output) ──────────
function writeHeader(ws, withStatusCols) {
  IMPORT_COLUMNS.forEach((c, i) => {
    const cell = ws.getRow(1).getCell(i + 1);
    cell.value = c.key + (c.kind === "req" ? " *" : c.kind === "key" ? " ★" : "");
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[c.kind] } };
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.note = c.note;
    ws.getColumn(i + 1).width = c.key.length < 12 ? 14 : 18;
  });
  if (withStatusCols) {
    const base = IMPORT_COLUMNS.length;
    const cols = [
      { t: "__row_status", w: 14 },
      { t: "__issues", w: 70 },
    ];
    cols.forEach((c, k) => {
      const cell = ws.getRow(1).getCell(base + 1 + k);
      cell.value = c.t;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF222222" } };
      cell.font = HEADER_FONT;
      ws.getColumn(base + 1 + k).width = c.w;
    });
  }
  ws.getRow(1).height = 26;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: IMPORT_COLUMNS.length + (withStatusCols ? 2 : 0) } };
}

function addDropdowns(ws) {
  IMPORT_COLUMNS.forEach((c, i) => {
    if (!c.enum) return;
    const letter = ws.getColumn(i + 1).letter;
    for (let r = 2; r <= MAXROWS; r++) {
      ws.getCell(`${letter}${r}`).dataValidation = {
        type: "list", allowBlank: true, formulae: [`"${c.enum.join(",")}"`],
        showErrorMessage: true, errorStyle: "warning", errorTitle: "Pick from list",
        error: `Suggested: ${c.enum.join(", ")}. Other values are auto-corrected or flagged.`,
      };
    }
  });
}

// ── Downloadable empty template ──────────────────────────────────────────────
export async function generateImportTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TruSoft ERP — HR";
  const ws = wb.addWorksheet("Employees");
  writeHeader(ws, false);
  addDropdowns(ws);

  const ex = wb.addWorksheet("Example (not imported)");
  writeHeader(ex, false);
  const rowFrom = (o) => IMPORT_HEADERS.map((h) => (o[h] !== undefined ? o[h] : ""));
  ex.addRow(rowFrom({
    first_name: "Ayesha", last_name: "Khan", employee_code: "EMP-1042", gender: "Female",
    date_of_birth: "1996-04-12", marital_status: "Single", nationality: "Pakistani",
    national_id_type: "CNIC", national_id_number: "35202-1234567-8",
    personal_email: "ayesha.khan@gmail.com", work_email: "ayesha.khan@bookcraft.pk",
    mobile_phone: "+92 300 1234567", city: "Karachi", country: "Pakistan",
    job_title: "Software Engineer", department: "Engineering", position: "Software Engineer",
    manager: "EMP-0078", employment_type: "Full-time", employment_status: "Active",
    hire_date: "2026-07-01", joining_date: "2026-07-01", work_mode: "On-site", fte: 1,
    create_login: "yes", login_email: "ayesha.khan@bookcraft.pk", role: "Employee",
  }));
  ex.addRow(rowFrom({
    first_name: "Bilal", last_name: "Ahmed", employee_code: "EMP-1043", gender: "Male",
    work_email: "bilal.ahmed@bookcraft.pk", mobile_phone: "03011234567",
    job_title: "Accountant", department: "Finance", employment_type: "Full-time",
    hire_date: "2026-06-15", work_mode: "Hybrid", create_login: "no",
  }));

  const ins = wb.addWorksheet("Instructions");
  ins.getColumn(1).width = 3; ins.getColumn(2).width = 120;
  [
    ["", "HR EMPLOYEE BULK IMPORT — how to use this sheet"], ["", ""],
    ["1", "Fill your data in the 'Employees' tab (one employee per row). The 'Example' tab is IGNORED on import."],
    ["2", "Columns marked * are REQUIRED (first_name, last_name). Everything else is optional."],
    ["3", "★ employee_code is the BIOMETRIC KEY — set it to the exact user-ID enrolled on the ZKTeco device so punches auto-map. Keep it UNIQUE. Blank → auto-generated (biometric won't map until reconciled)."],
    ["4", "Dropdown columns accept the listed values; close synonyms are auto-corrected (M→Male, FT→Full-time, WFH→Remote), anything else is flagged."],
    ["5", "Dates: YYYY-MM-DD is safest. DD/MM/YYYY, D-Mon-YY and Excel dates are auto-parsed (ambiguous DD/MM vs MM/DD is read DAY-first)."],
    ["6", "department / position / manager / role match BY NAME to existing records (case-insensitive). manager also accepts an employee_code. Unknown names are flagged with the nearest suggestion."],
    ["7", "Logins: create_login=yes provisions an RBAC login (role required). Blank password → a one-time password is auto-generated and returned in the import result."],
    ["8", "Import runs a PREVIEW first: you get this sheet back with a colour-coded __row_status (GREEN ok / YELLOW auto-fixed / RED needs attention) and a plain-English __issues column. Fix the reds and re-upload."],
    ["9", "Nothing is saved until you confirm. Re-importing an existing employee_code UPDATES that employee (no duplicates)."],
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
  // Prefer a sheet literally named "Employees"; else the first non-example sheet.
  let ws = wb.getWorksheet("Employees");
  if (!ws) ws = wb.worksheets.find((s) => !/example|instruction/i.test(s.name)) || wb.worksheets[0];
  if (!ws) throw Object.assign(new Error("No worksheet found in the uploaded file"), { status: 400 });

  // Map header cells → our column keys (strip * / ★, lower, snake-ish).
  const headerRow = ws.getRow(1);
  const idxByKey = {};
  headerRow.eachCell((cell, col) => {
    const norm = cleanCell(cell.value).replace(/[*★]/g, "").trim().toLowerCase().replace(/\s+/g, "_");
    if (COLUMN_BY_KEY[norm]) idxByKey[norm] = col;
  });
  if (!idxByKey.first_name || !idxByKey.last_name) {
    throw Object.assign(
      new Error("The sheet is missing required 'first_name'/'last_name' headers. Use the template from hr_employees_import_template."),
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
  const [departments, positions, employees, roles] = await Promise.all([
    listDepartments().catch(() => []),
    prisma.position.findMany({ where: scopedWhere(tenantId, {}), select: { id: true, title: true } }).catch(() => []),
    prisma.employee.findMany({ where: scopedEmployeeWhere(tenantId, {}), select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true, work_email: true, email: true } }).catch(() => []),
    needsRoles ? listRoles().catch(() => []) : Promise.resolve([]),
  ]);
  const ciMap = (arr, nameKey, idKey = "id") => {
    const m = new Map();
    for (const x of arr) { const n = x?.[nameKey]; if (n) m.set(String(n).trim().toLowerCase(), x[idKey]); }
    return m;
  };
  const deptMap = ciMap(departments, "name");
  const posMap = ciMap(positions, "title");
  const roleMap = ciMap(roles, "name");
  const empByCode = new Map();
  const empByName = new Map();
  const codeToId = new Map();
  const emailExisting = new Set();
  for (const e of employees) {
    const nm = e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ");
    if (e.employee_code) { empByCode.set(String(e.employee_code).trim().toLowerCase(), e.id); codeToId.set(String(e.employee_code).trim().toLowerCase(), e.id); }
    if (nm) empByName.set(nm.trim().toLowerCase(), e.id);
    if (e.work_email) emailExisting.add(e.work_email.trim().toLowerCase());
    if (e.email) emailExisting.add(e.email.trim().toLowerCase());
  }
  return {
    deptMap, posMap, roleMap, empByCode, empByName, codeToId, emailExisting,
    deptNames: departments.map((d) => d.name),
    posNames: positions.map((p) => p.title),
    roleNames: roles.map((r) => r.name),
  };
}

// ── Validate + auto-fix ONE row → { status, fixes, issues, createArgs, action } ─
function validateRow(rec, lk, { dayFirst, upsert }, seen) {
  const fixes = []; // { key, from, to }
  const issues = []; // { key, msg, severity:'error'|'warn' }
  const out = {}; // create arg name → value
  const direct = {}; // Employee columns the create contract cannot set → post-write patch
  const set = (key, value) => {
    const col = COLUMN_BY_KEY[key];
    if (value === "" || value == null) return;
    if (col?.create) out[col.create] = value;
    else if (col?.direct) direct[col.direct] = value;
  };

  for (const col of IMPORT_COLUMNS) {
    const key = col.key;
    const raw = rec[key];

    // required
    if (col.required && isBlank(raw)) { issues.push({ key, msg: `Missing required field '${key}'.`, severity: "error" }); continue; }
    if (isBlank(raw)) continue;

    if (key === "first_name" || key === "last_name" || key === "middle_name" || key === "preferred_name") {
      const tc = titleCase(cleanCell(raw));
      if (tc !== cleanCell(raw)) fixes.push({ key, from: cleanCell(raw), to: tc });
      set(key, tc);
    } else if (col.enum && key !== "create_login") {
      const n = normalizeEnum(key, raw);
      if (!n.matched) { issues.push({ key, msg: `'${cleanCell(raw)}' is not a valid ${key}${n.suggestion ? ` — did you mean '${n.suggestion}'?` : ` (allowed: ${col.enum.join(", ")})`}.`, severity: "error" }); continue; }
      if (n.fixed) fixes.push({ key, from: cleanCell(raw), to: n.value });
      set(key, n.value);
    } else if (col.date) {
      const d = parseDate(raw, { dayFirst });
      if (!d.valid) { issues.push({ key, msg: `'${cleanCell(raw)}' is not a recognizable date — use YYYY-MM-DD.`, severity: "error" }); continue; }
      if (d.fixed) fixes.push({ key, from: cleanCell(raw), to: d.value });
      set(key, d.value);
    } else if (col.email) {
      const e = normalizeEmail(raw);
      if (!e.valid) { issues.push({ key, msg: `'${cleanCell(raw)}' is not a valid email address.`, severity: "error" }); continue; }
      if (e.fixed) fixes.push({ key, from: cleanCell(raw), to: e.value });
      set(key, e.value);
    } else if (col.phone) {
      const p = normalizePhone(raw);
      if (!p.valid) issues.push({ key, msg: `Phone '${cleanCell(raw)}' looks unusual (kept as-is) — verify the number.`, severity: "warn" });
      if (p.fixed) fixes.push({ key, from: cleanCell(raw), to: p.value });
      set(key, p.value);
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
    } else if (col.lookup === "manager") {
      const v = cleanCell(raw).toLowerCase();
      const id = lk.empByCode.get(v) ?? lk.empByName.get(v);
      if (id == null) { issues.push({ key, msg: `Manager '${cleanCell(raw)}' not found by employee_code or full name.`, severity: "error" }); continue; }
      set(key, id);
    } else if (col.lookup === "role") {
      // resolved below together with create_login gating
      set("role", cleanCell(raw)); // temp raw; replaced below
    } else {
      set(key, cleanCell(raw));
    }
  }

  // ── employee_code: uniqueness (within sheet) + existing → update ────────────
  const code = cleanCell(rec.employee_code).toLowerCase();
  let action = "create";
  if (code) {
    if (seen.codes.has(code)) issues.push({ key: "employee_code", msg: `Duplicate employee_code '${cleanCell(rec.employee_code)}' also on row ${seen.codes.get(code)}.`, severity: "error" });
    else seen.codes.set(code, rec.__rowNumber);
    if (lk.codeToId.has(code)) {
      if (upsert) { action = "update"; out.__updateId = lk.codeToId.get(code); issues.push({ key: "employee_code", msg: `Existing employee_code — this row will UPDATE employee #${lk.codeToId.get(code)}.`, severity: "warn" }); }
      else issues.push({ key: "employee_code", msg: `employee_code already exists (turn on upsert to update).`, severity: "error" });
    }
  } else {
    issues.push({ key: "employee_code", msg: `No employee_code — one will be auto-generated; biometric punches won't map until you set it to the device enrollment ID.`, severity: "warn" });
  }

  // ── work_email uniqueness (within sheet + vs existing) ──────────────────────
  const we = cleanCell(rec.work_email).toLowerCase();
  if (we) {
    if (seen.emails.has(we)) issues.push({ key: "work_email", msg: `Duplicate work_email '${cleanCell(rec.work_email)}' also on row ${seen.emails.get(we)}.`, severity: "error" });
    else seen.emails.set(we, rec.__rowNumber);
    if (action === "create" && lk.emailExisting.has(we)) issues.push({ key: "work_email", msg: `work_email '${cleanCell(rec.work_email)}' already belongs to another employee.`, severity: "error" });
  }

  // ── login provisioning gate ─────────────────────────────────────────────────
  const loginRaw = cleanCell(rec.create_login);
  const login = normalizeEnum("create_login", loginRaw).value; // yes|no|''
  if (login === "yes") {
    out.createSystemAccount = true;
    // resolve role
    const roleRaw = cleanCell(rec.role);
    if (!roleRaw) issues.push({ key: "role", msg: `create_login=yes requires a role.`, severity: "error" });
    else {
      const rid = lk.roleMap.get(roleRaw.toLowerCase());
      if (rid == null) { const s = nearest(roleRaw, lk.roleNames); issues.push({ key: "role", msg: `Role '${roleRaw}' not found${s ? ` — did you mean '${s}'?` : ""}.`, severity: "error" }); }
      else out.roleId = rid;
    }
    // login email fallback
    if (!out.systemEmail) out.systemEmail = out.workEmail || out.personalEmail;
    if (!out.systemEmail) issues.push({ key: "login_email", msg: `create_login=yes needs a login email (or a work_email/personal_email to fall back to).`, severity: "error" });
  } else {
    delete out.createSystemAccount;
    delete out.roleId;
    // 'role'/'password' without a login are harmless — drop them
    delete out.password;
  }
  // strip the temp raw role string if it wasn't turned into roleId
  if (typeof out.roleId !== "number") delete out.roleId;
  if (out.role) delete out.role;

  const hasError = issues.some((i) => i.severity === "error");
  const status = hasError ? "ERROR" : fixes.length || issues.length ? "FIXED" : "OK";
  return { status, fixes, issues, createArgs: out, directColumns: direct, action };
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
  addDropdowns(ws);

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

// ── Public: run the import ───────────────────────────────────────────────────
export async function runEmployeeImport({ user, tenantId, fileBase64, format, dryRun = true, dayFirst = true, upsert = true, correlationId } = {}) {
  if (!fileBase64) throw Object.assign(new Error("fileBase64 is required"), { status: 400 });
  const buffer = Buffer.from(String(fileBase64).replace(/^data:[^,]+,/, ""), "base64");
  const { rows } = await parseUpload(buffer, format);
  if (!rows.length) throw Object.assign(new Error("The sheet has no data rows to import."), { status: 400 });

  const needsRoles = rows.some((r) => normalizeEnum("create_login", r.rec.create_login).value === "yes");
  const lk = await buildLookups(tenantId, needsRoles);

  const seen = { codes: new Map(), emails: new Map() };
  const results = [];
  for (const { rowNumber, rec } of rows) {
    rec.__rowNumber = rowNumber;
    const v = validateRow(rec, lk, { dayFirst, upsert }, seen);
    results.push({ rowNumber, rec, ...v });
  }

  // Commit (only when not a dry run): OK/FIXED rows.
  const committed = { created: 0, updated: 0, failed: 0, logins: 0 };
  if (!dryRun) {
    for (const res of results) {
      if (res.status === "ERROR") continue;
      try {
        let empId;
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
          // Bulletproof fallback: the create profile nests the id — re-resolve by
          // the (unique, tenant-scoped) employee_code so the direct-column patch
          // and the reported id are always correct.
          if (empId == null && args.employeeCode) {
            const found = await prisma.employee.findFirst({ where: scopedEmployeeWhere(tenantId, { employee_code: args.employeeCode }), select: { id: true } }).catch(() => null);
            empId = found?.id;
          }
          committed.created++;
          const tmp = data?.systemAccount?.temporaryPassword;
          if (data?.systemAccount) committed.logins++;
          res.commit = { ok: true, summary: `Created employee #${empId ?? "?"}${tmp ? ` · login password: ${tmp}` : data?.systemAccount ? " · login provisioned" : ""}` };
        }
        // Columns the create contract can't set (e.g. work_mode) — patch directly,
        // tenant-scoped so RLS still fences the write.
        if (empId != null && res.directColumns && Object.keys(res.directColumns).length) {
          await prisma.employee.update({ where: { id: Number(empId) }, data: res.directColumns }).catch((e) =>
            logger.warn({ empId, err: e?.message }, "employee import: direct-column patch failed")
          );
        }
      } catch (err) {
        committed.failed++;
        res.status = "ERROR";
        res.commit = { error: err?.message || "create failed" };
        logger.warn({ rowNumber: res.rowNumber, err: err?.message }, "employee import: row commit failed");
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
