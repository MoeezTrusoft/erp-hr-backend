import { createHash } from "node:crypto";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { captureAudit } from "./attendanceCapture.service.js";
import { assertCapturePeriodOpen } from "./attendanceCaptureWorker.service.js";
import {
  captureError,
  jsonValue,
  fingerprint,
} from "../lib/attendanceCapture.js";
// HR-ATT-IMPORT-01 — bulk attendance history import.
//
// Grain: ONE ROW PER EMPLOYEE PER DAY. That matches the Attendance model exactly,
// and every anomaly a client cares about (late, missing punch, leave, remote) is
// a day-level fact. Punch-level grain would force the importer to re-derive the
// day, which is what the device intake already does for live punches.
//
// A saved preview is committed in bounded, resumable transactions. Each chunk
// verifies the reviewed attendance version and protected periods before writing.

import ExcelJS from "exceljs";
import prisma from "../lib/prisma.js";

// ── Controlled vocabularies ────────────────────────────────────────────────
// Attendance.work_mode and Leave.type are free-text String columns. Six years of
// spreadsheets WILL contain Remote / remote / WFH / "Work From Home". Normalise
// on the way in, or every downstream KPI splits across spellings.
const STATUS = ["PRESENT", "ABSENT", "LATE", "HALF_DAY"];
const DAY_TYPES = ["WORKING", "WEEKLY_OFF", "HOLIDAY", "LEAVE"];
const WORK_MODES = ["Onsite", "Remote", "Hybrid"];
const LEAVE_TYPES = [
  "ANNUAL",
  "SICK",
  "CASUAL",
  "UNPAID",
  "MATERNITY",
  "PATERNITY",
  "BEREAVEMENT",
  "COMPENSATORY",
  "OTHER",
];
const ANOMALY_TYPES = [
  "LATE_CHECKIN",
  "MISSING_CHECKIN",
  "MISSING_CHECKOUT",
  "EARLY_CHECKOUT",
  "ABSENT",
  "OTHER",
];
const RESOLUTIONS = ["APPROVED", "REJECTED"];

const WORK_MODE_SYNONYMS = {
  onsite: "Onsite",
  "on site": "Onsite",
  office: "Onsite",
  "in office": "Onsite",
  onpremise: "Onsite",
  remote: "Remote",
  wfh: "Remote",
  "work from home": "Remote",
  home: "Remote",
  telecommute: "Remote",
  hybrid: "Hybrid",
  mixed: "Hybrid",
  flex: "Hybrid",
};
const LEAVE_SYNONYMS = {
  annual: "ANNUAL",
  al: "ANNUAL",
  vacation: "ANNUAL",
  "paid leave": "ANNUAL",
  pl: "ANNUAL",
  earned: "ANNUAL",
  sick: "SICK",
  sl: "SICK",
  medical: "SICK",
  casual: "CASUAL",
  cl: "CASUAL",
  unpaid: "UNPAID",
  lwp: "UNPAID",
  "leave without pay": "UNPAID",
  maternity: "MATERNITY",
  paternity: "PATERNITY",
  bereavement: "BEREAVEMENT",
  compassionate: "BEREAVEMENT",
  comp: "COMPENSATORY",
  "comp off": "COMPENSATORY",
  compensatory: "COMPENSATORY",
  toil: "COMPENSATORY",
};
const DAY_TYPE_SYNONYMS = {
  working: "WORKING",
  work: "WORKING",
  workday: "WORKING",
  w: "WORKING",
  "weekly off": "WEEKLY_OFF",
  weeklyoff: "WEEKLY_OFF",
  off: "WEEKLY_OFF",
  weekend: "WEEKLY_OFF",
  "rest day": "WEEKLY_OFF",
  holiday: "HOLIDAY",
  "public holiday": "HOLIDAY",
  ph: "HOLIDAY",
  leave: "LEAVE",
  "on leave": "LEAVE",
};

export const COLUMNS = [
  "employee_code",
  "date",
  "day_type",
  "status",
  "check_in",
  "check_out",
  "work_mode",
  "leave_type",
  "anomaly_type",
  "anomaly_resolution",
  "remarks",
];

const norm = (v) => (v === null || v === undefined ? "" : String(v).trim());
const key = (v) =>
  norm(v)
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

