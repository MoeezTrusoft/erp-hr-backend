// src/lib/employeeImportTaxonomy.js
//
// Single source of truth for the bulk EMPLOYEE IMPORT: the column contract
// (also used to render the downloadable template), the enum synonym maps, and
// the value normalizers/validators used by the validate→auto-fix→annotate
// engine (employeeImport.service.js). Pure, dependency-free.

// ── Column contract ──────────────────────────────────────────────────────────
// key      sheet header (snake_case) the user fills
// required hard-required (row errors if blank)
// kind     req | key | opt  (drives template header colour)
// enum     canonical dropdown values (see ENUM_SYNONYMS for the fix map)
// create   the hr_employee_create arg this column maps to (camelCase)
// note     header comment shown in the template
export const IMPORT_COLUMNS = [
  { key: "first_name", kind: "req", required: true, create: "firstName", note: "REQUIRED. Given name. Auto-fixed: trimmed + Title-Cased." },
  { key: "last_name", kind: "req", required: true, create: "lastName", note: "REQUIRED. Family name. Auto-fixed: trimmed + Title-Cased." },
  { key: "middle_name", kind: "opt", create: "middleName", note: "Optional." },
  { key: "preferred_name", kind: "opt", create: "preferredName", note: "Optional. Display / nickname." },
  { key: "employee_code", kind: "key", create: "employeeCode", note: "BIOMETRIC KEY. Must equal the user-ID enrolled on the ZKTeco device so punches auto-map to this employee. Must be UNIQUE. Blank → auto-generated (biometric won't map until reconciled)." },
  { key: "gender", kind: "opt", enum: ["Male", "Female", "Other"], create: "gender", note: "Dropdown. Synonyms auto-fixed (M/F → Male/Female)." },
  { key: "date_of_birth", kind: "opt", date: true, create: "dateOfBirth", note: "Date. YYYY-MM-DD preferred; other formats auto-parsed." },
  { key: "marital_status", kind: "opt", enum: ["Single", "Married", "Divorced", "Widowed"], create: "maritalStatus", note: "Dropdown." },
  { key: "nationality", kind: "opt", create: "nationality", note: "e.g. Pakistani." },
  { key: "national_id_type", kind: "opt", enum: ["CNIC", "Passport", "Driving License", "Other"], create: "nationalIdType", note: "Dropdown." },
  { key: "national_id_number", kind: "opt", create: "nationalIdNumber", note: "e.g. CNIC 35202-1234567-8." },
  { key: "personal_email", kind: "opt", email: true, create: "personalEmail", note: "Validated + lower-cased." },
  { key: "work_email", kind: "opt", email: true, unique: true, create: "workEmail", note: "Validated + lower-cased. Must be unique." },
  { key: "mobile_phone", kind: "opt", phone: true, create: "mobilePhone", note: "Auto-fixed: spaces/dashes stripped." },
  { key: "work_phone", kind: "opt", phone: true, create: "workPhone", note: "Optional." },
  { key: "current_address", kind: "opt", create: "residentialAddress", note: "Optional." },
  { key: "city", kind: "opt", create: "city", note: "Optional." },
  { key: "state_province", kind: "opt", create: "stateProvince", note: "Optional." },
  { key: "country", kind: "opt", create: "country", note: "Optional. Defaults to Pakistan if blank." },
  { key: "postal_code", kind: "opt", create: "postalCode", note: "Optional." },
  { key: "job_title", kind: "opt", create: "jobTitle", note: "Free text, e.g. Software Engineer." },
  { key: "department", kind: "opt", lookup: "department", create: "departmentId", note: "Match by NAME to an RBAC department. Unknown = flagged with nearest suggestion." },
  { key: "position", kind: "opt", lookup: "position", create: "positionId", note: "Match by NAME to a position. Unknown = flagged." },
  { key: "manager", kind: "opt", lookup: "manager", create: "managerId", note: "Direct supervisor — match by employee_code OR full name. Unknown = flagged." },
  { key: "employment_type", kind: "opt", enum: ["Full-time", "Part-time", "Contract", "Intern", "Temporary"], create: "employmentType", note: "Dropdown. Synonyms auto-fixed (FT/Permanent → Full-time)." },
  { key: "employment_status", kind: "opt", enum: ["Active", "Inactive", "On Leave", "Terminated"], create: "employmentStatus", note: "Dropdown. Blank defaults to Active." },
  { key: "hire_date", kind: "opt", date: true, create: "hireDate", note: "Date. YYYY-MM-DD preferred." },
  { key: "joining_date", kind: "opt", date: true, create: "joiningDate", note: "Date. YYYY-MM-DD preferred." },
  { key: "probation_end_date", kind: "opt", date: true, create: "probationEndDate", note: "Date. YYYY-MM-DD preferred." },
  { key: "work_mode", kind: "opt", enum: ["On-site", "Remote", "Hybrid"], direct: "work_mode", note: "Dropdown. Synonyms auto-fixed (WFH → Remote). Set directly on the employee post-create (not part of the create contract)." },
  { key: "fte", kind: "opt", create: "fte", note: "Number 0.0–1.0. Blank defaults to 1. Out-of-range clamped." },
  { key: "create_login", kind: "opt", enum: ["yes", "no"], create: "createSystemAccount", note: "Dropdown. 'yes' provisions an RBAC login." },
  { key: "login_email", kind: "opt", email: true, create: "systemEmail", note: "Login email (create_login=yes). Blank → work_email then personal_email." },
  { key: "role", kind: "opt", lookup: "role", create: "roleId", note: "RBAC role NAME — REQUIRED when create_login=yes. Match by name." },
  { key: "password", kind: "opt", create: "password", note: "Optional. Blank = one-time password auto-generated and returned." },
];

