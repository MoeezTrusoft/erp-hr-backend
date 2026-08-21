// HR-ATT-IMPORT-01 — bulk attendance history import.
//
// Grain: ONE ROW PER EMPLOYEE PER DAY. That matches the Attendance model exactly,
// and every anomaly a client cares about (late, missing punch, leave, remote) is
// a day-level fact. Punch-level grain would force the importer to re-derive the
// day, which is what the device intake already does for live punches.
//
// Idempotent by construction: rows upsert on (tenantId, employeeId, date@midnight).
// Re-running a file, or re-sending a chunk after a dropped connection, converges
// instead of duplicating. That is what lets a caller slice a 300k-row file into
// 5k-row calls with no batch state on the server — each chunk is independently safe.

import ExcelJS from "exceljs";
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// ── Controlled vocabularies ────────────────────────────────────────────────
// Attendance.work_mode and Leave.type are free-text String columns. Six years of
// spreadsheets WILL contain Remote / remote / WFH / "Work From Home". Normalise
// on the way in, or every downstream KPI splits across spellings.
const STATUS = ["PRESENT", "ABSENT", "LATE", "HALF_DAY"];
const DAY_TYPES = ["WORKING", "WEEKLY_OFF", "HOLIDAY", "LEAVE"];
const WORK_MODES = ["Onsite", "Remote", "Hybrid"];
const LEAVE_TYPES = ["ANNUAL", "SICK", "CASUAL", "UNPAID", "MATERNITY", "PATERNITY", "BEREAVEMENT", "COMPENSATORY", "OTHER"];
const ANOMALY_TYPES = ["LATE_CHECKIN", "MISSING_CHECKIN", "MISSING_CHECKOUT", "EARLY_CHECKOUT", "ABSENT", "OTHER"];
const RESOLUTIONS = ["APPROVED", "REJECTED"];

const WORK_MODE_SYNONYMS = {
  onsite: "Onsite", "on site": "Onsite", office: "Onsite", "in office": "Onsite", onpremise: "Onsite",
  remote: "Remote", wfh: "Remote", "work from home": "Remote", home: "Remote", telecommute: "Remote",
  hybrid: "Hybrid", mixed: "Hybrid", flex: "Hybrid",
};
const LEAVE_SYNONYMS = {
  annual: "ANNUAL", al: "ANNUAL", vacation: "ANNUAL", "paid leave": "ANNUAL", pl: "ANNUAL", earned: "ANNUAL",
  sick: "SICK", sl: "SICK", medical: "SICK",
  casual: "CASUAL", cl: "CASUAL",
  unpaid: "UNPAID", lwp: "UNPAID", "leave without pay": "UNPAID",
  maternity: "MATERNITY", paternity: "PATERNITY",
  bereavement: "BEREAVEMENT", compassionate: "BEREAVEMENT",
  comp: "COMPENSATORY", "comp off": "COMPENSATORY", compensatory: "COMPENSATORY", toil: "COMPENSATORY",
};
const DAY_TYPE_SYNONYMS = {
  working: "WORKING", work: "WORKING", workday: "WORKING", w: "WORKING",
  "weekly off": "WEEKLY_OFF", weeklyoff: "WEEKLY_OFF", off: "WEEKLY_OFF", weekend: "WEEKLY_OFF", "rest day": "WEEKLY_OFF",
  holiday: "HOLIDAY", "public holiday": "HOLIDAY", ph: "HOLIDAY",
  leave: "LEAVE", "on leave": "LEAVE",
};

export const COLUMNS = [
  "employee_code", "date", "day_type", "status", "check_in", "check_out",
  "work_mode", "leave_type", "anomaly_type", "anomaly_resolution", "remarks",
];

const norm = (v) => (v === null || v === undefined ? "" : String(v).trim());
const key = (v) => norm(v).toLowerCase().replace(/[\s_-]+/g, " ");

/** Accept the handful of date shapes six years of spreadsheets actually contain. */
export function parseDate(raw) {
  if (raw instanceof Date && !isNaN(raw)) {
    return new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
  }
  const s = norm(raw);
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return mkUTC(+m[1], +m[2], +m[3]);
  // Day-first (dd/mm/yyyy) — the dominant convention in this fleet's region.
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return mkUTC(+m[3], +m[2], +m[1]);
  const d = new Date(s);
  if (!isNaN(d)) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return null;
}
function mkUTC(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}