// N-11 — day credit for a stored status, the same mapping the correction path
// uses (creditFor). The upsert previously never wrote day_credit, so every
// imported row landed "held" (NULL) and the payroll absence bridge priced
// nothing for imported months — wrong by omission, forever. Rest-day statuses
// carry 0; the payroll bridge skips them by status (N-09).
export function creditForStatus(status) {
  if (status === "PRESENT" || status === "LATE") return 1;
  // T&A-RULE-06 — both early-checkout bands cost half a day.
  if (status === "HALF_DAY" || status === "EARLY_CHECKOUT") return 0.5;
  if (
    status === "ABSENT" ||
    status === "WEEKLY_OFF" ||
    status === "HOLIDAY" ||
    status === "ON_LEAVE"
  )
    return 0;
  return null; // MISSING_* and anything unresolved stays held
}

/** Accept the handful of date shapes six years of spreadsheets actually contain. */
export function parseDate(raw) {
  if (raw instanceof Date && !isNaN(raw)) {
    return new Date(
      Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()),
    );
  }
  const s = norm(raw);
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return mkUTC(+m[1], +m[2], +m[3]);
  // Day-first (dd/mm/yyyy) — the dominant convention in this fleet's region.
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return mkUTC(+m[3], +m[2], +m[1]);
  const d = new Date(s);
  if (!isNaN(d))
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
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
    return new Date(
      day.getTime() + raw.getUTCHours() * 3600000 + raw.getUTCMinutes() * 60000,
    );
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
  if (
    h > 23 ||
    min > 59 ||
    +(m[3] || 0) > 59 ||
    (ap && (+m[1] < 1 || +m[1] > 12))
  )
    return null;
  return new Date(
    day.getTime() + h * 3600000 + min * 60000 + +(m[3] || 0) * 1000,
  );
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
  else if (!employeeId)
    issues.push(`No employee with code "${code}" in this tenant`);

  const date = parseDate(raw.date);
  if (!norm(raw.date)) issues.push("date is required");
  else if (!date)
    issues.push(`Could not read the date "${norm(raw.date)}" — use YYYY-MM-DD`);

  // A file listing the same employee-day twice contradicts itself; the upsert
  // would silently keep whichever landed last.
  if (employeeId && date) {
    const k = `${employeeId}|${date.toISOString()}`;
    if (seen.has(k))
      issues.push(
        `Duplicate row: ${code} on ${date.toISOString().slice(0, 10)} appears earlier in this file`,
      );
    else seen.add(k);
  }

  let dayType = pickEnum(raw.day_type, DAY_TYPES, DAY_TYPE_SYNONYMS);
  if (!dayType) {
    if (norm(raw.day_type))
      issues.push(
        `day_type "${norm(raw.day_type)}" is not one of ${DAY_TYPES.join(", ")}`,
      );
    else {
      dayType = "WORKING";
      fixes.push("day_type defaulted to WORKING");
    }
  }

  const leaveType = pickEnum(raw.leave_type, LEAVE_TYPES, LEAVE_SYNONYMS);
  if (norm(raw.leave_type) && !leaveType) {
    issues.push(
      `leave_type "${norm(raw.leave_type)}" is not one of ${LEAVE_TYPES.join(", ")}`,
    );
  }
  if (dayType === "LEAVE" && !leaveType)
    issues.push("day_type is LEAVE but leave_type is empty");
  if (dayType !== "LEAVE" && leaveType) {
    dayType = "LEAVE";
    fixes.push("day_type set to LEAVE because leave_type was filled");
  }

  const checkIn = parseTime(raw.check_in, date);
  let checkOut = parseTime(raw.check_out, date);
  if (norm(raw.check_in) && !checkIn)
    issues.push(`Could not read check_in "${norm(raw.check_in)}" — use HH:MM`);
  if (norm(raw.check_out) && !checkOut)
    issues.push(
      `Could not read check_out "${norm(raw.check_out)}" — use HH:MM`,
    );
  if (checkIn && checkOut && checkOut <= checkIn) {
    checkOut = new Date(checkOut.getTime() + 86400000);
    // Night shifts are real; assume the checkout rolled past midnight rather
    // than rejecting the row.
    fixes.push(
      "check_out is before check_in — treated as an overnight shift (+1 day)",
    );
  }

  let status = pickEnum(raw.status, STATUS, null);
  if (norm(raw.status) && !status)
    issues.push(
      `status "${norm(raw.status)}" is not one of ${STATUS.join(", ")}`,
    );
  if (!status) {
    // N-12 — the stored status must CARRY the day type. Forcing 'ABSENT' here
    // (and dropping day_type in the upsert) made an imported Sunday
    // indistinguishable from a real absence — the exact confusion the column
    // exists to prevent. Rest/leave days are restated exactly like the device
    // writer does: WEEKLY_OFF / HOLIDAY / ON_LEAVE.
    if (dayType === "WEEKLY_OFF") status = "WEEKLY_OFF";
    else if (dayType === "HOLIDAY") status = "HOLIDAY";
    else if (dayType === "LEAVE") status = "ON_LEAVE";
    else status = checkIn ? "PRESENT" : "ABSENT";
    fixes.push(`status derived as ${status}`);
  }

  let workMode = pickEnum(raw.work_mode, WORK_MODES, WORK_MODE_SYNONYMS);
  if (norm(raw.work_mode) && !workMode)
    issues.push(
      `work_mode "${norm(raw.work_mode)}" is not one of ${WORK_MODES.join(", ")}`,
    );
  if (!workMode && dayType === "WORKING" && status !== "ABSENT") {
    workMode = "Onsite";
    fixes.push("work_mode defaulted to Onsite");
  }

  const anomalyType = pickEnum(raw.anomaly_type, ANOMALY_TYPES, null);
  if (norm(raw.anomaly_type) && !anomalyType) {
    issues.push(
      `anomaly_type "${norm(raw.anomaly_type)}" is not one of ${ANOMALY_TYPES.join(", ")}`,
    );
  }
  let resolution = pickEnum(raw.anomaly_resolution, RESOLUTIONS, null);
  if (norm(raw.anomaly_resolution) && !resolution) {
    issues.push(
      `anomaly_resolution "${norm(raw.anomaly_resolution)}" must be APPROVED or REJECTED`,
    );
  }
  if (anomalyType && !resolution) {
    // Historical anomalies are already settled. Importing them PENDING would
    // dump years of closed items into the live HR review queue.
    issues.push(
      "Historical anomaly requires an explicit APPROVED or REJECTED decision",
    );
  }

  let totalHours = null;
  if (checkIn && checkOut) {
    const end =
      checkOut <= checkIn ? new Date(checkOut.getTime() + 86400000) : checkOut;
    totalHours =
      Math.round(((end - checkIn) / 3600000 + Number.EPSILON) * 100) / 100;
  }

  return {
    ok: issues.length === 0,
    issues,
    fixes,
    value: issues.length
      ? null
      : {
          employeeId,
          date,
          dayType,
          status,
          checkIn,
          checkOut,
          totalHours,
          workMode,
          leaveType,
          anomalyType,
          resolution,
          remarks: norm(raw.remarks) || null,
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
      const contiguous =
        run &&
        run.type === r.leaveType &&
        r.date.getTime() - run.end_date.getTime() === 86400000;
      if (contiguous) {
        run.end_date = r.date;
        run.total_days += 1;
      } else {
        if (run) out.push(run);
        run = {
          employeeId,
          type: r.leaveType,
          start_date: r.date,
          end_date: r.date,
          total_days: 1,
        };
      }
    }
    if (run) out.push(run);
  }
  return out;
}