export const IMPORT_HEADERS = IMPORT_COLUMNS.map((c) => c.key);
export const COLUMN_BY_KEY = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c.key, c]));

// ── Enum synonym maps (lowercased key → canonical) ───────────────────────────
const syn = (canon, alts) => Object.fromEntries(alts.map((a) => [a.toLowerCase(), canon]));
export const ENUM_SYNONYMS = {
  gender: {
    ...syn("Male", ["male", "m", "man", "boy"]),
    ...syn("Female", ["female", "f", "woman", "girl"]),
    ...syn("Other", ["other", "o", "non-binary", "nonbinary", "nb", "prefer not to say", "n/a"]),
  },
  marital_status: {
    ...syn("Single", ["single", "unmarried", "s"]),
    ...syn("Married", ["married", "m"]),
    ...syn("Divorced", ["divorced", "div"]),
    ...syn("Widowed", ["widowed", "widow", "widower"]),
  },
  national_id_type: {
    ...syn("CNIC", ["cnic", "nic", "national id", "national id card", "id card", "nic card"]),
    ...syn("Passport", ["passport", "ppt", "pp"]),
    ...syn("Driving License", ["driving license", "driving licence", "dl", "license", "licence"]),
    ...syn("Other", ["other", "o"]),
  },
  employment_type: {
    ...syn("Full-time", ["full-time", "full time", "fulltime", "ft", "permanent", "perm", "regular"]),
    ...syn("Part-time", ["part-time", "part time", "parttime", "pt"]),
    ...syn("Contract", ["contract", "contractor", "contractual", "consultant"]),
    ...syn("Intern", ["intern", "internship", "trainee", "apprentice"]),
    ...syn("Temporary", ["temporary", "temp", "casual", "seasonal"]),
  },
  employment_status: {
    ...syn("Active", ["active", "employed", "working", "current", "a"]),
    ...syn("Inactive", ["inactive", "disabled", "suspended"]),
    ...syn("On Leave", ["on leave", "on-leave", "onleave", "leave"]),
    ...syn("Terminated", ["terminated", "resigned", "left", "exited", "separated", "ex-employee", "former"]),
  },
  work_mode: {
    ...syn("On-site", ["on-site", "onsite", "on site", "office", "in-office", "in office"]),
    ...syn("Remote", ["remote", "wfh", "work from home", "home", "telework"]),
    ...syn("Hybrid", ["hybrid", "flexible", "mixed", "flex"]),
  },
  create_login: {
    ...syn("yes", ["yes", "y", "true", "1", "t"]),
    ...syn("no", ["no", "n", "false", "0", "f", ""]),
  },
};

// ── Value helpers ────────────────────────────────────────────────────────────
const BLANKISH = new Set(["", "-", "--", "n/a", "na", "null", "none", "nil", "."]);

export function cleanCell(v) {
  if (v == null) return "";
  // exceljs rich text / hyperlink / formula-result objects
  if (typeof v === "object") {
    if (v.text != null) v = v.text;
    else if (v.result != null) v = v.result;
    else if (v.richText) v = v.richText.map((t) => t.text).join("");
    else if (v.hyperlink != null) v = v.text ?? v.hyperlink;
    else if (v instanceof Date) return v;
    else v = String(v);
  }
  if (v instanceof Date) return v;
  const s = String(v).replace(/\s+/g, " ").trim();
  return BLANKISH.has(s.toLowerCase()) ? "" : s;
}

export const isBlank = (v) => cleanCell(v) === "";

export function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bMc([a-z])/g, (_m, c) => "Mc" + c.toUpperCase());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(v) {
  const s = cleanCell(v);
  if (!s) return { value: "", valid: true, fixed: false };
  const low = s.toLowerCase();
  return { value: low, valid: EMAIL_RE.test(low), fixed: low !== s };
}