/**
 * Times are stored against the day, not as an absolute instant in a foreign
 * offset — an imported "09:02" must still read as 09:02 to the tenant in five
 * years, which is why it anchors to the row's own date instead of being parsed
 * as UTC.
 */
export function parseTime(raw, day) {
  if (!day) return null;
  if (raw instanceof Date && !isNaN(raw)) {
    return new Date(day.getTime() + raw.getUTCHours() * 3600000 + raw.getUTCMinutes() * 60000);
  }
  const s = norm(raw);
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ap = m[4]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return new Date(day.getTime() + h * 3600000 + min * 60000);
}

function pickEnum(raw, allowed, synonyms) {
  const s = norm(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/[\s-]+/g, "_");
  if (allowed.includes(up)) return up;
  const hit = synonyms?.[key(s)];
  if (hit) return hit;
  return allowed.find((a) => a.toLowerCase() === s.toLowerCase()) ?? null;
}

/**
 * Validate and auto-fix one row → { ok, fixes[], issues[], value }.
 * A row is rejected only when its meaning is genuinely ambiguous; anything
 * mechanically recoverable is fixed AND reported, never silently altered.
 */
export function validateRow(raw, lookup, seen) {
  const issues = [];
  const fixes = [];

  const code = norm(raw.employee_code);
  const employeeId = code ? lookup.byCode.get(code.toLowerCase()) : undefined;
  if (!code) issues.push("employee_code is required");
  else if (!employeeId) issues.push(`No employee with code "${code}" in this tenant`);

  const date = parseDate(raw.date);
  if (!norm(raw.date)) issues.push("date is required");
  else if (!date) issues.push(`Could not read the date "${norm(raw.date)}" — use YYYY-MM-DD`);

  // A file listing the same employee-day twice contradicts itself; the upsert
  // would silently keep whichever landed last.
  if (employeeId && date) {
    const k = `${employeeId}|${date.toISOString()}`;
    if (seen.has(k)) issues.push(`Duplicate row: ${code} on ${date.toISOString().slice(0, 10)} appears earlier in this file`);
    else seen.add(k);
  }

  let dayType = pickEnum(raw.day_type, DAY_TYPES, DAY_TYPE_SYNONYMS);
  if (!dayType) {
    if (norm(raw.day_type)) issues.push(`day_type "${norm(raw.day_type)}" is not one of ${DAY_TYPES.join(", ")}`);
    else { dayType = "WORKING"; fixes.push("day_type defaulted to WORKING"); }
  }

  const leaveType = pickEnum(raw.leave_type, LEAVE_TYPES, LEAVE_SYNONYMS);
  if (norm(raw.leave_type) && !leaveType) {
    issues.push(`leave_type "${norm(raw.leave_type)}" is not one of ${LEAVE_TYPES.join(", ")}`);
  }
  if (dayType === "LEAVE" && !leaveType) issues.push("day_type is LEAVE but leave_type is empty");
  if (dayType !== "LEAVE" && leaveType) {
    dayType = "LEAVE";
    fixes.push("day_type set to LEAVE because leave_type was filled");
  }

  const checkIn = parseTime(raw.check_in, date);
  const checkOut = parseTime(raw.check_out, date);
  if (norm(raw.check_in) && !checkIn) issues.push(`Could not read check_in "${norm(raw.check_in)}" — use HH:MM`);
  if (norm(raw.check_out) && !checkOut) issues.push(`Could not read check_out "${norm(raw.check_out)}" — use HH:MM`);
  if (checkIn && checkOut && checkOut <= checkIn) {
    // Night shifts are real; assume the checkout rolled past midnight rather
    // than rejecting the row.
    fixes.push("check_out is before check_in — treated as an overnight shift (+1 day)");
  }

  let status = pickEnum(raw.status, STATUS, null);
  if (norm(raw.status) && !status) issues.push(`status "${norm(raw.status)}" is not one of ${STATUS.join(", ")}`);
  if (!status) {
    // A leave day is NOT an absence in spirit, but StatusAttendance has no LEAVE
    // member — day_type carries that meaning, which is exactly why the column
    // exists. Without it an absence is indistinguishable from a Sunday.
    if (dayType === "LEAVE" || dayType === "WEEKLY_OFF" || dayType === "HOLIDAY") status = "ABSENT";
    else status = checkIn ? "PRESENT" : "ABSENT";
    fixes.push(`status derived as ${status}`);
  }

  let workMode = pickEnum(raw.work_mode, WORK_MODES, WORK_MODE_SYNONYMS);
  if (norm(raw.work_mode) && !workMode) issues.push(`work_mode "${norm(raw.work_mode)}" is not one of ${WORK_MODES.join(", ")}`);
  if (!workMode && dayType === "WORKING" && status !== "ABSENT") {
    workMode = "Onsite";
    fixes.push("work_mode defaulted to Onsite");
  }

  const anomalyType = pickEnum(raw.anomaly_type, ANOMALY_TYPES, null);
  if (norm(raw.anomaly_type) && !anomalyType) {
    issues.push(`anomaly_type "${norm(raw.anomaly_type)}" is not one of ${ANOMALY_TYPES.join(", ")}`);
  }
  let resolution = pickEnum(raw.anomaly_resolution, RESOLUTIONS, null);
  if (norm(raw.anomaly_resolution) && !resolution) {
    issues.push(`anomaly_resolution "${norm(raw.anomaly_resolution)}" must be APPROVED or REJECTED`);
  }
  if (anomalyType && !resolution) {
    // Historical anomalies are already settled. Importing them PENDING would
    // dump years of closed items into the live HR review queue.
    resolution = "APPROVED";
    fixes.push("anomaly_resolution defaulted to APPROVED (historical rows are already settled)");
  }

  let totalHours = null;
  if (checkIn && checkOut) {
    const end = checkOut <= checkIn ? new Date(checkOut.getTime() + 86400000) : checkOut;
    totalHours = Math.round(((end - checkIn) / 3600000 + Number.EPSILON) * 100) / 100;
  }

  return {
    ok: issues.length === 0,
    issues,
    fixes,
    value: issues.length ? null : {
      employeeId, date, dayType, status,
      checkIn, checkOut, totalHours, workMode, leaveType,
      anomalyType, resolution, remarks: norm(raw.remarks) || null,
    },
  };
}