async function loadEmployeeLookup(tenantId, db = prisma) {
  // Employee carries the legacy snake_case tenant column (REQ-007) unlike the
  // C.2 camelCase tables — scopedWhere() stamps `tenantId`, which the Employee
  // model does not have, so the lookup would throw Prisma P1552 every time.
  const employees = await db.employee.findMany({
    where: { tenant_id: tenantId },
    select: { id: true, employee_code: true },
  });
  const byCode = new Map();
  for (const e of employees) {
    if (e.employee_code)
      byCode.set(String(e.employee_code).toLowerCase(), e.id);
  }
  return { byCode, count: employees.length };
}

function readCsv(text) {
  const records = [];
  let row = [],
    cell = "",
    quoted = false,
    closed = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const pushRow = () => {
    pushCell();
    if (row.some((v) => v.trim())) records.push(row);
    row = [];
  };
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === ",") pushCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed || c === '"') throw captureError("Malformed CSV quoting");
    else cell += c;
  }
  if (quoted) throw captureError("CSV contains an unclosed quoted cell");
  if (cell || row.length) pushRow();
  if (!records.length) return [];
  const headers = records.shift().map((h) => key(h).replace(/ /g, "_"));
  if (new Set(headers).size !== headers.length)
    throw captureError("CSV contains duplicate column names");
  return records.map((cells) => {
    if (cells.length > headers.length)
      throw captureError("CSV row has more cells than its header");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet("Attendance") || wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = key(cell.value).replace(/ /g, "_");
  });
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
        type: "list",
        allowBlank: true,
        formulae: [`"${values.join(",")}"`],
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
    [
      "E-1042",
      "2021-03-01",
      "WORKING",
      "PRESENT",
      "09:02",
      "18:05",
      "Onsite",
      "",
      "",
      "",
      "",
    ],
    [
      "E-1042",
      "2021-03-02",
      "WORKING",
      "LATE",
      "10:47",
      "18:30",
      "Onsite",
      "",
      "LATE_CHECKIN",
      "APPROVED",
      "Traffic",
    ],
    [
      "E-1042",
      "2021-03-03",
      "WORKING",
      "PRESENT",
      "09:00",
      "",
      "Remote",
      "",
      "MISSING_CHECKOUT",
      "APPROVED",
      "Forgot to punch out",
    ],
    [
      "E-1042",
      "2021-03-04",
      "LEAVE",
      "ABSENT",
      "",
      "",
      "",
      "ANNUAL",
      "",
      "",
      "Annual leave 4-8 Mar",
    ],
    ["E-1042", "2021-03-06", "WEEKLY_OFF", "", "", "", "", "", "", "", ""],
  ].forEach((r) => ex.addRow(r));

  const info = wb.addWorksheet("Instructions");
  info.columns = [{ width: 24 }, { width: 96 }];
  info.addRow(["Grain", "ONE ROW PER EMPLOYEE PER DAY."]);
  info.addRow([
    "employee_code",
    "Must match an employee in this tenant — the same code the employee importer upserts on.",
  ]);
  info.addRow([
    "date",
    "YYYY-MM-DD preferred. dd/mm/yyyy is accepted and read day-first.",
  ]);
  info.addRow([
    "day_type",
    `${DAY_TYPES.join(" | ")}. Without it an absence cannot be told apart from a Sunday, and every attendance-rate metric is wrong.`,
  ]);
  info.addRow([
    "status",
    `${STATUS.join(" | ")}. Left blank it is derived from the punches and day_type.`,
  ]);
  info.addRow([
    "check_in / check_out",
    "HH:MM local. Blank means the punch is MISSING — that is meaningful, not zero.",
  ]);
  info.addRow(["work_mode", WORK_MODES.join(" | ")]);
  info.addRow([
    "leave_type",
    `${LEAVE_TYPES.join(" | ")}. Consecutive same-type days merge into ONE leave request.`,
  ]);
  info.addRow(["anomaly_type", ANOMALY_TYPES.join(" | ")]);
  info.addRow([
    "anomaly_resolution",
    "APPROVED | REJECTED required when an anomaly is supplied. Commit requires an approval reference.",
  ]);
  info.addRow([
    "Weekends & holidays",
    "Optional. Omit them and the day is simply absent from the ledger; include them as WEEKLY_OFF / HOLIDAY for a complete calendar.",
  ]);
  info.addRow([
    "Re-running",
    "Resume with the saved batch ID and preview token. Changed rows require a new preview; corrected rows require explicit replacement permission.",
  ]);
  info.addRow([
    "Large files",
    "At most ~5000 rows per call. Chunks are independent — no batch id, no ordering requirement.",
  ]);
  info.getColumn(1).font = { bold: true };
  info.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const buf = await wb.xlsx.writeBuffer();
  return {
    fileName: "HR_Attendance_Import_Template.xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
    ...[
      "previous_status",
      "previous_check_in",
      "previous_check_out",
      "proposed_status",
      "proposed_check_in",
      "proposed_check_out",
    ].map((key) => ({ header: key, key, width: 27 })),
    ...COLUMNS.map((c) => ({ header: c, key: c, width: c.length + 8 })),
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of results) {
    const row = ws.addRow({
      __row: r.rowNumber,
      __row_status: r.status,
      __issues: (r.issues.length ? r.issues : r.fixes).join("; "),
      ...r.raw,
      previous_status: r.before?.status || "",
      previous_check_in: r.before?.check_in ? String(r.before.check_in) : "",
      previous_check_out: r.before?.check_out ? String(r.before.check_out) : "",
      proposed_status: r.after?.status || "",
      proposed_check_in: r.after?.checkIn ? String(r.after.checkIn) : "",
      proposed_check_out: r.after?.checkOut ? String(r.after.checkOut) : "",
    });
    const colour =
      r.status === "ERROR"
        ? "FFF8D7DA"
        : r.status === "FIXED"
          ? "FFFFF3CD"
          : "FFD4EDDA";
    row.getCell(2).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: colour },
    };
    if (r.status === "ERROR")
      row.getCell(3).font = { color: { argb: "FF9C1C24" } };
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
export async function runAttendanceImport(
  {
    tenantId,
    actorId,
    fileBase64,
    format = "xlsx",
    dryRun = true,
    importLeaves = true,
    importAnomalies = true,
    replaceCorrected = false,
    approvalReference,
    batchId,
    previewToken,
    reason,
    mayReplaceCorrected = false,
  } = {},
  db = prisma,
) {
  if (!tenantId || !actorId)
    throw captureError("Verified tenant and operator are required", 403);
  if (!dryRun)
    return commitAttendanceImport(
      { tenantId, actorId, batchId, previewToken, reason, mayReplaceCorrected },
      db,
    );
  if (!fileBase64 || fileBase64.length > 16000000)
    throw captureError("Upload a file of at most 12 MB");
  const buffer = Buffer.from(fileBase64, "base64");
  const raws =
    format === "csv"
      ? readCsv(buffer.toString("utf8"))
      : await readXlsx(buffer);
  if (!raws.length || raws.length > 20000)
    throw captureError("The file must contain 1–20000 rows");
  const lookup = await loadEmployeeLookup(tenantId, db);
  const seen = new Set(),
    results = [],
    good = [];
  for (const [i, raw] of raws.entries()) {
    const v = validateRow(raw, lookup, seen);
    if (
      v.ok &&
      ((importLeaves && v.value.leaveType) ||
        (importAnomalies && v.value.anomalyType)) &&
      !approvalReference?.trim()
    ) {
      v.ok = false;
      v.issues.push(
        "An approval reference is required to import historical leave or anomaly decisions",
      );
    }
    results.push({
      rowNumber: i + 2,
      raw,
      status: !v.ok ? "ERROR" : v.fixes.length ? "FIXED" : "OK",
      issues: v.issues,
      fixes: v.fixes,
    });
    if (v.ok) good.push({ ...v.value, rowNumber: i + 2 });
  }
  // Snapshot existing versions so an intervening correction invalidates the
  // preview instead of being overwritten by a previously reviewed file.
  const before = good.length
    ? await db.attendance.findMany({
        where: {
          tenantId,
          employeeId: { in: [...new Set(good.map((r) => r.employeeId))] },
          date: {
            in: [...new Set(good.map((r) => r.date.toISOString()))].map(
              (d) => new Date(d),
            ),
          },
        },
        select: {
          id: true,
          employeeId: true,
          date: true,
          updated_at: true,
          manually_corrected: true,
          status: true,
          check_in: true,
          check_out: true,
        },
      })
    : [];
  const byKey = new Map(
    before.map((r) => [`${r.employeeId}:${r.date.toISOString()}`, r]),
  );
  for (const r of good) {
    const previous = byKey.get(`${r.employeeId}:${r.date.toISOString()}`);
    r.expected = previous
      ? { id: previous.id, updatedAt: previous.updated_at.toISOString() }
      : null;
    const report = results.find((x) => x.rowNumber === r.rowNumber);
    report.before = previous || null;
    report.after = r;
    if (previous?.manually_corrected && !replaceCorrected) {
      report.status = "ERROR";
      report.issues.push(
        "Protected manual correction; select explicit replacement and preview again",
      );
    }
  }
  const rows = good.filter(
    (r) => results.find((x) => x.rowNumber === r.rowNumber).status !== "ERROR",
  );
  const options = {
    importLeaves,
    importAnomalies,
    replaceCorrected,
    approvalReference: approvalReference || null,
  };
  const token = fingerprint({ rows, options });
  const summary = {
    totalRows: raws.length,
    ok: results.filter((r) => r.status === "OK").length,
    autoFixed: results.filter((r) => r.status === "FIXED").length,
    errors: results.filter((r) => r.status === "ERROR").length,
    attendanceWritten: 0,
    leavesWritten: 0,
    anomaliesWritten: 0,
  };
  const batch = await db.attendanceImportBatch.create({
    data: {
      tenantId,
      actorId: String(actorId),
      fileHash: createHash("sha256").update(buffer).digest("hex"),
      previewToken: token,
      options,
      rows: jsonValue(rows),
      results: jsonValue(results),
      summary,
    },
  });
  return {
    batchId: batch.id,
    previewToken: token,
    summary,
    results: results.slice(0, 200),
    truncated: results.length > 200,
    cursor: 0,
    done: false,
    fileName: "attendance-import-preview.xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    reportBase64: await buildReport(results),
  };
}