export function normalizePhone(v) {
  const s = cleanCell(v);
  if (!s) return { value: "", valid: true, fixed: false };
  // keep a single leading +, strip spaces/dashes/parens/dots
  const cleaned = s.replace(/(?!^\+)[^\d]/g, "").replace(/^(?!\+)/, (m) => m);
  const digits = cleaned.replace(/\D/g, "");
  return { value: cleaned, valid: digits.length >= 7 && digits.length <= 15, fixed: cleaned !== s };
}

// Enum normalize → { value, matched, fixed }
export function normalizeEnum(colKey, raw) {
  const s = cleanCell(raw);
  if (!s) return { value: "", matched: true, fixed: false };
  const col = COLUMN_BY_KEY[colKey];
  const canon = col?.enum || [];
  // already canonical (case-sensitive) ?
  if (canon.includes(s)) return { value: s, matched: true, fixed: false };
  // canonical case-insensitive ?
  const ci = canon.find((c) => c.toLowerCase() === s.toLowerCase());
  if (ci) return { value: ci, matched: true, fixed: ci !== s };
  // synonym ?
  const hit = ENUM_SYNONYMS[colKey]?.[s.toLowerCase()];
  if (hit) return { value: hit, matched: true, fixed: true };
  // nearest canonical as a suggestion
  return { value: s, matched: false, fixed: false, suggestion: nearest(s, canon) };
}

// ── Date parsing (many formats → ISO YYYY-MM-DD) ─────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};
const yr = (y) => (y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y);

// dayFirst: interpret ambiguous DD/MM vs MM/DD as day-first (default true).
export function parseDate(raw, { dayFirst = true } = {}) {
  const c = cleanCell(raw);
  if (c === "") return { value: "", valid: true, fixed: false };
  if (c instanceof Date) return { value: isoOf(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate()), valid: true, fixed: true };

  // Excel serial number
  if (/^\d{2,6}(\.\d+)?$/.test(c) && !/[-/.]/.test(c)) {
    const n = Number(c);
    if (n > 59 && n < 60000) {
      const ms = Math.round((n - 25569) * 86400 * 1000); // 25569 = 1970-01-01 in Excel serial
      const d = new Date(ms);
      const iso = isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      if (iso) return { value: iso, valid: true, fixed: true };
    }
  }
  // ISO YYYY-MM-DD[ T...]
  let m = c.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) { const iso = isoOf(+m[1], +m[2], +m[3]); if (iso) return { value: iso, valid: true, fixed: iso !== c }; }
  // D-Mon-YY / DD Month YYYY
  m = c.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2,4})$/);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) { const iso = isoOf(yr(+m[3]), mo, +m[1]); if (iso) return { value: iso, valid: true, fixed: true }; } }
  // Month D, YYYY
  m = c.match(/^([A-Za-z]{3,9})[ ]+(\d{1,2}),?[ ]+(\d{2,4})$/);
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) { const iso = isoOf(yr(+m[3]), mo, +m[2]); if (iso) return { value: iso, valid: true, fixed: true }; } }
  // DD/MM/YYYY or MM/DD/YYYY (ambiguous)
  m = c.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2], y = yr(+m[3]);
    let dd, mm;
    if (a > 12 && b <= 12) { dd = a; mm = b; }
    else if (b > 12 && a <= 12) { dd = b; mm = a; }
    else { dd = dayFirst ? a : b; mm = dayFirst ? b : a; }
    const iso = isoOf(y, mm, dd);
    if (iso) return { value: iso, valid: true, fixed: true };
  }
  return { value: c, valid: false, fixed: false };
}

// ── Fuzzy nearest (for "did you mean X?") ────────────────────────────────────
function lev(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}
export function nearest(input, candidates) {
  if (!candidates?.length) return null;
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const name = typeof c === "string" ? c : c?.name;
    if (!name) continue;
    const d = lev(input, name);
    if (d < bestD) { bestD = d; best = name; }
  }
  // only suggest if reasonably close (within ~40% of length)
  const thresh = Math.max(2, Math.ceil(Math.max(input.length, (best || "").length) * 0.4));
  return best && bestD <= thresh ? best : null;
}

export function parseFte(raw) {
  const c = cleanCell(raw);
  if (c === "") return { value: 1, fixed: c !== "1" && c !== "" ? true : false, clamped: false };
  let n = Number(String(c).replace("%", ""));
  if (String(c).includes("%")) n = n / 100;
  if (!Number.isFinite(n)) return { value: null, valid: false };
  let clamped = false;
  if (n > 1 && n <= 100) { n = n / 100; clamped = true; } // "80" → 0.8
  if (n < 0) { n = 0; clamped = true; }
  if (n > 1) { n = 1; clamped = true; }
  return { value: Math.round(n * 100) / 100, valid: true, fixed: true, clamped };
}