/**
 * Consecutive same-type leave days collapse into ONE Leave row. Leave is a range
 * model with total_days — emitting one row per day would report five separate
 * one-day annual leaves instead of a single five-day request, and wreck every
 * balance calculation downstream.
 */
export function collapseLeaves(rows) {
  const byEmp = new Map();
  for (const r of rows) {
    if (r.dayType !== "LEAVE" || !r.leaveType) continue;
    if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, []);
    byEmp.get(r.employeeId).push(r);
  }
  const out = [];
  for (const [employeeId, list] of byEmp) {
    list.sort((a, b) => a.date - b.date);
    let run = null;
    for (const r of list) {
      const contiguous = run
        && run.type === r.leaveType
        && r.date.getTime() - run.end_date.getTime() === 86400000;
      if (contiguous) {
        run.end_date = r.date;
        run.total_days += 1;
      } else {
        if (run) out.push(run);
        run = { employeeId, type: r.leaveType, start_date: r.date, end_date: r.date, total_days: 1 };
      }
    }
    if (run) out.push(run);
  }
  return out;
}

async function loadEmployeeLookup(tenantId) {
  const employees = await prisma.employee.findMany({
    where: scopedWhere(tenantId, {}),
    select: { id: true, employee_code: true },
  });
  const byCode = new Map();
  for (const e of employees) {
    if (e.employee_code) byCode.set(String(e.employee_code).toLowerCase(), e.id);
  }
  return { byCode, count: employees.length };
}

function readCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const split = (line) => {
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]).map((h) => key(h).replace(/ /g, "_"));
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const rec = {};
    headers.forEach((h, i) => { rec[h] = cells[i] ?? ""; });
    return rec;
  });
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet("Attendance") || wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col] = key(cell.value).replace(/ /g, "_"); });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const rec = {};
    let empty = true;
    row.eachCell((cell, col) => {
      const h = headers[col];
      if (!h) return;
      const v = cell.value?.result ?? cell.value?.text ?? cell.value;
      rec[h] = v instanceof Date ? v : norm(v);
      if (norm(rec[h])) empty = false;
    });
    if (!empty) rows.push(rec);
  });
  return rows;
}