export async function commitAttendanceImport(
  {
    tenantId,
    actorId,
    batchId,
    previewToken,
    reason,
    mayReplaceCorrected = false,
  },
  db = prisma,
) {
  if (!batchId || !previewToken || !reason?.trim())
    throw captureError(
      "A reviewed batch, preview token and reason are required",
    );
  return tenantTransaction(
    db,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attendance-import:${tenantId}:${batchId}`}))`;
      const batch = await tx.attendanceImportBatch.findFirst({
        where: { id: batchId, tenantId },
      });
      if (
        !batch ||
        batch.previewToken !== previewToken ||
        batch.actorId !== String(actorId)
      )
        throw captureError(
          "Preview is missing, changed or belongs to another operator",
          409,
        );
      if (batch.options.replaceCorrected && !mayReplaceCorrected)
        throw captureError(
          "Attendance edit permission is required to replace corrections",
          403,
        );
      if (batch.state === "COMPLETED")
        return {
          batchId,
          summary: batch.summary,
          cursor: batch.cursor,
          done: true,
        };
      if (!batch.options.approvalReference?.trim())
        throw captureError(
          "Historical import requires an approval reference",
          409,
        );
      if (batch.summary.errors)
        throw captureError(
          "Correct all preview errors and upload again before committing",
          409,
        );
      const slice = batch.rows.slice(batch.cursor, batch.cursor + 100);
      const days = [...new Set(slice.map((r) => r.date.slice(0, 10)))];
      await assertCapturePeriodOpen(tx, tenantId, days);
      const summary = { ...batch.summary };
      for (const r of slice) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attendance:${tenantId}:${r.employeeId}`}))`;
        const employee = await tx.employee.findFirst({
          where: { id: r.employeeId, tenant_id: tenantId },
        });
        if (!employee)
          throw captureError(
            `Employee on row ${r.rowNumber} is no longer available`,
            409,
          );
        const date = new Date(r.date);
        const existing = await tx.attendance.findFirst({
          where: { tenantId, employeeId: r.employeeId, date },
        });
        if (
          existing
            ? !r.expected ||
              existing.id !== r.expected.id ||
              existing.updated_at.toISOString() !== r.expected.updatedAt
            : !!r.expected
        )
          throw captureError(
            `Row ${r.rowNumber} changed after preview; upload again to review`,
            409,
          );
        if (existing?.manually_corrected && !batch.options.replaceCorrected)
          throw captureError("Manual correction is protected", 409);
        const data = {
          check_in: r.checkIn ? new Date(r.checkIn) : null,
          check_out: r.checkOut ? new Date(r.checkOut) : null,
          total_hours: r.totalHours,
          status: r.status,
          work_mode: r.workMode,
          remarks: r.remarks,
          day_credit: creditForStatus(r.status),
          processingState: creditForStatus(r.status)==null?'NEEDS_REVIEW':'FINALIZED',
          finalizedAt: creditForStatus(r.status)==null?null:new Date(),
          nextEvaluationAt:null,
          manually_corrected: true,
          corrected_at: new Date(),
          correction_reason: reason,
          setupVersion: null,
          requires_regularization: creditForStatus(r.status) == null,
          setupSnapshot: {
            source: "HISTORICAL_IMPORT",
            batchId,
            rowNumber: r.rowNumber,
            approvalReference: batch.options.approvalReference,
          },
        };
        let saved;
        if (existing) {
          const changed = await tx.attendance.updateMany({
            where: {
              id: existing.id,
              tenantId,
              updated_at: existing.updated_at,
            },
            data,
          });
          if (changed.count !== 1)
            throw captureError(
              `Row ${r.rowNumber} changed during commit; preview again`,
              409,
            );
          saved = { ...existing, ...data };
        } else
          saved = await tx.attendance.create({
            data: { tenantId, employeeId: r.employeeId, date, ...data },
          });
        summary.attendanceWritten++;
        // One leave day per imported row avoids chunk-boundary dependent ranges.
        if (batch.options.importLeaves && r.leaveType) {
          const overlap = await tx.leave.findFirst({
            where: {
              tenantId,
              employeeId: r.employeeId,
              start_date: { lte: date },
              end_date: { gte: date },
            },
          });
          if (
            overlap &&
            (overlap.type !== r.leaveType || overlap.status !== "APPROVED")
          )
            throw captureError(`Conflicting leave on row ${r.rowNumber}`, 409);
          if (!overlap) {
            await tx.leave.create({
              data: {
                tenantId,
                employeeId: r.employeeId,
                type: r.leaveType,
                start_date: date,
                end_date: date,
                total_days: 1,
                status: "APPROVED",
                reason: `Historical import ${batchId}: ${batch.options.approvalReference}`,
              },
            });
            summary.leavesWritten++;
          }
        }
        if (batch.options.importAnomalies && r.anomalyType) {
          const exists = await tx.attendanceAnomaly.findFirst({
            where: {
              tenantId,
              employeeId: r.employeeId,
              date,
              type: r.anomalyType,
            },
          });
          if (exists && exists.status !== r.resolution)
            throw captureError(
              `Conflicting anomaly decision on row ${r.rowNumber}`,
              409,
            );
          if (!exists) {
            await tx.attendanceAnomaly.create({
              data: {
                tenantId,
                employeeId: r.employeeId,
                date,
                type: r.anomalyType,
                status: r.resolution,
                reason: r.remarks,
                reviewNote: `Historical approval: ${batch.options.approvalReference}`,
                decidedAt: new Date(),
                sourceKind: "HISTORICAL_IMPORT",
                sourceRef: `${batchId}:${r.rowNumber}`,
              },
            });
            summary.anomaliesWritten++;
          }
        }
        await captureAudit(tx, {
          tenantId,
          actorId,
          action: "HISTORICAL_IMPORT_ROW",
          reason,
          detail: {
            batchId,
            rowNumber: r.rowNumber,
            before: existing,
            after: saved,
            approvalReference: batch.options.approvalReference,
          },
        });
      }
      const cursor = batch.cursor + slice.length,
        done = cursor >= batch.rows.length;
      await tx.attendanceImportBatch.update({
        where: { id: batchId, tenantId },
        data: {
          cursor,
          state: done ? "COMPLETED" : "COMMITTING",
          summary,
          reason,
        },
      });
      return { batchId, summary, cursor, done };
    },
    { tenantId, txOptions: { timeout: 60000 } },
  );
}
export async function getAttendanceImport({ tenantId, batchId }, db = prisma) {
  const batch = await db.attendanceImportBatch.findFirst({
    where: { tenantId, id: batchId },
  });
  if (!batch) throw captureError("Import batch not found", 404);
  return {
    batchId: batch.id,
    previewToken: batch.previewToken,
    summary: batch.summary,
    cursor: batch.cursor,
    done: batch.state === "COMPLETED",
    state: batch.state,
    fileName: "attendance-import-results.xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    reportBase64: await buildReport(batch.results),
  };
}