/** The empty spreadsheet, with the vocabulary baked in as dropdowns. */
export async function generateAttendanceImportTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Attendance");
  ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: c.length + 8 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const dropdown = (col, values) => {
    for (let r = 2; r <= 5000; r++) {
      ws.getCell(`${col}${r}`).dataValidation = {
        type: "list", allowBlank: true, formulae: [`"${values.join(",")}"`],
      };
    }
  };
  dropdown("C", DAY_TYPES);
  dropdown("D", STATUS);
  dropdown("G", WORK_MODES);
  dropdown("H", LEAVE_TYPES);
  dropdown("I", ANOMALY_TYPES);
  dropdown("J", RESOLUTIONS);

  const ex = wb.addWorksheet("Example");
  ex.columns = COLUMNS.map((c) => ({ header: c, key: c, width: c.length + 8 }));
  ex.getRow(1).font = { bold: true };
  [
    ["E-1042", "2021-03-01", "WORKING", "PRESENT", "09:02", "18:05", "Onsite", "", "", "", ""],
    ["E-1042", "2021-03-02", "WORKING", "LATE", "10:47", "18:30", "Onsite", "", "LATE_CHECKIN", "APPROVED", "Traffic"],
    ["E-1042", "2021-03-03", "WORKING", "PRESENT", "09:00", "", "Remote", "", "MISSING_CHECKOUT", "APPROVED", "Forgot to punch out"],
    ["E-1042", "2021-03-04", "LEAVE", "ABSENT", "", "", "", "ANNUAL", "", "", "Annual leave 4-8 Mar"],
    ["E-1042", "2021-03-06", "WEEKLY_OFF", "", "", "", "", "", "", "", ""],
  ].forEach((r) => ex.addRow(r));

  const info = wb.addWorksheet("Instructions");
  info.columns = [{ width: 24 }, { width: 96 }];
  info.addRow(["Grain", "ONE ROW PER EMPLOYEE PER DAY."]);
  info.addRow(["employee_code", "Must match an employee in this tenant — the same code the employee importer upserts on."]);
  info.addRow(["date", "YYYY-MM-DD preferred. dd/mm/yyyy is accepted and read day-first."]);
  info.addRow(["day_type", `${DAY_TYPES.join(" | ")}. Without it an absence cannot be told apart from a Sunday, and every attendance-rate metric is wrong.`]);
  info.addRow(["status", `${STATUS.join(" | ")}. Left blank it is derived from the punches and day_type.`]);
  info.addRow(["check_in / check_out", "HH:MM local. Blank means the punch is MISSING — that is meaningful, not zero."]);
  info.addRow(["work_mode", WORK_MODES.join(" | ")]);
  info.addRow(["leave_type", `${LEAVE_TYPES.join(" | ")}. Consecutive same-type days merge into ONE leave request.`]);
  info.addRow(["anomaly_type", ANOMALY_TYPES.join(" | ")]);
  info.addRow(["anomaly_resolution", "APPROVED | REJECTED. Defaults to APPROVED: historical anomalies are already settled, and importing them PENDING would flood the live HR review queue."]);
  info.addRow(["Weekends & holidays", "Optional. Omit them and the day is simply absent from the ledger; include them as WEEKLY_OFF / HOLIDAY for a complete calendar."]);
  info.addRow(["Re-running", "Safe. Rows upsert on employee + date, so a re-run or a resent chunk corrects rather than duplicates."]);
  info.addRow(["Large files", "At most ~5000 rows per call. Chunks are independent — no batch id, no ordering requirement."]);
  info.getColumn(1).font = { bold: true };
  info.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const buf = await wb.xlsx.writeBuffer();
  return {
    fileName: "HR_Attendance_Import_Template.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileBase64: Buffer.from(buf).toString("base64"),
    columns: COLUMNS,
  };
}

async function buildReport(results) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Result");
  ws.columns = [
    { header: "__row", key: "__row", width: 8 },
    { header: "__row_status", key: "__row_status", width: 14 },
    { header: "__issues", key: "__issues", width: 80 },
    ...COLUMNS.map((c) => ({ header: c, key: c, width: c.length + 8 })),
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of results) {
    const row = ws.addRow({
      __row: r.rowNumber,
      __row_status: r.status,
      __issues: (r.issues.length ? r.issues : r.fixes).join("; "),
      ...r.raw,
    });
    const colour = r.status === "ERROR" ? "FFF8D7DA" : r.status === "FIXED" ? "FFFFF3CD" : "FFD4EDDA";
    row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour } };
    if (r.status === "ERROR") row.getCell(3).font = { color: { argb: "FF9C1C24" } };
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString("base64");
}

/**
 * @param {object}  p
 * @param {string}  p.tenantId
 * @param {string}  p.fileBase64        the .csv/.xlsx payload
 * @param {"csv"|"xlsx"} p.format
 * @param {boolean} p.dryRun            default TRUE — nothing is written
 * @param {boolean} p.importLeaves      also create Leave rows (default true)
 * @param {boolean} p.importAnomalies   also create AttendanceAnomaly rows (default true)
 */
export async function runAttendanceImport({
  tenantId, fileBase64, format = "xlsx", dryRun = true,
  importLeaves = true, importAnomalies = true,
} = {}) {
  if (!tenantId) throw Object.assign(new Error("tenantId is required"), { status: 400 });
  if (!fileBase64) throw Object.assign(new Error("fileBase64 is required"), { status: 400 });

  const buffer = Buffer.from(fileBase64, "base64");
  const raws = format === "csv" ? readCsv(buffer.toString("utf8")) : await readXlsx(buffer);
  if (!raws.length) throw Object.assign(new Error("The file has no data rows"), { status: 400 });
  if (raws.length > 20000) {
    throw Object.assign(
      new Error(`${raws.length} rows in one call — split into chunks of ~5000. Chunks are independent and safe to retry.`),
      { status: 413 },
    );
  }

  const lookup = await loadEmployeeLookup(tenantId);
  const seen = new Set();
  const results = [];
  const good = [];

  raws.forEach((raw, i) => {
    const v = validateRow(raw, lookup, seen);
    results.push({
      rowNumber: i + 2,
      raw,
      status: !v.ok ? "ERROR" : v.fixes.length ? "FIXED" : "OK",
      issues: v.issues,
      fixes: v.fixes,
    });
    if (v.ok) good.push(v.value);
  });

  const summary = {
    totalRows: raws.length,
    ok: results.filter((r) => r.status === "OK").length,
    autoFixed: results.filter((r) => r.status === "FIXED").length,
    errors: results.filter((r) => r.status === "ERROR").length,
    employeesInTenant: lookup.count,
    dryRun,
    attendanceWritten: 0,
    leavesWritten: 0,
    anomaliesWritten: 0,
  };

  if (!dryRun && good.length) {
    // Chunked so one oversized file cannot hold a transaction open for minutes.
    const CHUNK = 500;
    for (let i = 0; i < good.length; i += CHUNK) {
      const slice = good.slice(i, i + CHUNK);
      await prisma.$transaction(
        slice.map((r) =>
          prisma.attendance.upsert({
            where: { tenantId_employeeId_date: { tenantId, employeeId: r.employeeId, date: r.date } },
            create: scopedData(tenantId, {
              employeeId: r.employeeId, date: r.date,
              check_in: r.checkIn, check_out: r.checkOut, total_hours: r.totalHours,
              status: r.status, work_mode: r.workMode, remarks: r.remarks,
            }),
            update: {
              check_in: r.checkIn, check_out: r.checkOut, total_hours: r.totalHours,
              status: r.status, work_mode: r.workMode, remarks: r.remarks,
            },
          }),
        ),
      );
      summary.attendanceWritten += slice.length;
    }

    if (importLeaves) {
      for (const l of collapseLeaves(good)) {
        // Range-level idempotency: same employee + type + start day is the same
        // request however many times the file is replayed.
        const existing = await prisma.leave.findFirst({
          where: scopedWhere(tenantId, { employeeId: l.employeeId, type: l.type, start_date: l.start_date }),
          select: { id: true },
        });
        if (existing) {
          await prisma.leave.update({
            where: { id: existing.id },
            data: { end_date: l.end_date, total_days: l.total_days, status: "APPROVED" },
          });
        } else {
          await prisma.leave.create({
            data: scopedData(tenantId, { ...l, status: "APPROVED", reason: "Imported attendance history" }),
          });
        }
        summary.leavesWritten += 1;
      }
    }

    if (importAnomalies) {
      for (const r of good.filter((x) => x.anomalyType)) {
        const existing = await prisma.attendanceAnomaly.findFirst({
          where: scopedWhere(tenantId, { employeeId: r.employeeId, date: r.date, type: r.anomalyType }),
          select: { id: true },
        });
        if (existing) continue;
        await prisma.attendanceAnomaly.create({
          data: scopedData(tenantId, {
            employeeId: r.employeeId, type: r.anomalyType, date: r.date,
            reason: r.remarks, status: r.resolution,
            reviewNote: "Imported attendance history", decidedAt: new Date(),
          }),
        });
        summary.anomaliesWritten += 1;
      }
    }
  }

  return {
    summary,
    fileName: `attendance-import-${dryRun ? "preview" : "result"}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    reportBase64: await buildReport(results),
  };
}
